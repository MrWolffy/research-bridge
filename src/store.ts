import { appendFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export type TaskState =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "aborted"
  | "interrupted";

export interface BaselineRef {
  branch: string;
  commit: string;
  status: string[];
  capturedAt: string;
}

export interface TaskRecord {
  id: string;
  label?: string;
  instruction: string;
  repoRoot: string;
  state: TaskState;
  sandbox: "read-only" | "workspace-write";
  model?: string;
  networkAccess: boolean;
  expectedArtifacts: string[];
  baseline: BaselineRef;
  threadId?: string;
  finalResponse?: string;
  error?: string;
  abortRequested: boolean;
  pendingFollowups: string[];
  workerId?: string;
  workerPid?: number;
  workerHeartbeatAt?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  lastEventSeq: number;
}

export interface StoredEvent {
  seq: number;
  timestamp: string;
  type: string;
  data?: unknown;
}

export class TaskStore {
  private readonly tasksRoot: string;
  private readonly locks = new Map<string, Promise<void>>();

  constructor(dataRoot: string) {
    this.tasksRoot = path.join(dataRoot, "tasks");
  }

  async initialize(): Promise<void> {
    await mkdir(this.tasksRoot, { recursive: true });
  }

  private taskDirectory(taskId: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(taskId)) throw new Error("Invalid task id.");
    return path.join(this.tasksRoot, taskId);
  }

  private recordPath(taskId: string): string {
    return path.join(this.taskDirectory(taskId), "record.json");
  }

  private eventsPath(taskId: string): string {
    return path.join(this.taskDirectory(taskId), "events.jsonl");
  }

  private lockPath(taskId: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(taskId)) throw new Error("Invalid task id.");
    return path.join(this.tasksRoot, `${taskId}.lock`);
  }

  private async atomicWrite(filePath: string, content: string): Promise<void> {
    const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, content, "utf8");
    await rename(temporary, filePath);
  }

  private async exclusive<T>(taskId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(taskId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = previous.then(() => current);
    this.locks.set(taskId, chained);
    await previous;
    const lockPath = this.lockPath(taskId);
    try {
      const deadline = Date.now() + 5_000;
      while (true) {
        try {
          await mkdir(lockPath);
          break;
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
          if (Date.now() >= deadline) throw new Error(`Timed out acquiring task lock: ${taskId}`);
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      try {
        return await operation();
      } finally {
        await rm(lockPath, { recursive: true, force: true });
      }
    } finally {
      release();
      if (this.locks.get(taskId) === chained) this.locks.delete(taskId);
    }
  }

  async create(record: TaskRecord): Promise<void> {
    await this.exclusive(record.id, async () => {
      await mkdir(this.taskDirectory(record.id), { recursive: false });
      await this.atomicWrite(this.recordPath(record.id), `${JSON.stringify(record, null, 2)}\n`);
      await writeFile(this.eventsPath(record.id), "", "utf8");
    });
  }

  async get(taskId: string): Promise<TaskRecord> {
    try {
      return JSON.parse(await readFile(this.recordPath(taskId), "utf8")) as TaskRecord;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`Unknown task: ${taskId}`);
      }
      throw error;
    }
  }

  async update(taskId: string, mutate: (record: TaskRecord) => void): Promise<TaskRecord> {
    return this.exclusive(taskId, async () => {
      const record = await this.get(taskId);
      mutate(record);
      record.updatedAt = new Date().toISOString();
      await this.atomicWrite(this.recordPath(taskId), `${JSON.stringify(record, null, 2)}\n`);
      return record;
    });
  }

  async appendEvent(taskId: string, type: string, data?: unknown): Promise<StoredEvent> {
    return this.exclusive(taskId, async () => {
      const record = await this.get(taskId);
      const event: StoredEvent = {
        seq: record.lastEventSeq + 1,
        timestamp: new Date().toISOString(),
        type,
        ...(data === undefined ? {} : { data }),
      };
      await appendFile(this.eventsPath(taskId), `${JSON.stringify(event)}\n`, "utf8");
      record.lastEventSeq = event.seq;
      record.updatedAt = event.timestamp;
      await this.atomicWrite(this.recordPath(taskId), `${JSON.stringify(record, null, 2)}\n`);
      return event;
    });
  }

  async events(taskId: string, afterSeq = 0, limit = 100): Promise<StoredEvent[]> {
    await this.get(taskId);
    const content = await readFile(this.eventsPath(taskId), "utf8");
    return content
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as StoredEvent)
      .filter((event) => event.seq > afterSeq)
      .slice(0, limit);
  }

  async list(): Promise<TaskRecord[]> {
    await this.initialize();
    const entries = await readdir(this.tasksRoot, { withFileTypes: true });
    const records: TaskRecord[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        records.push(await this.get(entry.name));
      } catch {
        // Ignore incomplete directories left by an interrupted create.
      }
    }
    return records.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }
}
