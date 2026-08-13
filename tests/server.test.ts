import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";

import type { BridgeConfig } from "../src/config.js";
import { runCommand } from "../src/process.js";
import { RepositoryService } from "../src/repository.js";
import { createServer } from "../src/server.js";
import type { TaskManager } from "../src/task-manager.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("MCP server", () => {
  it("negotiates the protocol and exposes the M1 tools", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "research-bridge-mcp-"));
    temporaryDirectories.push(repoRoot);
    await runCommand("git", ["init", "-b", "main"], repoRoot);
    await runCommand("git", ["config", "user.email", "test@example.com"], repoRoot);
    await runCommand("git", ["config", "user.name", "Test User"], repoRoot);
    await writeFile(path.join(repoRoot, "README.md"), "fixture\n", "utf8");
    await runCommand("git", ["add", "README.md"], repoRoot);
    await runCommand("git", ["commit", "-m", "fixture"], repoRoot);

    const config: BridgeConfig = {
      repoRoot,
      dataRoot: path.join(repoRoot, ".data"),
      maxReadLines: 500,
      maxSearchResults: 100,
      maxDiffChars: 20_000,
      workerPollMs: 10,
      workerLeaseMs: 1_000,
    };
    const repository = new RepositoryService(repoRoot);
    const server = createServer(config, repository, {} as TaskManager);
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const tools = await client.listTools();
    expect(client.getServerCapabilities()?.tools?.listChanged).toBe(false);
    expect(tools.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        "repo_snapshot",
        "repo_read",
        "repo_search",
        "codex_start_task",
        "codex_send_followup",
        "codex_status",
        "codex_events",
        "codex_diff",
        "codex_artifacts",
        "codex_record_audit_event",
        "codex_audit",
        "codex_abort",
      ]),
    );

    const snapshot = await client.callTool({ name: "repo_snapshot", arguments: {} });
    expect(snapshot.isError).not.toBe(true);
    expect(snapshot.structuredContent).toMatchObject({ branch: "main" });

    await client.close();
    await server.close();
  });
});
