import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { JobStore, SchedulerLock, scheduledRunId } from "./store.js";
import type { ScheduledJob, ScheduledRun } from "./types.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function job(): ScheduledJob {
  return {
    id: "job_1",
    name: "Reminder",
    status: "enabled",
    owner: {
      key: "gateway:telegram:tg:direct:chat",
      locator: { channel: "telegram", account: "tg", chat: { type: "direct", id: "chat" } },
    },
    schedule: { kind: "at", atUtc: "2026-01-01T00:00:00.000Z", timezone: "UTC" },
    payload: { kind: "reminder", text: "hello" },
    delivery: { kind: "origin" },
    nextRunAt: "2026-01-01T00:00:00.000Z",
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
  };
}
function run(): ScheduledRun {
  return {
    version: 1,
    id: scheduledRunId("job_1", "2026-01-01T00:00:00.000Z"),
    jobId: "job_1",
    trigger: "scheduled",
    scheduledFor: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    execution: { status: "queued", attempt: 0, maxAttempts: 2 },
    delivery: { status: "not_required", attempt: 0, maxAttempts: 4 },
  };
}

describe("JobStore", () => {
  it("atomically persists definitions and exclusively claims a run", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "novi-jobs-"));
    roots.push(root);
    const store = await JobStore.open(root, "2026-01-01");
    await store.putJob(job());
    expect((await JobStore.open(root)).getJob("job_1")?.name).toBe("Reminder");
    expect((await store.createRun(run())).created).toBe(true);
    expect((await store.createRun(run())).created).toBe(false);
  });

  it("fails closed on a corrupt store without overwriting it", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "novi-jobs-"));
    roots.push(root);
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, "store.json"), "{broken", "utf8");
    await expect(JobStore.open(root)).rejects.toThrow("failed to load job store");
    expect(await readFile(path.join(root, "store.json"), "utf8")).toBe("{broken");
  });

  it("allows only one scheduler owner", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "novi-jobs-"));
    roots.push(root);
    const lock = await SchedulerLock.acquire(root);
    await expect(SchedulerLock.acquire(root)).rejects.toThrow("another scheduler");
    await lock.release();
    await expect(SchedulerLock.acquire(root)).resolves.toBeDefined();
  });

  it("applies retention to synthetic Heartbeat runs without a stored job", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "novi-jobs-"));
    roots.push(root);
    const store = await JobStore.open(root, "2026-03-01");
    const heartbeatRun: ScheduledRun = {
      ...run(),
      id: "heartbeat_run_1",
      jobId: "heartbeat-gateway",
      trigger: "heartbeat",
      createdAt: "2026-01-01T00:00:00.000Z",
      execution: {
        status: "succeeded",
        attempt: 1,
        maxAttempts: 2,
        result: "HEARTBEAT_OK",
      },
      delivery: { status: "suppressed", attempt: 0, maxAttempts: 4 },
    };
    await store.createRun(heartbeatRun);

    await store.cleanup(30, 100, new Date("2026-03-01T00:00:00.000Z"));

    expect(await store.listRuns("heartbeat-gateway")).toEqual([]);
  });
});
