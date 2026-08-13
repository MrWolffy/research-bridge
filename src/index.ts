#!/usr/bin/env node
import { spawn } from "node:child_process";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { loadConfig } from "./config.js";
import { RepositoryService } from "./repository.js";
import { createServer } from "./server.js";
import { TaskStore } from "./store.js";
import { TaskManager } from "./task-manager.js";
import { runWorkerHost } from "./worker-host.js";

function ensureWorkerProcess(): void {
  if (process.env.RESEARCH_BRIDGE_EXTERNAL_WORKER === "1") return;
  const entry = process.argv[1];
  if (!entry) throw new Error("Cannot determine the research-bridge entry point.");
  const child = spawn(process.execPath, [...process.execArgv, entry, "--worker"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: process.env,
  });
  child.unref();
}

async function main(): Promise<void> {
  const config = loadConfig();
  if (process.argv.includes("--worker")) {
    await runWorkerHost(config);
    return;
  }
  ensureWorkerProcess();
  const repository = new RepositoryService(
    config.repoRoot,
    config.maxReadLines,
    config.maxSearchResults,
    config.maxDiffChars,
  );
  const store = new TaskStore(config.dataRoot);
  const tasks = new TaskManager(config, store, repository, undefined, {
    executionMode: "coordinator",
  });
  await tasks.initialize();

  const server = createServer(config, repository, tasks);
  await server.connect(new StdioServerTransport());
  console.error(`research-bridge ready for ${config.repoRoot}`);
}

main().catch((error) => {
  console.error("research-bridge failed to start:", error);
  process.exitCode = 1;
});
