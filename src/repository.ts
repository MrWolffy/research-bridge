import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { resolveInside, toPosixPath } from "./paths.js";
import { runCommand } from "./process.js";

const SKIPPED_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".venv",
  "venv",
  "__pycache__",
]);
const AUDIT_EXCLUDE_PATHSPEC = ":(exclude).agents/audit/bridge";

export interface RepoSnapshot {
  root: string;
  branch: string;
  commit: string;
  status: string[];
  entries: string[];
  capturedAt: string;
}

export interface SearchMatch {
  path: string;
  line: number;
  text: string;
}

export class RepositoryService {
  constructor(
    readonly root: string,
    private readonly maxReadLines = 500,
    private readonly maxSearchResults = 100,
    private readonly maxDiffChars = 200_000,
  ) {}

  private async git(args: string[]): Promise<string> {
    return (await runCommand("git", args, this.root)).stdout.trimEnd();
  }

  async assertGitRepository(): Promise<void> {
    const result = await this.git(["rev-parse", "--is-inside-work-tree"]);
    if (result.trim() !== "true") throw new Error(`${this.root} is not a Git worktree.`);
  }

  async snapshot(options: { excludeAuditLogs?: boolean } = {}): Promise<RepoSnapshot> {
    await this.assertGitRepository();
    const statusArgs = options.excludeAuditLogs
      ? ["status", "--short", "--", ".", AUDIT_EXCLUDE_PATHSPEC]
      : ["status", "--short"];
    const [branch, commit, statusText, entries] = await Promise.all([
      this.git(["branch", "--show-current"]),
      this.git(["rev-parse", "HEAD"]),
      this.git(statusArgs),
      readdir(this.root, { withFileTypes: true }),
    ]);
    return {
      root: this.root,
      branch: branch || "(detached)",
      commit,
      status: statusText ? statusText.split(/\r?\n/) : [],
      entries: entries
        .filter((entry) => entry.name !== ".git")
        .map((entry) => `${entry.isDirectory() ? "dir" : "file"}:${entry.name}`)
        .sort()
        .slice(0, 250),
      capturedAt: new Date().toISOString(),
    };
  }

  async read(relativePath: string, startLine = 1, endLine?: number): Promise<object> {
    const absolutePath = resolveInside(this.root, relativePath);
    const fileStat = await stat(absolutePath);
    if (!fileStat.isFile()) throw new Error(`Not a file: ${relativePath}`);
    if (fileStat.size > 5 * 1024 * 1024) throw new Error("File exceeds the 5 MB read limit.");

    const content = await readFile(absolutePath, "utf8");
    if (content.includes("\0")) throw new Error("Binary files cannot be read with repo_read.");
    const lines = content.split(/\r?\n/);
    const first = Math.max(1, startLine);
    const requestedEnd = endLine ?? first + this.maxReadLines - 1;
    const last = Math.min(lines.length, requestedEnd, first + this.maxReadLines - 1);
    if (requestedEnd < first) throw new Error("end_line must be greater than or equal to start_line.");

    return {
      path: toPosixPath(relativePath),
      startLine: first,
      endLine: last,
      totalLines: lines.length,
      truncated: requestedEnd > last,
      content: lines.slice(first - 1, last).join("\n"),
    };
  }

  async search(
    query: string,
    options: { pathPrefix?: string; caseSensitive?: boolean; maxResults?: number } = {},
  ): Promise<object> {
    if (!query) throw new Error("query must not be empty.");
    const limit = Math.min(options.maxResults ?? this.maxSearchResults, this.maxSearchResults);
    const start = options.pathPrefix ? resolveInside(this.root, options.pathPrefix) : this.root;
    const matches: SearchMatch[] = [];
    const needle = options.caseSensitive ? query : query.toLocaleLowerCase();

    const visit = async (directory: string): Promise<void> => {
      if (matches.length >= limit) return;
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        if (matches.length >= limit) break;
        if (entry.isSymbolicLink()) continue;
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (!SKIPPED_DIRECTORIES.has(entry.name)) await visit(absolute);
          continue;
        }
        if (!entry.isFile()) continue;
        const fileStat = await stat(absolute);
        if (fileStat.size > 1024 * 1024) continue;
        let content: string;
        try {
          content = await readFile(absolute, "utf8");
        } catch {
          continue;
        }
        if (content.includes("\0")) continue;
        const lines = content.split(/\r?\n/);
        for (let index = 0; index < lines.length && matches.length < limit; index += 1) {
          const line = lines[index] ?? "";
          const haystack = options.caseSensitive ? line : line.toLocaleLowerCase();
          if (haystack.includes(needle)) {
            matches.push({
              path: toPosixPath(path.relative(this.root, absolute)),
              line: index + 1,
              text: line.slice(0, 500),
            });
          }
        }
      }
    };

    await visit(start);
    return { query, matches, truncated: matches.length >= limit, limit };
  }

  async diff(): Promise<object> {
    const [unstaged, staged, statusText] = await Promise.all([
      this.git(["diff", "--no-ext-diff", "--", ".", AUDIT_EXCLUDE_PATHSPEC]),
      this.git(["diff", "--cached", "--no-ext-diff", "--", ".", AUDIT_EXCLUDE_PATHSPEC]),
      this.git(["status", "--short", "--", ".", AUDIT_EXCLUDE_PATHSPEC]),
    ]);
    const combined = [
      unstaged ? `# Unstaged\n${unstaged}` : "",
      staged ? `# Staged\n${staged}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    return {
      status: statusText ? statusText.split(/\r?\n/) : [],
      diff: combined.slice(0, this.maxDiffChars),
      truncated: combined.length > this.maxDiffChars,
      totalChars: combined.length,
    };
  }

  async artifacts(expectedPaths: string[]): Promise<object> {
    const items = [];
    for (const relativePath of expectedPaths) {
      const absolutePath = resolveInside(this.root, relativePath);
      try {
        const fileStat = await stat(absolutePath);
        items.push({
          path: toPosixPath(relativePath),
          exists: true,
          kind: fileStat.isDirectory() ? "directory" : "file",
          size: fileStat.size,
          modifiedAt: fileStat.mtime.toISOString(),
        });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") throw error;
        items.push({ path: toPosixPath(relativePath), exists: false });
      }
    }
    const statusText = await this.git([
      "status",
      "--short",
      "--",
      ".",
      AUDIT_EXCLUDE_PATHSPEC,
    ]);
    return {
      expected: items,
      changedPaths: statusText ? statusText.split(/\r?\n/) : [],
    };
  }
}
