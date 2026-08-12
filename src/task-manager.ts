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

export class TaskManager {
  private readonly active = new Map<string, AbortController>();
  private readonly codex: CodexLike;

  constructor(
    private readonly config: BridgeConfig,
    readonly store: TaskStore,
    private readonly repository: RepositoryService,
    codex?: CodexLike,
  ) {
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
      if (record.state === "running" || record.state === "queued") {
        await this.store.update(record.id, (current) => {
          current.state = "interrupted";
          current.error = "The bridge process stopped before this task reached a terminal state.";
        });
        await this.store.appendEvent(record.id, "bridge.recovered_interrupted_task");
      }
    }
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

    const thread = this.codex.startThread(this.threadOptions(record));
    void this.runLoop(record.id, thread, instruction);
    return this.store.get(record.id);
  }

  private async runLoop(
    taskId: string,
    thread: CodexThreadLike,
    initialPrompt: string,
  ): Promise<void> {
    const controller = new AbortController();
    this.active.set(taskId, controller);
    let prompt: string | undefined = initialPrompt;
    try {
      await this.store.update(taskId, (record) => {
        record.state = "running";
        record.error = undefined;
        record.startedAt ??= new Date().toISOString();
      });

      while (prompt) {
        const currentPrompt = prompt;
        prompt = undefined;
        await this.store.appendEvent(taskId, "turn.prompt", { instruction: currentPrompt });
        const streamed = await thread.runStreamed(currentPrompt, { signal: controller.signal });
        for await (const event of streamed.events) {
          await this.captureCodexEvent(taskId, event);
        }

        let completed = false;
        await this.store.update(taskId, (record) => {
          if (record.abortRequested) throw new Error("Task aborted by user.");
          prompt = record.pendingFollowups.shift();
          if (!prompt) {
            record.state = "completed";
            record.completedAt = new Date().toISOString();
            completed = true;
          }
        });
        if (completed) {
          await this.store.appendEvent(taskId, "task.completed");
          return;
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
      });
      await this.store.appendEvent(taskId, aborted ? "task.aborted" : "task.failed", { message });
    } finally {
      this.active.delete(taskId);
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

    let shouldResume = false;
    await this.store.update(taskId, (record) => {
      record.pendingFollowups.push(prompt);
      shouldResume = !["queued", "running"].includes(record.state);
    });
    await this.store.appendEvent(taskId, "followup.queued", { instruction: prompt });

    if (shouldResume) {
      const resumable = await this.store.get(taskId);
      if (!resumable.threadId) throw new Error("The task has no Codex thread id and cannot be resumed.");
      let nextPrompt: string | undefined;
      await this.store.update(taskId, (record) => {
        nextPrompt = record.pendingFollowups.shift();
        record.state = "queued";
        record.completedAt = undefined;
        record.abortRequested = false;
      });
      const thread = this.codex.resumeThread(resumable.threadId, this.threadOptions(resumable));
      void this.runLoop(taskId, thread, nextPrompt!);
    }
    return this.store.get(taskId);
  }

  async abort(taskId: string): Promise<TaskRecord> {
    const current = await this.store.get(taskId);
    if (!["queued", "running"].includes(current.state)) {
      throw new Error(`Task ${taskId} is already ${current.state}.`);
    }
    await this.store.update(taskId, (record) => {
      record.abortRequested = true;
    });
    await this.store.appendEvent(taskId, "abort.requested");
    this.active.get(taskId)?.abort();
    return this.store.get(taskId);
  }
}
