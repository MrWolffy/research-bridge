import { rename, rm, writeFile } from "node:fs/promises";

const RETRYABLE_RENAME_CODES = new Set(["EACCES", "EBUSY", "EPERM"]);

export type AtomicWrite = (filePath: string, content: string) => Promise<void>;

export interface AtomicWriteOptions {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  renameFile?: typeof rename;
}

function retryableRename(error: unknown): boolean {
  return RETRYABLE_RENAME_CODES.has((error as NodeJS.ErrnoException).code ?? "");
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export async function atomicWriteFile(
  filePath: string,
  content: string,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const maxAttempts = options.maxAttempts ?? 24;
  const initialDelayMs = options.initialDelayMs ?? 10;
  const maxDelayMs = options.maxDelayMs ?? 500;
  const renameFile = options.renameFile ?? rename;
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;

  await writeFile(temporary, content, "utf8");
  try {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await renameFile(temporary, filePath);
        return;
      } catch (error) {
        if (!retryableRename(error) || attempt >= maxAttempts) throw error;
        const delayMs = Math.min(initialDelayMs * 2 ** (attempt - 1), maxDelayMs);
        await wait(delayMs);
      }
    }
  } finally {
    await rm(temporary, { force: true });
  }
}
