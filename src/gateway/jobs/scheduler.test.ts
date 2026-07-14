import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolvedGatewayConfig } from "../config.js";
import type { AutomationAgentRunner } from "./agent-runner.js";
import type { DeliveryService } from "./delivery.js";
import { GatewayScheduler } from "./scheduler.js";
import { JobStore } from "./store.js";
import type { ScheduledJob } from "./types.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const config = {
  automation: {
    timezone: "UTC",
    allowedTools: [],
    minCronIntervalMs: 300_000,
    runTimeoutMs: 120_000,
    maxExecutionRetries: 1,
    maxDeliveryRetries: 3,
    maxConcurrentLlmRuns: 2,
    dailyTokenLimit: 200_000,
    dailyCostUsd: 1,
    retentionDays: 30,
    maxRunsPerJob: 100,
    maxResultBytes: 65_536,
  },
} as unknown as ResolvedGatewayConfig;

describe("GatewayScheduler", () => {
  it("recovers an overdue reminder exactly once and completes it after delivery", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "novi-scheduler-"));
    roots.push(root);
    const store = await JobStore.open(root, "2026-01-02");
    const owner = {
      key: "gateway:telegram:tg:direct:chat",
      locator: {
        channel: "telegram" as const,
        account: "tg",
        chat: { type: "direct" as const, id: "chat" },
      },
    };
    const job: ScheduledJob = {
      id: "job_1",
      name: "late",
      owner,
      status: "enabled",
      schedule: { kind: "at", atUtc: "2026-01-01T00:00:00.000Z", timezone: "UTC" },
      payload: { kind: "reminder", text: "remember" },
      delivery: { kind: "origin" },
      nextRunAt: "2026-01-01T00:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    await store.putJob(job);
    const deliver = vi.fn(
      async (_job: ScheduledJob, run: Awaited<ReturnType<JobStore["getRun"]>> & {}) =>
        store.updateRun(run.jobId, run.id, (current) => ({
          ...current,
          delivery: {
            ...current.delivery,
            status: "delivered",
            originAppendedAt: "2026-01-02T00:00:00.000Z",
          },
        })),
    );
    const scheduler = new GatewayScheduler(
      store,
      { execute: vi.fn() } as unknown as AutomationAgentRunner,
      { deliver } as unknown as DeliveryService,
      config,
      () => new Date("2026-01-02T00:00:00.000Z"),
    );
    await scheduler.start();
    await scheduler.stop();
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(store.getJob("job_1")?.status).toBe("completed");
    expect(await store.listRuns("job_1")).toHaveLength(1);
  });
});
