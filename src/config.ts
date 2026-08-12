import os from "node:os";
import path from "node:path";

export interface BridgeConfig {
  repoRoot: string;
  dataRoot: string;
  codexPathOverride?: string;
  maxReadLines: number;
  maxSearchResults: number;
  maxDiffChars: number;
}

function positiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, received: ${value}`);
  }
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  const repoRoot = path.resolve(env.RESEARCH_BRIDGE_REPO_ROOT ?? process.cwd());
  const dataRoot = path.resolve(
    env.RESEARCH_BRIDGE_DATA_DIR ?? path.join(os.homedir(), ".research-bridge"),
  );

  return {
    repoRoot,
    dataRoot,
    codexPathOverride: env.RESEARCH_BRIDGE_CODEX_PATH || undefined,
    maxReadLines: positiveInt(env.RESEARCH_BRIDGE_MAX_READ_LINES, 500),
    maxSearchResults: positiveInt(env.RESEARCH_BRIDGE_MAX_SEARCH_RESULTS, 100),
    maxDiffChars: positiveInt(env.RESEARCH_BRIDGE_MAX_DIFF_CHARS, 200_000),
  };
}
