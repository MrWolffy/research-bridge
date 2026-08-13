import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";

import type { BridgeConfig } from "./config.js";
import { RepositoryService } from "./repository.js";
import { TaskStore } from "./store.js";
import { TaskManager } from "./task-manager.js";

interface HostLeaseOwner {
  id: string;
  pid: number;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function acquireHostLease(config: BridgeConfig): Promise<{
  heartbeat: () => Promise<void>;
  release: () => Promise<void>;
} | null> {
  const leaseDirectory = path.join(config.dataRoot, "worker-host.lock");
  const ownerFile = path.join(leaseDirectory, "owner.json");
  const id = randomUUID();

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await mkdir(leaseDirectory, { recursive: false });
      const owner: HostLeaseOwner = { id, pid: process.pid };
      await writeFile(ownerFile, `${JSON.stringify(owner)}\n`, "utf8");
      const heartbeat = async () => {
        const now = new Date();
        await utimes(leaseDirectory, now, now);
      };
      await heartbeat();
      return {
        heartbeat,
        release: async () => {
          try {
            const current = JSON.parse(await readFile(ownerFile, "utf8")) as HostLeaseOwner;
            if (current.id === id) await rm(leaseDirectory, { recursive: true, force: true });
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const owner = JSON.parse(await readFile(ownerFile, "utf8")) as HostLeaseOwner;
        if (isProcessAlive(owner.pid)) return null;
      } catch {
        // A competing host may still be writing its owner file; directory age
        // below keeps a fresh lease from being reclaimed during that window.
      }
      try {
        const current = await stat(leaseDirectory);
        if (Date.now() - current.mtimeMs <= config.workerLeaseMs) return null;
      } catch (readError) {
        if ((readError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw readError;
      }
      await rm(leaseDirectory, { recursive: true, force: true });
    }
  }
  return null;
}

export async function runWorkerHost(config: BridgeConfig): Promise<void> {
  const lease = await acquireHostLease(config);
  if (!lease) return;

  const repository = new RepositoryService(
    config.repoRoot,
    config.maxReadLines,
    config.maxSearchResults,
    config.maxDiffChars,
  );
  const store = new TaskStore(config.dataRoot);
  const tasks = new TaskManager(config, store, repository, undefined, { executionMode: "worker" });
  await tasks.initialize();

  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  try {
    while (!stopping) {
      await lease.heartbeat();
      const records = await store.list();
      await Promise.all(
        records
          .filter((record) => record.state === "queued" && !record.abortRequested)
          .map((record) => tasks.runQueued(record.id)),
      );
      await new Promise((resolve) => setTimeout(resolve, config.workerPollMs));
    }
  } finally {
    await lease.release();
  }
}
