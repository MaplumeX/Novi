import net from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertGatewayOffline } from "./guard.js";

const roots: string[] = [];
const servers: net.Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "novi-migration-guard-"));
  roots.push(root);
  const runtimeDir = path.join(root, "runtime");
  const jobsRoot = path.join(root, "jobs");
  await mkdir(runtimeDir);
  await mkdir(jobsRoot);
  return {
    runtimeDir,
    jobsRoot,
    paths: { runtimeDir, socketPath: path.join(runtimeDir, "gateway.sock") },
  };
}

describe("Gateway migration ownership guard", () => {
  it("rejects a live Gateway control socket", async () => {
    const state = await fixture();
    const server = net.createServer();
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(state.paths.socketPath, resolve);
    });
    await expect(assertGatewayOffline(state.paths, state.jobsRoot)).rejects.toThrow(
      /running Gateway to stop/,
    );
  });

  it("rejects a scheduler lock owned by a live process", async () => {
    const state = await fixture();
    await writeFile(
      path.join(state.jobsRoot, "scheduler.lock"),
      `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`,
      { mode: 0o600 },
    );
    await expect(assertGatewayOffline(state.paths, state.jobsRoot)).rejects.toThrow(
      new RegExp(`scheduler pid ${process.pid}`),
    );
  });
});
