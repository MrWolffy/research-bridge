import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { atomicWriteFile } from "../src/atomic-write.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("atomicWriteFile", () => {
  it("retries transient Windows rename failures and removes the temporary file", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "research-bridge-atomic-write-"));
    temporaryDirectories.push(root);
    const target = path.join(root, "record.json");
    await writeFile(target, "old", "utf8");
    let attempts = 0;

    await atomicWriteFile(target, "new", {
      initialDelayMs: 0,
      renameFile: async (source, destination) => {
        attempts += 1;
        if (attempts < 3) {
          const error = new Error("transient sharing violation") as NodeJS.ErrnoException;
          error.code = "EPERM";
          throw error;
        }
        const { rename } = await import("node:fs/promises");
        await rename(source, destination);
      },
    });

    expect(attempts).toBe(3);
    expect(await readFile(target, "utf8")).toBe("new");
    expect((await readdir(root)).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
  });

  it("does not retry non-transient errors and still removes the temporary file", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "research-bridge-atomic-write-"));
    temporaryDirectories.push(root);
    const target = path.join(root, "record.json");
    let attempts = 0;

    await expect(
      atomicWriteFile(target, "new", {
        initialDelayMs: 0,
        renameFile: async () => {
          attempts += 1;
          const error = new Error("invalid target") as NodeJS.ErrnoException;
          error.code = "EINVAL";
          throw error;
        },
      }),
    ).rejects.toMatchObject({ code: "EINVAL" });

    expect(attempts).toBe(1);
    expect((await readdir(root)).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
  });
});
