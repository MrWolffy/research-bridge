#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { loadConfig } from "./config.js";
import { RepositoryService } from "./repository.js";
import { createServer } from "./server.js";
import { TaskStore } from "./store.js";
import { TaskManager } from "./task-manager.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const repository = new RepositoryService(
    config.repoRoot,
    config.maxReadLines,
    config.maxSearchResults,
    config.maxDiffChars,
  );
  const store = new TaskStore(config.dataRoot);
  const tasks = new TaskManager(config, store, repository);
  await tasks.initialize();

  const server = createServer(config, repository, tasks);
  await server.connect(new StdioServerTransport());
  console.error(`research-bridge ready for ${config.repoRoot}`);
}

main().catch((error) => {
  console.error("research-bridge failed to start:", error);
  process.exitCode = 1;
});
