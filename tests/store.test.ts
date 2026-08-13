import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { TaskStore, type TaskRecord } from "../src/store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("TaskStore", () => {
  it("persists task records and cursor-addressable events", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "research-bridge-store-"));
    temporaryDirectories.push(root);
    const store = new TaskStore(root);
    await store.initialize();
    const now = new Date().toISOString();
    const record: TaskRecord = {
      id: "task_1",
      instruction: "inspect",
      repoRoot: root,
      state: "queued",
      sandbox: "read-only",
      networkAccess: false,
      expectedArtifacts: [],
      baseline: { branch: "main", commit: "abc", status: [], capturedAt: now },
      abortRequested: false,
      pendingFollowups: [],
      createdAt: now,
      updatedAt: now,
      lastEventSeq: 0,
    };

    await store.create(record);
    await store.appendEvent(record.id, "first", { value: 1 });
    await store.appendEvent(record.id, "second", { value: 2 });

    expect((await store.get(record.id)).lastEventSeq).toBe(2);
    expect((await store.events(record.id, 1)).map((event) => event.type)).toEqual(["second"]);
  });

  it("serializes updates from separate bridge processes through filesystem locks", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "research-bridge-store-"));
    temporaryDirectories.push(root);
    const first = new TaskStore(root);
    const second = new TaskStore(root);
    await first.initialize();
    const now = new Date().toISOString();
    await first.create({
      id: "shared_task",
      instruction: "inspect",
      repoRoot: root,
      state: "running",
      sandbox: "read-only",
      networkAccess: false,
      expectedArtifacts: [],
      baseline: { branch: "main", commit: "abc", status: [], capturedAt: now },
      abortRequested: false,
      pendingFollowups: [],
      createdAt: now,
      updatedAt: now,
      lastEventSeq: 0,
    });

    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        (index % 2 === 0 ? first : second).appendEvent("shared_task", `event.${index}`),
      ),
    );

    const events = await first.events("shared_task", 0, 100);
    expect(events).toHaveLength(20);
    expect(events.map((event) => event.seq)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });
});
