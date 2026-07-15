import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentProtocolAdapter, ChannelAdapter } from "../core/types.js";
import { GatewaySessionStore } from "../core/session-store.js";
import type { GatewaySessionManager } from "../core/session-manager.js";
import { ChannelDeliveryExecutor } from "../messages/delivery.js";
import { DeliveryRateLimiter } from "../messages/rate-limit.js";
import { DeliveryService } from "./delivery.js";
import { JobStore } from "./store.js";
import type { ScheduledJob, ScheduledRun } from "./types.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("DeliveryService", () => {
  it("persists sending before delivery and appends the origin session once", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "novi-delivery-"));
    roots.push(root);
    const owner = {
      key: "gateway:telegram:tg:direct:chat",
      locator: {
        channel: "telegram" as const,
        account: "tg",
        chat: { type: "direct" as const, id: "chat" },
      },
    };
    const sessions = await GatewaySessionStore.open(path.join(root, "sessions.json"));
    await sessions.bind(owner, {
      id: "session",
      cwd: "/workspace",
      path: "/tmp/session.jsonl",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const store = await JobStore.open(path.join(root, "jobs"), "2026-01-01");
    const job: ScheduledJob = {
      id: "job_1",
      name: "test",
      owner,
      status: "enabled",
      schedule: { kind: "at", atUtc: "2026-01-01T00:00:00.000Z", timezone: "UTC" },
      payload: { kind: "reminder", text: "hello" },
      delivery: { kind: "origin" },
      nextRunAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const run: ScheduledRun = {
      version: 1,
      id: "run_1",
      jobId: job.id,
      trigger: "scheduled",
      scheduledFor: "2026-01-01T00:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
      execution: { status: "succeeded", attempt: 1, maxAttempts: 2, result: "hello" },
      delivery: { status: "pending", attempt: 0, maxAttempts: 4 },
    };
    await store.putJob(job);
    await store.createRun(run);
    const channel = {
      id: "tg",
      type: "telegram",
      capabilities: { chatTypes: ["direct"] },
      textChunkLimit: 4096,
      start: vi.fn(),
      stop: vi.fn(),
      send: vi.fn().mockResolvedValue({ messageIds: ["42"] }),
    } as ChannelAdapter;
    const append = vi.fn().mockResolvedValue(undefined);
    const agent = { appendScheduledDelivery: append } as unknown as AgentProtocolAdapter;
    const manager = {
      enqueueSystemOperation: vi.fn(async (_route, operation: () => Promise<void>) => operation()),
    } as unknown as GatewaySessionManager;
    const delivery = new DeliveryService([channel], store, sessions, manager, agent);
    const result = await delivery.deliver(job, run);
    expect(result.delivery.status).toBe("delivered");
    expect(result.delivery.messageIds).toEqual(["42"]);
    expect(channel.send).toHaveBeenCalledWith(
      { chatId: "chat" },
      expect.stringContaining("job_1/run_1"),
    );
    expect(append).toHaveBeenCalledTimes(1);
  });

  it("retries only the persisted result after a transient send failure", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "novi-delivery-"));
    roots.push(root);
    const owner = {
      key: "gateway:telegram:tg:direct:chat",
      locator: {
        channel: "telegram" as const,
        account: "tg",
        chat: { type: "direct" as const, id: "chat" },
      },
    };
    const sessions = await GatewaySessionStore.open(path.join(root, "sessions.json"));
    await sessions.bind(owner, {
      id: "session",
      cwd: "/workspace",
      path: "/tmp/session.jsonl",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const store = await JobStore.open(path.join(root, "jobs"), "2026-01-01");
    const job = {
      id: "job_1",
      name: "test",
      owner,
      status: "enabled",
      schedule: { kind: "at", atUtc: "2026-01-01T00:00:00.000Z", timezone: "UTC" },
      payload: { kind: "reminder", text: "hello" },
      delivery: { kind: "origin" },
      nextRunAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    } as ScheduledJob;
    const run = {
      version: 1,
      id: "run_1",
      jobId: job.id,
      trigger: "scheduled",
      scheduledFor: "2026-01-01T00:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
      execution: { status: "succeeded", attempt: 1, maxAttempts: 2, result: "stable-result" },
      delivery: { status: "pending", attempt: 0, maxAttempts: 4 },
    } as ScheduledRun;
    await store.putJob(job);
    await store.createRun(run);
    const channel = {
      id: "tg",
      type: "telegram",
      capabilities: { chatTypes: ["direct"] },
      textChunkLimit: 20,
      start: vi.fn(),
      stop: vi.fn(),
      send: vi.fn(),
      sendFinalChunk: vi
        .fn()
        .mockResolvedValueOnce({ messageId: "partial-1" })
        .mockRejectedValueOnce({ code: "ECONNRESET" }),
    } as ChannelAdapter;
    const delivery = new DeliveryService(
      [channel],
      store,
      sessions,
      {} as GatewaySessionManager,
      {} as AgentProtocolAdapter,
      () => new Date("2026-01-01T00:00:00.000Z"),
      new ChannelDeliveryExecutor(
        new DeliveryRateLimiter({}, { now: () => 0, sleep: async () => Promise.resolve() }),
      ),
    );
    const result = await delivery.deliver(job, run);
    expect(result.delivery.status).toBe("pending");
    expect(result.delivery.attempt).toBe(1);
    expect(result.execution.result).toBe("stable-result");
    expect(result.delivery.messageIds).toEqual(["partial-1"]);
  });

  it("retries a failed origin append without sending Telegram twice", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "novi-delivery-"));
    roots.push(root);
    const owner = {
      key: "gateway:telegram:tg:direct:chat",
      locator: {
        channel: "telegram" as const,
        account: "tg",
        chat: { type: "direct" as const, id: "chat" },
      },
    };
    const sessions = await GatewaySessionStore.open(path.join(root, "sessions.json"));
    await sessions.bind(owner, {
      id: "session",
      cwd: "/workspace",
      path: "/tmp/session.jsonl",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const store = await JobStore.open(path.join(root, "jobs"), "2026-01-01");
    const job = {
      id: "job_1",
      name: "test",
      owner,
      status: "enabled",
      schedule: { kind: "at", atUtc: "2026-01-01T00:00:00.000Z", timezone: "UTC" },
      payload: { kind: "reminder", text: "hello" },
      delivery: { kind: "origin" },
      nextRunAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    } as ScheduledJob;
    const run = {
      version: 1,
      id: "run_1",
      jobId: job.id,
      trigger: "scheduled",
      scheduledFor: "2026-01-01T00:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
      execution: { status: "succeeded", attempt: 1, maxAttempts: 2, result: "stable" },
      delivery: { status: "pending", attempt: 0, maxAttempts: 4 },
    } as ScheduledRun;
    await store.putJob(job);
    await store.createRun(run);
    const send = vi.fn().mockResolvedValue({ messageIds: ["42"] });
    const append = vi
      .fn()
      .mockRejectedValueOnce(new Error("session busy"))
      .mockResolvedValue(undefined);
    const channel = {
      id: "tg",
      type: "telegram",
      capabilities: { chatTypes: ["direct"] },
      textChunkLimit: 4096,
      start: vi.fn(),
      stop: vi.fn(),
      send,
    } as ChannelAdapter;
    const manager = {
      enqueueSystemOperation: vi.fn(async (_route, operation: () => Promise<void>) => operation()),
    } as unknown as GatewaySessionManager;
    const delivery = new DeliveryService(
      [channel],
      store,
      sessions,
      manager,
      { appendScheduledDelivery: append } as unknown as AgentProtocolAdapter,
      () => new Date("2026-01-01T00:00:00.000Z"),
    );
    const first = await delivery.deliver(job, run);
    expect(first.delivery.status).toBe("delivered");
    expect(first.delivery.originAppendedAt).toBeUndefined();
    const second = await delivery.deliver(job, first);
    expect(second.delivery.originAppendedAt).toBeDefined();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("bounds retries when the configured channel adapter is unavailable", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "novi-delivery-"));
    roots.push(root);
    const owner = {
      key: "gateway:telegram:tg:direct:chat",
      locator: {
        channel: "telegram" as const,
        account: "tg",
        chat: { type: "direct" as const, id: "chat" },
      },
    };
    const sessions = await GatewaySessionStore.open(path.join(root, "sessions.json"));
    await sessions.bind(owner, {
      id: "session",
      cwd: "/workspace",
      path: "/tmp/session.jsonl",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const store = await JobStore.open(path.join(root, "jobs"), "2026-01-01");
    const job = {
      id: "job_1",
      name: "test",
      owner,
      status: "enabled",
      schedule: { kind: "at", atUtc: "2026-01-01T00:00:00.000Z", timezone: "UTC" },
      payload: { kind: "reminder", text: "hello" },
      delivery: { kind: "origin" },
      nextRunAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    } as ScheduledJob;
    let current = {
      version: 1,
      id: "run_1",
      jobId: job.id,
      trigger: "scheduled",
      scheduledFor: "2026-01-01T00:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
      execution: { status: "succeeded", attempt: 1, maxAttempts: 2, result: "stable" },
      delivery: { status: "pending", attempt: 0, maxAttempts: 4 },
    } as ScheduledRun;
    await store.putJob(job);
    await store.createRun(current);
    const delivery = new DeliveryService(
      [],
      store,
      sessions,
      {} as GatewaySessionManager,
      {} as AgentProtocolAdapter,
      () => new Date("2026-01-01T00:00:00.000Z"),
    );

    for (let attempt = 1; attempt <= 4; attempt++) {
      current = await delivery.deliver(job, current);
      expect(current.delivery.attempt).toBe(attempt);
    }
    expect(current.delivery.status).toBe("delivery_failed");
  });
});
