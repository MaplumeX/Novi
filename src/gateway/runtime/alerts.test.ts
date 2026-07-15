import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayAlertManager, GatewayOperationsStore } from "./alerts.js";
import type { GatewayRuntimeSnapshot } from "./snapshot.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function store(): Promise<GatewayOperationsStore> {
  const root = await mkdtemp(path.join(tmpdir(), "novi-alerts-"));
  roots.push(root);
  return GatewayOperationsStore.open(path.join(root, "operations.json"));
}

function snapshot(overrides: Partial<GatewayRuntimeSnapshot> = {}): GatewayRuntimeSnapshot {
  return {
    version: 1,
    instanceId: "instance-1",
    pid: 42,
    state: "degraded",
    health: { live: true, ready: true },
    startedAt: "2026-07-15T00:00:00.000Z",
    observedAt: "2026-07-15T00:00:00.000Z",
    cwd: "/workspace",
    configDigest: "config-1",
    channels: [{ id: "primary", type: "telegram", state: "ready" }],
    sessions: { activeSessions: 0, runningSessions: 0, queuedMessages: 0 },
    messages: {
      version: 1,
      inbox: {
        received: 100,
        processing: 0,
        completed: 0,
        interrupted: 0,
        failed: 0,
        dismissed: 0,
      },
      outbox: { pending: 0, sending: 0, delivered: 0, delivery_failed: 0, dismissed: 0 },
      terminalRecords: 0,
      nonTerminalRecords: 100,
      bytes: 1,
      degraded: false,
      degradedReasons: [],
      oldestPendingAgeMs: 1,
      retryCount: 0,
      exhaustedCount: 0,
    },
    scheduler: { enabled: 0, paused: 0, queuedOrRunning: 0, pendingDelivery: 0 },
    workers: { inbox: { state: "ready" }, outbox: { state: "ready" } },
    metrics: {
      version: 1,
      counters: {
        ingressAccepted: 0,
        ingressDeduped: 0,
        ingressInterrupted: 0,
        agentSucceeded: 0,
        agentFailed: 0,
        deliveryAttempted: 0,
        deliverySucceeded: 0,
        deliveryFailed: 0,
        deliveryRetried: 0,
        alertsEnqueued: 0,
        alertsSuppressed: 0,
      },
      gauges: { queueDepth: 100, oldestPendingAgeMs: 1, readyChannels: 1, failedChannels: 0 },
    },
    degradedReasons: [],
    ...overrides,
  };
}

function options(
  operationsStore: GatewayOperationsStore,
  now: () => Date,
  enqueue: ReturnType<typeof vi.fn>,
) {
  return {
    target: {
      channel: "telegram",
      account: "primary",
      chat: { type: "direct", id: "42" },
    } as const,
    cooldownMs: 3_600_000,
    backlogRecords: 100,
    backlogAgeMs: 900_000,
    channelDownMs: 300_000,
    store: operationsStore,
    validateTarget: async () => true,
    enqueue,
    now,
  };
}

function enqueueSpy(failure?: Error) {
  return vi.fn(async (...args: [unknown, string, string]) => {
    void args;
    if (failure) throw failure;
  });
}

describe("GatewayAlertManager", () => {
  it("persists cooldown across restart and re-alerts after cooldown", async () => {
    const operationsStore = await store();
    let time = Date.parse("2026-07-15T00:00:00.000Z");
    const enqueue = enqueueSpy();
    const manager = new GatewayAlertManager(
      options(operationsStore, () => new Date(time), enqueue),
    );

    await manager.observe(snapshot());
    expect(enqueue).toHaveBeenCalledTimes(1);
    time += 30 * 60_000;
    const reopened = await GatewayOperationsStore.open(operationsStore.filePath);
    const restarted = new GatewayAlertManager(options(reopened, () => new Date(time), enqueue));
    await restarted.observe(snapshot());
    expect(enqueue).toHaveBeenCalledTimes(1);
    time += 31 * 60_000;
    await restarted.observe(snapshot());
    expect(enqueue).toHaveBeenCalledTimes(2);
  });

  it("records resolution and alerts again on a new activation", async () => {
    const operationsStore = await store();
    let time = Date.parse("2026-07-15T00:00:00.000Z");
    const enqueue = enqueueSpy();
    const manager = new GatewayAlertManager(
      options(operationsStore, () => new Date(time), enqueue),
    );
    await manager.observe(snapshot());

    time += 1_000;
    const healthy = snapshot();
    healthy.messages!.nonTerminalRecords = 0;
    healthy.messages!.inbox.received = 0;
    await manager.observe(healthy);
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue.mock.calls[1]![2]).toContain("resolved");

    time += 1_000;
    await manager.observe(snapshot());
    expect(enqueue).toHaveBeenCalledTimes(3);
  });

  it("requires a channel outage to remain active for the threshold", async () => {
    const operationsStore = await store();
    let time = Date.parse("2026-07-15T00:00:00.000Z");
    const enqueue = enqueueSpy();
    const manager = new GatewayAlertManager(
      options(operationsStore, () => new Date(time), enqueue),
    );
    const down = snapshot({
      channels: [{ id: "primary", type: "telegram", state: "failed" }],
    });
    down.messages!.nonTerminalRecords = 0;
    down.messages!.inbox.received = 0;

    await manager.observe(down);
    expect(enqueue).not.toHaveBeenCalled();
    time += 300_000;
    await manager.observe(down);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("marks an invalid target degraded without enqueueing", async () => {
    const operationsStore = await store();
    const enqueue = enqueueSpy();
    const manager = new GatewayAlertManager({
      ...options(operationsStore, () => new Date("2026-07-15T00:00:00.000Z"), enqueue),
      validateTarget: async () => false,
    });

    await manager.observe(snapshot());
    expect(enqueue).not.toHaveBeenCalled();
    expect(manager.getDegradedReasons()).toEqual(["alerts:target_invalid"]);
  });

  it("cooldowns a failed alert enqueue instead of creating a feedback loop", async () => {
    const operationsStore = await store();
    let time = Date.parse("2026-07-15T00:00:00.000Z");
    const enqueue = enqueueSpy(new Error("delivery unavailable"));
    const manager = new GatewayAlertManager(
      options(operationsStore, () => new Date(time), enqueue),
    );
    await manager.observe(snapshot());
    time += 30_000;
    await manager.observe(snapshot());

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(manager.getDegradedReasons()).toEqual(["alerts:enqueue_failed"]);
  });
});
