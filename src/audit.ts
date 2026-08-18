import { appendFile, mkdir, readFile, rm, stat, truncate } from "node:fs/promises";
import path from "node:path";

import { atomicWriteFile, type AtomicWrite } from "./atomic-write.js";
import type { RepoSnapshot } from "./repository.js";

export type AuditActor = "CHATGPT" | "CODEX" | "BRIDGE";

export interface AuditEvent {
  seq: number;
  timestamp: string;
  task_id: string;
  actor: AuditActor;
  event_type: string;
  content: unknown;
  repo_commit: string;
  repo_dirty_state: string[];
  related_paths: string[];
}

export interface AppendAuditEventInput {
  actor: AuditActor;
  eventType: string;
  content: unknown;
  relatedPaths?: string[];
}

function renderContent(content: unknown): string {
  if (typeof content === "string") {
    const normalized = content.trim();
    return normalized
      ? normalized
          .split(/\r?\n/)
          .map((line) => `> ${line}`)
          .join("\n")
      : "_(empty)_";
  }
  return `\`\`\`json\n${JSON.stringify(content, null, 2)}\n\`\`\``;
}

function renderEntries(events: AuditEvent[], eventType: string): string {
  const matching = events.filter((event) => event.event_type === eventType);
  if (matching.length === 0) return "_(not recorded)_";
  return matching
    .map(
      (event) =>
        `${renderContent(event.content)}\n\n_Recorded ${event.timestamp} at ${event.repo_commit}._`,
    )
    .join("\n\n---\n\n");
}

export function renderAuditMarkdown(taskId: string, events: AuditEvent[]): string {
  const verificationTypes = new Set([
    "bridge.diff_inspection",
    "bridge.test_evidence",
    "chatgpt.semantic_review",
  ]);
  const verification = events.filter((event) => verificationTypes.has(event.event_type));
  const verificationText = verification.length
    ? verification
        .map((event) => `### ${event.event_type}\n\n${renderContent(event.content)}`)
        .join("\n\n")
    : "_(not recorded)_";

  const timeline = events
    .map(
      (event) =>
        `- ${event.seq}. \`${event.timestamp}\` **${event.actor}** — \`${event.event_type}\``,
    )
    .join("\n");

  return `# Bridge Audit — ${taskId}

## Task

${renderEntries(events, "chatgpt.task_instruction")}

## Codex initial interpretation

${renderEntries(events, "codex.response")}

## ChatGPT review

${renderEntries(events, "chatgpt.review")}

## Correction sent to Codex

${renderEntries(events, "chatgpt.correction")}

## Codex correction

${renderEntries(events, "codex.followup_response")}

## Final verification

${verificationText}

## Verdict

${renderEntries(events, "chatgpt.final_verdict")}

## Event timeline

${timeline || "_(no events)_"}
`;
}

export class AuditLog {
  readonly root: string;

  constructor(
    repoRoot: string,
    private readonly snapshot: () => Promise<RepoSnapshot>,
    private readonly atomicWrite: AtomicWrite = atomicWriteFile,
  ) {
    this.root = path.join(repoRoot, ".agents", "audit", "bridge");
  }

  private taskDirectory(taskId: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(taskId)) throw new Error("Invalid task id.");
    return path.join(this.root, taskId);
  }

  private eventsPath(taskId: string): string {
    return path.join(this.taskDirectory(taskId), "events.jsonl");
  }

  private markdownPath(taskId: string): string {
    return path.join(this.taskDirectory(taskId), "audit.md");
  }

  private lockPath(taskId: string): string {
    return path.join(this.root, `${taskId}.lock`);
  }

  private async acquire(taskId: string): Promise<() => Promise<void>> {
    await mkdir(this.root, { recursive: true });
    const lockPath = this.lockPath(taskId);
    const deadline = Date.now() + 5_000;
    while (true) {
      try {
        await mkdir(lockPath);
        return async () => rm(lockPath, { recursive: true, force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          const lockStat = await stat(lockPath);
          if (Date.now() - lockStat.mtimeMs > 30_000) {
            await rm(lockPath, { recursive: true, force: true });
            continue;
          }
        } catch (statError) {
          if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw statError;
        }
        if (Date.now() >= deadline) throw new Error(`Timed out acquiring audit lock: ${taskId}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  }

  private async readEventsUnlocked(taskId: string): Promise<AuditEvent[]> {
    try {
      const content = await readFile(this.eventsPath(taskId), "utf8");
      return content
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as AuditEvent);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async append(taskId: string, input: AppendAuditEventInput): Promise<AuditEvent> {
    const repository = await this.snapshot();
    const release = await this.acquire(taskId);
    try {
      const directory = this.taskDirectory(taskId);
      await mkdir(directory, { recursive: true });
      const events = await this.readEventsUnlocked(taskId);
      const event: AuditEvent = {
        seq: (events.at(-1)?.seq ?? 0) + 1,
        timestamp: new Date().toISOString(),
        task_id: taskId,
        actor: input.actor,
        event_type: input.eventType,
        content: input.content,
        repo_commit: repository.commit,
        repo_dirty_state: repository.status,
        related_paths: input.relatedPaths ?? [],
      };
      const eventsPath = this.eventsPath(taskId);
      let previousEventsSize = 0;
      try {
        previousEventsSize = (await stat(eventsPath)).size;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await appendFile(eventsPath, `${JSON.stringify(event)}\n`, "utf8");
      events.push(event);
      const markdown = renderAuditMarkdown(taskId, events);
      try {
        await this.atomicWrite(this.markdownPath(taskId), markdown);
      } catch (error) {
        try {
          await truncate(eventsPath, previousEventsSize);
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            `Failed to persist audit ${taskId} and roll back its appended event.`,
          );
        }
        throw error;
      }
      return event;
    } finally {
      await release();
    }
  }

  async events(taskId: string): Promise<AuditEvent[]> {
    const release = await this.acquire(taskId);
    try {
      return await this.readEventsUnlocked(taskId);
    } finally {
      await release();
    }
  }
}
