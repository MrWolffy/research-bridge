import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ThreadEvent, ThreadOptions } from "@openai/codex-sdk";
import { afterEach, describe, expect, it } from "vitest";

import type { BridgeConfig } from "../src/config.js";
import { runCommand } from "../src/process.js";
import { RepositoryService } from "../src/repository.js";
import { TaskStore } from "../src/store.js";
import {
  TaskManager,
  type CodexLike,
  type CodexThreadLike,
} from "../src/task-manager.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function makeRepository(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "research-bridge-repo-"));
  temporaryDirectories.push(root);
  await runCommand("git", ["init", "-b", "main"], root);
  await runCommand("git", ["config", "user.email", "test@example.com"], root);
  await runCommand("git", ["config", "user.name", "Test User"], root);
  await writeFile(path.join(root, "README.md"), "fixture\n", "utf8");
  await runCommand("git", ["add", "README.md"], root);
  await runCommand("git", ["commit", "-m", "fixture"], root);
  return root;
}

class FakeThread implements CodexThreadLike {
  readonly id = "thread-fixture";

  async runStreamed(input: string): Promise<{ events: AsyncGenerator<ThreadEvent> }> {
    async function* events(): AsyncGenerator<ThreadEvent> {
      yield { type: "thread.started", thread_id: "thread-fixture" };
      yield { type: "turn.started" };
      yield {
        type: "item.completed",
        item: { id: `message-${input}`, type: "agent_message", text: `done: ${input}` },
      };
      yield {
        type: "turn.completed",
        usage: {
          input_tokens: 1,
          cached_input_tokens: 0,
          cache_write_input_tokens: 0,
          output_tokens: 1,
          reasoning_output_tokens: 0,
        },
      };
    }
    return { events: events() };
  }
}

class FakeCodex implements CodexLike {
  readonly thread = new FakeThread();
  startThread(_options?: ThreadOptions): CodexThreadLike {
    return this.thread;
  }
  resumeThread(_id: string, _options?: ThreadOptions): CodexThreadLike {
    return this.thread;
  }
}

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for task state.");
}

describe("TaskManager", () => {
  it("runs a task, persists Codex events, and resumes the same thread for follow-up", async () => {
    const repoRoot = await makeRepository();
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), "research-bridge-data-"));
    temporaryDirectories.push(dataRoot);
    const config: BridgeConfig = {
      repoRoot,
      dataRoot,
      maxReadLines: 500,
      maxSearchResults: 100,
      maxDiffChars: 20_000,
    };
    const repository = new RepositoryService(repoRoot);
    const store = new TaskStore(dataRoot);
    const manager = new TaskManager(config, store, repository, new FakeCodex());
    await manager.initialize();

    const task = await manager.start({ instruction: "first", sandbox: "read-only" });
    await waitFor(async () => (await store.get(task.id)).state === "completed");
    expect((await store.get(task.id)).finalResponse).toBe("done: first");

    await manager.followup(task.id, "second");
    await waitFor(async () => {
      const current = await store.get(task.id);
      return current.state === "completed" && current.finalResponse === "done: second";
    });

    const events = await store.events(task.id, 0, 100);
    expect(events.some((event) => event.type === "followup.queued")).toBe(true);
    expect((await store.get(task.id)).threadId).toBe("thread-fixture");
  });
});
