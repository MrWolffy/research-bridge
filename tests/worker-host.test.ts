import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { BridgeConfig } from "../src/config.js";
import { acquireHostLease } from "../src/worker-host.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function makeConfig(): Promise<BridgeConfig> {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "research-bridge-worker-"));
  temporaryDirectories.push(dataRoot);
  return {
    repoRoot: dataRoot,
    dataRoot,
    maxReadLines: 500,
    maxSearchResults: 100,
    maxDiffChars: 20_000,
    workerPollMs: 10,
    workerLeaseMs: 15_000,
  };
}

async function createExistingLease(
  config: BridgeConfig,
  ownerPid: number,
  ageMs = 0,
): Promise<string> {
  const directory = path.join(config.dataRoot, "worker-host.lock");
  await mkdir(directory);
  await writeFile(
    path.join(directory, "owner.json"),
    `${JSON.stringify({ id: "previous-owner", pid: ownerPid })}\n`,
    "utf8",
  );
  if (ageMs > 0) {
    const timestamp = new Date(Date.now() - ageMs);
    await utimes(directory, timestamp, timestamp);
  }
  return directory;
}

describe("worker host lease", () => {
  it("immediately reclaims a fresh lease whose owner process is dead", async () => {
    const config = await makeConfig();
    const directory = await createExistingLease(config, 2_147_483_647);

    const lease = await acquireHostLease(config);

    expect(lease).not.toBeNull();
    const owner = JSON.parse(await readFile(path.join(directory, "owner.json"), "utf8"));
    expect(owner.pid).toBe(process.pid);
    await lease!.release();
  });

  it("reclaims a stale lease even when its PID belongs to a live process", async () => {
    const config = await makeConfig();
    const directory = await createExistingLease(config, process.pid, config.workerLeaseMs + 1_000);

    const lease = await acquireHostLease(config);

    expect(lease).not.toBeNull();
    const owner = JSON.parse(await readFile(path.join(directory, "owner.json"), "utf8"));
    expect(owner.id).not.toBe("previous-owner");
    await lease!.release();
  });

  it("does not take a fresh lease from a live owner", async () => {
    const config = await makeConfig();
    await createExistingLease(config, process.pid);

    expect(await acquireHostLease(config)).toBeNull();
  });
});
