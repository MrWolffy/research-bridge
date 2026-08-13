import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AuditLog } from "../src/audit.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("AuditLog", () => {
  it("writes complete JSONL records and regenerates the readable summary in the research workspace", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "research-bridge-audit-"));
    temporaryDirectories.push(repoRoot);
    const snapshot = async () => ({
      root: repoRoot,
      branch: "main",
      commit: "abc123",
      status: [" M src/example.ts"],
      entries: [],
      capturedAt: new Date().toISOString(),
    });
    const audit = new AuditLog(repoRoot, snapshot);

    await audit.append("task_1", {
      actor: "CHATGPT",
      eventType: "chatgpt.task_instruction",
      content: "Implement the feature",
      relatedPaths: ["src/example.ts"],
    });
    await audit.append("task_1", {
      actor: "CHATGPT",
      eventType: "chatgpt.final_verdict",
      content: "APPROVE",
    });

    const directory = path.join(repoRoot, ".agents", "audit", "bridge", "task_1");
    const lines = (await readFile(path.join(directory, "events.jsonl"), "utf8"))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      seq: 1,
      task_id: "task_1",
      actor: "CHATGPT",
      event_type: "chatgpt.task_instruction",
      content: "Implement the feature",
      repo_commit: "abc123",
      repo_dirty_state: [" M src/example.ts"],
      related_paths: ["src/example.ts"],
    });
    expect(lines[0].timestamp).toEqual(expect.any(String));

    const markdown = await readFile(path.join(directory, "audit.md"), "utf8");
    expect(markdown).toContain("# Bridge Audit — task_1");
    expect(markdown).toContain("Implement the feature");
    expect(markdown).toContain("## Verdict");
    expect(markdown).toContain("APPROVE");
  });

  it("allocates ordered sequences across independent writers", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "research-bridge-audit-"));
    temporaryDirectories.push(repoRoot);
    const snapshot = async () => ({
      root: repoRoot,
      branch: "main",
      commit: "abc123",
      status: [],
      entries: [],
      capturedAt: new Date().toISOString(),
    });
    const first = new AuditLog(repoRoot, snapshot);
    const second = new AuditLog(repoRoot, snapshot);

    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        (index % 2 ? first : second).append("shared_task", {
          actor: "BRIDGE",
          eventType: "bridge.test_evidence",
          content: `test ${index}`,
        }),
      ),
    );

    const events = await first.events("shared_task");
    expect(events.map((event) => event.seq)).toEqual(
      Array.from({ length: 12 }, (_, index) => index + 1),
    );
  });
});
