import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import type { BridgeConfig } from "./config.js";
import type { RepositoryService } from "./repository.js";
import type { TaskManager } from "./task-manager.js";

function result(value: unknown) {
  const structuredContent = value as Record<string, unknown>;
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent,
  };
}

export function createServer(
  config: BridgeConfig,
  repository: RepositoryService,
  tasks: TaskManager,
): McpServer {
  const server = new McpServer(
    { name: "research-bridge", version: "0.1.0" },
    {
      instructions:
        "Use repo tools to inspect evidence before starting Codex tasks. codex_start_task returns immediately; poll codex_status and codex_events. Follow-ups sent during a turn are queued and run on the same Codex thread after the current turn. Treat codex_diff as repository-wide and compare it with the task baseline. Never claim an artifact exists without checking codex_artifacts.",
    },
  );

  server.registerTool(
    "bridge_health",
    {
      description: "Check bridge configuration and target repository connectivity.",
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async () => {
      const snapshot = await repository.snapshot();
      return result({ ok: true, repoRoot: config.repoRoot, dataRoot: config.dataRoot, snapshot });
    },
  );

  server.registerTool(
    "repo_snapshot",
    {
      description: "Return the target repository branch, commit, dirty status, and top-level entries.",
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async () => result(await repository.snapshot()),
  );

  server.registerTool(
    "repo_read",
    {
      description: "Read a bounded line range from a UTF-8 text file inside the target repository.",
      inputSchema: {
        path: z.string().min(1),
        start_line: z.number().int().positive().optional(),
        end_line: z.number().int().positive().optional(),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ path, start_line, end_line }) =>
      result(await repository.read(path, start_line, end_line)),
  );

  server.registerTool(
    "repo_search",
    {
      description: "Search text files under the target repository without leaving its root.",
      inputSchema: {
        query: z.string().min(1),
        path_prefix: z.string().min(1).optional(),
        case_sensitive: z.boolean().optional(),
        max_results: z.number().int().positive().max(500).optional(),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ query, path_prefix, case_sensitive, max_results }) =>
      result(
        await repository.search(query, {
          ...(path_prefix ? { pathPrefix: path_prefix } : {}),
          ...(case_sensitive === undefined ? {} : { caseSensitive: case_sensitive }),
          ...(max_results === undefined ? {} : { maxResults: max_results }),
        }),
      ),
  );

  server.registerTool(
    "codex_start_task",
    {
      description:
        "Start a background Codex turn in the target repository and return a local task id immediately.",
      inputSchema: {
        instruction: z.string().min(1),
        label: z.string().min(1).max(120).optional(),
        sandbox: z.enum(["read-only", "workspace-write"]).optional(),
        model: z.string().min(1).optional(),
        network_access: z.boolean().optional(),
        expected_artifacts: z.array(z.string().min(1)).max(100).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ instruction, label, sandbox, model, network_access, expected_artifacts }) =>
      result(
        await tasks.start({
          instruction,
          ...(label ? { label } : {}),
          ...(sandbox ? { sandbox } : {}),
          ...(model ? { model } : {}),
          ...(network_access === undefined ? {} : { networkAccess: network_access }),
          ...(expected_artifacts ? { expectedArtifacts: expected_artifacts } : {}),
        }),
      ),
  );

  server.registerTool(
    "codex_send_followup",
    {
      description:
        "Queue a correction or follow-up. It runs on the same Codex thread after the active turn finishes.",
      inputSchema: {
        task_id: z.string().uuid(),
        instruction: z.string().min(1),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ task_id, instruction }) => result(await tasks.followup(task_id, instruction)),
  );

  server.registerTool(
    "codex_status",
    {
      description: "Return persisted status and summary for a Codex task.",
      inputSchema: { task_id: z.string().uuid() },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ task_id }) => result(await tasks.store.get(task_id)),
  );

  server.registerTool(
    "codex_events",
    {
      description: "Read ordered, append-only bridge and Codex events after a sequence cursor.",
      inputSchema: {
        task_id: z.string().uuid(),
        after_seq: z.number().int().nonnegative().optional(),
        limit: z.number().int().positive().max(500).optional(),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ task_id, after_seq, limit }) => {
      const events = await tasks.store.events(task_id, after_seq ?? 0, limit ?? 100);
      return result({
        taskId: task_id,
        events,
        nextAfterSeq: events.at(-1)?.seq ?? after_seq ?? 0,
      });
    },
  );

  server.registerTool(
    "codex_diff",
    {
      description:
        "Return the current repository-wide staged and unstaged diff plus the task baseline reference.",
      inputSchema: { task_id: z.string().uuid() },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ task_id }) => {
      const task = await tasks.store.get(task_id);
      return result({ taskId: task_id, baseline: task.baseline, current: await repository.diff() });
    },
  );

  server.registerTool(
    "codex_artifacts",
    {
      description: "Check expected artifact paths and list all currently changed repository paths.",
      inputSchema: { task_id: z.string().uuid() },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ task_id }) => {
      const task = await tasks.store.get(task_id);
      return result({
        taskId: task_id,
        baseline: task.baseline,
        ...(await repository.artifacts(task.expectedArtifacts)),
      });
    },
  );

  server.registerTool(
    "codex_abort",
    {
      description: "Request cancellation of a queued or running Codex task.",
      inputSchema: { task_id: z.string().uuid() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async ({ task_id }) => result(await tasks.abort(task_id)),
  );

  return server;
}
