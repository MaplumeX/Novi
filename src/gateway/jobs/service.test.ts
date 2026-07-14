import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Models } from "@earendil-works/pi-ai";
import type { ResolvedGatewayConfig } from "../config.js";
import { GatewaySessionStore } from "../core/session-store.js";
import { JobService } from "./service.js";
import { JobStore } from "./store.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const config = {
  automation: {
    timezone: "UTC",
    allowedTools: ["read_file"],
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

describe("JobService", () => {
  it("isolates job lifecycle operations by canonical owner route", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "novi-service-"));
    roots.push(root);
    const store = await JobStore.open(path.join(root, "jobs"), "2026-01-01");
    const sessions = await GatewaySessionStore.open(path.join(root, "sessions.json"));
    const models = { getModel: vi.fn(), getAuth: vi.fn() } as unknown as Models;
    const service = new JobService(
      store,
      sessions,
      config,
      models,
      () => new Date("2026-01-01T00:00:00.000Z"),
    );
    const owner = {
      key: "gateway:telegram:tg:direct:a",
      locator: {
        channel: "telegram" as const,
        account: "tg",
        chat: { type: "direct" as const, id: "a" },
      },
    };
    const other = {
      key: "gateway:telegram:tg:direct:b",
      locator: {
        channel: "telegram" as const,
        account: "tg",
        chat: { type: "direct" as const, id: "b" },
      },
    };
    const job = await service.create(owner, {
      name: "once",
      schedule: { kind: "at", at: "2026-01-01T01:00:00Z" },
      payload: { kind: "reminder", text: "hello" },
    });
    expect(service.list(owner)).toHaveLength(1);
    expect(service.list(other)).toEqual([]);
    expect(() => service.get(other, job.id)).toThrow("not found");
    await expect(service.pause(other, job.id)).rejects.toThrow("not found");
    expect((await service.pause(owner, job.id)).status).toBe("paused");
    expect((await service.resume(owner, job.id)).status).toBe("enabled");
  });

  it("pins the requested model and rejects tools outside the unattended allowlist", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "novi-service-"));
    roots.push(root);
    const store = await JobStore.open(path.join(root, "jobs"), "2026-01-01");
    const sessions = await GatewaySessionStore.open(path.join(root, "sessions.json"));
    const model = { provider: "provider", id: "model" };
    const models = {
      getModel: vi.fn().mockReturnValue(model),
      getAuth: vi.fn().mockResolvedValue({ apiKey: "x" }),
    } as unknown as Models;
    const service = new JobService(
      store,
      sessions,
      config,
      models,
      () => new Date("2026-01-01T00:00:00.000Z"),
    );
    const owner = {
      key: "gateway:telegram:tg:direct:a",
      locator: {
        channel: "telegram" as const,
        account: "tg",
        chat: { type: "direct" as const, id: "a" },
      },
    };
    await expect(
      service.create(owner, {
        name: "cron",
        schedule: { kind: "cron", expression: "*/5 * * * *" },
        payload: {
          kind: "agent",
          prompt: "check",
          provider: "provider",
          model: "model",
          tools: ["bash"],
        },
      }),
    ).rejects.toThrow("allowlist");
    const job = await service.create(owner, {
      name: "cron",
      schedule: { kind: "cron", expression: "*/5 * * * *" },
      payload: {
        kind: "agent",
        prompt: "check",
        provider: "provider",
        model: "model",
        tools: ["read_file"],
      },
    });
    expect(job.payload).toMatchObject({
      kind: "agent",
      model: { provider: "provider", id: "model" },
      tools: ["read_file"],
    });
  });
});
