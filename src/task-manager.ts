import { randomUUID } from "node:crypto";

import {
  Codex,
  type SandboxMode,
  type ThreadEvent,
  type ThreadOptions,
} from "@openai/codex-sdk";

import type { BridgeConfig } from "./config.js";
import type { RepositoryService } from "./repository.js";
import { TaskStore, type TaskRecord } from "./store.js";

export interface CodexThreadLike {
  readonly id: string | null;
  runStreamed(
    input: string,
    options?: { signal?: AbortSignal },
  ): Promise<{ events: AsyncGenerator<ThreadEvent> }>;
}

export interface CodexLike {
  startThread(options?: ThreadOptions): CodexThreadLike;
  resumeThread(id: string, options?: ThreadOptions): CodexThreadLike;
}

export interface StartTaskInput {
  instruction: string;
  label?: string;
  sandbox?: "read-only" | "workspace-write";
  model?: string;
  networkAccess?: boolean;
  expectedArtifacts?: string[];
}

export interface TaskManagerOptions {
  executionMode?: "inline" | "coordinator" | "worker";
}

export class TaskManager {
  private readonly active = new Map<string, AbortController>();
  private readonly codex: CodexLike;
  private readonly executionMode: "inline" | "coordinator" | "worker";
  private readonly workerId = randomUUID();

  constructor(
    private readonly config: BridgeConfig,
    readonly store: TaskStore,
    private readonly repository: RepositoryService,
    codex?: CodexLike,
    options: TaskManagerOptions = {},
  ) {
    this.executionMode = options.executionMode ?? "inline";
    this.codex =
      codex ??
      new Codex({
        ...(config.codexPathOverride ? { codexPathOverride: config.codexPathOverride } : {}),
      });
  }

  async initialize(): Promise<void> {
    await this.store.initialize();
    await this.repository.assertGitRepository();
    const records = await this.store.list();
    for (const record of records) {
      if (
        record.state === "running" &&
        !this.active.has(record.id) &&
        !this.hasFreshWorkerLease(record)
      ) {
        let recovered = false;
        await this.store.update(record.id, (current) => {
          if (
            current.state !== "running" ||
            this.active.has(current.id) ||
            this.hasFreshWorkerLease(current)
          ) {
            return;
          }
          current.state = "interrupted";
          current.error = "The task worker heartbeat expired before the task reached a terminal state.";
          recovered = true;
        });
        if (recovered) {
          await this.store.appendEvent(record.id, "bridge.recovered_interrupted_task");
        }
      }
    }
  }

  private hasFreshWorkerLease(record: TaskRecord): boolean {
    if (record.workerPid) {
      try {
        process.kill(record.workerPid, 0);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
      }
    }
    const timestamp = record.workerHeartbeatAt ?? record.updatedAt;
    return Date.now() - Date.parse(timestamp) <= this.config.workerLeaseMs;
  }

  private threadOptions(record: Pick<TaskRecord, "sandbox" | "model" | "networkAccess">): ThreadOptions {
    return {
      workingDirectory: this.config.repoRoot,
      sandboxMode: record.sandbox as SandboxMode,
      approvalPolicy: "never",
      networkAccessEnabled: record.networkAccess,
      ...(record.model ? { model: record.model } : {}),
    };
  }

  async start(input: StartTaskInput): Promise<TaskRecord> {
    const instruction = input.instruction.trim();
    if (!instruction) throw new Error("instruction must not be empty.");
    const expectedArtifacts = input.expectedArtifacts ?? [];
    for (const artifact of expectedArtifacts) {
      // RepositoryService performs the authoritative containment check.
      await this.repository.artifacts([artifact]);
    }

    const snapshot = await this.repository.snapshot();
    const now = new Date().toISOString();
    const record: TaskRecord = {
      id: randomUUID(),
      ...(input.label ? { label: input.label } : {}),
      instruction,
      repoRoot: this.config.repoRoot,
      state: "queued",
      sandbox: input.sandbox ?? "workspace-write",
      ...(input.model ? { model: input.model } : {}),
      networkAccess: input.networkAccess ?? false,
      expectedArtifacts,
      baseline: {
        branch: snapshot.branch,
        commit: snapshot.commit,
        status: snapshot.status,
        capturedAt: snapshot.capturedAt,
      },
      abortRequested: false,
      pendingFollowups: [],
      createdAt: now,
      updatedAt: now,
      lastEventSeq: 0,
    };
    await this.store.create(record);
    await this.store.appendEvent(record.id, "task.created", {
      label: record.label,
      baseline: record.baseline,
      sandbox: record.sandbox,
      networkAccess: record.networkAccess,
    });

    if (this.executionMode !== "coordinator") {
      const thread = this.codex.startThread(this.threadOptions(record));
      void this.runLoop(record.id, thread, instruction);
    }
    return this.store.get(record.id);
  }

  async runQueued(taskId: string): Promise<boolean> {
    if (this.executionMode === "coordinator" || this.active.has(taskId)) return false;

    let claimed: TaskRecord | undefined;
    await this.store.update(taskId, (record) => {
      if (record.state !== "queued" || record.abortRequested) return;
      if (record.workerId && record.workerId !== this.workerId && this.hasFreshWorkerLease(record)) {
        return;
      }
      const now = new Date().toISOString();
      record.workerId = this.workerId;
      record.workerPid = process.pid;
      record.workerHeartbeatAt = now;
      record.state = "running";
      record.error = undefined;
      claimed = { ...record, pendingFollowups: [...record.pendingFollowups] };
    });
    if (!claimed) return false;

    try {
      const initialPrompt = claimed.startedAt ? undefined : claimed.instruction;
      const thread = claimed.threadId
        ? this.codex.resumeThread(claimed.threadId, this.threadOptions(claimed))
        : this.codex.startThread(this.threadOptions(claimed));
      void this.runLoop(taskId, thread, initialPrompt);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.store.update(taskId, (record) => {
        record.state = "failed";
        record.error = message;
        record.completedAt = new Date().toISOString();
        record.workerId = undefined;
        record.workerPid = undefined;
        record.workerHeartbeatAt = undefined;
      });
      await this.store.appendEvent(taskId, "task.failed", { message });
    }
    return true;
  }

  private async runLoop(
    taskId: string,
    thread: CodexThreadLike,
    initialPrompt?: string,
  ): Promise<void> {
    const controller = new AbortController();
    this.active.set(taskId, controller);
    let prompt: string | undefined = initialPrompt;
    let drained = false;
    let hasPendingAfterExit = false;
    const heartbeat = setInterval(() => {
      void this.store.update(taskId, (record) => {
        if (record.workerId && record.workerId !== this.workerId) return;
        record.workerId = this.workerId;
        record.workerPid = process.pid;
        record.workerHeartbeatAt = new Date().toISOString();
        if (record.abortRequested) controller.abort();
      }).catch(() => undefined);
    }, Math.max(100, Math.floor(this.config.workerLeaseMs / 3)));
    heartbeat.unref();
    try {
      await this.store.update(taskId, (record) => {
        if (record.abortRequested) throw new Error("Task aborted by user.");
        record.state = "running";
        record.error = undefined;
        record.startedAt ??= new Date().toISOString();
        record.workerId = this.workerId;
        record.workerPid = process.pid;
        record.workerHeartbeatAt = new Date().toISOString();
      });

      while (true) {
        if (!prompt) {
          await this.store.update(taskId, (record) => {
            if (record.abortRequested) throw new Error("Task aborted by user.");
            prompt = record.pendingFollowups.shift();
            if (prompt) {
              record.state = "running";
              record.completedAt = undefined;
              record.error = undefined;
            }
          });
          if (!prompt) {
            drained = true;
            break;
          }
        }

        const currentPrompt = prompt!;
        prompt = undefined;
        await this.store.appendEvent(taskId, "turn.prompt", { instruction: currentPrompt });
        const streamed = await thread.runStreamed(currentPrompt, { signal: controller.signal });
        for await (const event of streamed.events) {
          await this.captureCodexEvent(taskId, event);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const current = await this.store.get(taskId);
      const aborted = current.abortRequested || controller.signal.aborted;
      await this.store.update(taskId, (record) => {
        record.state = aborted ? "aborted" : "failed";
        record.error = message;
        record.completedAt = new Date().toISOString();
        hasPendingAfterExit = record.pendingFollowups.length > 0;
      });
      await this.store.appendEvent(taskId, aborted ? "task.aborted" : "task.failed", { message });
    } finally {
      clearInterval(heartbeat);
      if (this.active.get(taskId) === controller) this.active.delete(taskId);
      if (!controller.signal.aborted && drained) {
        await this.store.appendEvent(taskId, "task.completed");
      }
      await this.store.update(taskId, (record) => {
        if (record.workerId !== this.workerId) return;
        if (!controller.signal.aborted && drained) {
          record.state = "completed";
          record.completedAt = new Date().toISOString();
        }
        hasPendingAfterExit ||= record.pendingFollowups.length > 0;
        record.workerId = undefined;
        record.workerPid = undefined;
        record.workerHeartbeatAt = undefined;
      });
      if (!controller.signal.aborted && hasPendingAfterExit) {
        await this.resumePendingFollowups(taskId);
      }
    }
  }

  private async resumePendingFollowups(taskId: string): Promise<void> {
    if (this.executionMode === "coordinator") return;
    if (this.active.has(taskId)) return;

    let shouldResume = false;
    let resumable: TaskRecord | undefined;
    await this.store.update(taskId, (record) => {
      if (
        this.active.has(taskId) ||
        record.abortRequested ||
        record.pendingFollowups.length === 0 ||
        record.state === "queued" ||
        record.state === "running"
      ) {
        return;
      }
      if (!record.threadId) return;
      record.state = "queued";
      record.completedAt = undefined;
      record.error = undefined;
      shouldResume = true;
      resumable = { ...record, pendingFollowups: [...record.pendingFollowups] };
    });

    if (!shouldResume || !resumable) return;
    try {
      const thread = this.codex.resumeThread(resumable.threadId!, this.threadOptions(resumable));
      void this.runLoop(taskId, thread);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.store.update(taskId, (record) => {
        record.state = "failed";
        record.error = message;
        record.completedAt = new Date().toISOString();
      });
      await this.store.appendEvent(taskId, "task.failed", { message });
    }
  }

  private async captureCodexEvent(taskId: string, event: ThreadEvent): Promise<void> {
    await this.store.appendEvent(taskId, `codex.${event.type}`, event);
    if (event.type === "thread.started") {
      await this.store.update(taskId, (record) => {
        record.threadId = event.thread_id;
      });
    }
    if (event.type === "item.completed" && event.item.type === "agent_message") {
      const finalResponse = event.item.text;
      await this.store.update(taskId, (record) => {
        record.finalResponse = finalResponse;
      });
    }
    if (event.type === "turn.failed") throw new Error(event.error.message);
    if (event.type === "error") throw new Error(event.message);
  }

  async followup(taskId: string, instruction: string): Promise<TaskRecord> {
    const prompt = instruction.trim();
    if (!prompt) throw new Error("instruction must not be empty.");
    const current = await this.store.get(taskId);
    if (current.state === "aborted") throw new Error("An aborted task cannot be resumed.");
    if (!current.threadId && !["queued", "running"].includes(current.state)) {
      throw new Error("The task has no Codex thread id and cannot be resumed.");
    }

    await this.store.update(taskId, (record) => {
      if (record.state === "aborted") throw new Error("An aborted task cannot be resumed.");
      record.pendingFollowups.push(prompt);
      if (
        this.executionMode === "coordinator" &&
        !this.active.has(taskId) &&
        !["queued", "running"].includes(record.state)
      ) {
        record.state = "queued";
        record.completedAt = undefined;
        record.error = undefined;
      }
    });
    await this.store.appendEvent(taskId, "followup.queued", { instruction: prompt });

    await this.resumePendingFollowups(taskId);
    return this.store.get(taskId);
  }

  async abort(taskId: string): Promise<TaskRecord> {
    const current = await this.store.get(taskId);
    if (!["queued", "running"].includes(current.state)) {
      throw new Error(`Task ${taskId} is already ${current.state}.`);
    }
    let abortedBeforeStart = false;
    await this.store.update(taskId, (record) => {
      if (!["queued", "running"].includes(record.state)) {
        throw new Error(`Task ${taskId} is already ${record.state}.`);
      }
      record.abortRequested = true;
      if (record.state === "queued") {
        record.state = "aborted";
        record.completedAt = new Date().toISOString();
        record.error = "Task aborted by user before the worker started it.";
        abortedBeforeStart = true;
      }
    });
    await this.store.appendEvent(taskId, "abort.requested");
    if (abortedBeforeStart) {
      await this.store.appendEvent(taskId, "task.aborted", {
        message: "Task aborted by user before the worker started it.",
      });
    }
    this.active.get(taskId)?.abort();
    return this.store.get(taskId);
  }
}
