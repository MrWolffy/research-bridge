import path from "node:path";

import { describe, expect, it } from "vitest";

import { resolveInside } from "../src/paths.js";

describe("resolveInside", () => {
  const root = path.resolve("C:/workspace/repo");

  it("resolves a repository-relative path", () => {
    expect(resolveInside(root, "src/file.ts")).toBe(path.resolve(root, "src/file.ts"));
  });

  it("rejects traversal outside the repository", () => {
    expect(() => resolveInside(root, "../secret.txt")).toThrow(/escapes/);
  });

  it("rejects absolute paths", () => {
    expect(() => resolveInside(root, path.resolve(root, "file.ts"))).toThrow(/relative/);
  });
});
