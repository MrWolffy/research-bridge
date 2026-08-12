import path from "node:path";

export function resolveInside(root: string, relativePath: string): string {
  if (!relativePath || path.isAbsolute(relativePath)) {
    throw new Error("Path must be a non-empty path relative to the repository root.");
  }

  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(resolvedRoot, relativePath);
  const relative = path.relative(resolvedRoot, resolvedPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path escapes the repository root: ${relativePath}`);
  }
  return resolvedPath;
}

export function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}
