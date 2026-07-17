import { describe, expect, it } from "vitest";
import {
  GatewayRuntimeMonitor,
  runtimeFailure,
  type GatewayMessageRuntime,
  type GatewayRuntimeComponents,
} from "./snapshot.js";
import type { AgentRunRuntimeStats } from "../../agents/runtime.js";

const EMPTY_MESSAGES: GatewayMessageRuntime = {
  version: 1,
  inbox: {
    received: 0,
    processing: 0,
    completed: 0,
    failed: 0,
    interrupted: 0,
    dismissed: 0,
  },
  outbox: {
    pending: 0,
    sending: 0,
    delivered: 0,
    delivery_failed: 0,
    dismissed: 0,
  },
  terminalRecords: 0,
  nonTerminalRecords: 0,
  bytes: 0,
  degraded: false,
  degradedReasons: [],
  oldestPendingAgeMs: 0,
  retryCount: 0,
  exhaustedCount: 0,
};

function components(): GatewayRuntimeComponents {
  return {
    channels: [{ id: "primary", type: "telegram", state: "ready" }],
    sessions: { activeSessions: 1, runningSessions: 0, queuedMessages: 0 },
    messages: structuredClone(EMPTY_MESSAGES),
    workers: { inbox: { state: "ready" }, outbox: { state: "ready" } },
  };
}

function monitor(
  current: GatewayRuntimeComponents,
  agentRunStats?: () => Promise<AgentRunRuntimeStats>,
): GatewayRuntimeMonitor {
  return new GatewayRuntimeMonitor({
    components: () => current,
    schedulerStats: async () => ({
      enabled: 1,
      paused: 0,
      queuedOrRunning: 0,
      pendingDelivery: 0,
    }),
    now: () => new Date("2026-07-15T00:00:00.000Z"),
    instanceId: "instance-1",
    pid: 42,
    cwd: "/workspace",
    configDigest: "config-1",
    metrics: (value) => ({
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
      gauges: {
        queueDepth: value.messages?.nonTerminalRecords ?? 0,
        oldestPendingAgeMs: value.messages?.oldestPendingAgeMs ?? 0,
        readyChannels: value.channels.filter((channel) => channel.state === "ready").length,
        failedChannels: value.channels.filter((channel) => channel.state === "failed").length,
      },
    }),
    ...(agentRunStats ? { agentRunStats } : {}),
  });
}

describe("GatewayRuntimeMonitor", () => {
  it("publishes starting, ready, and stopping lifecycle states", async () => {
    const runtime = monitor(components());
    await expect(runtime.snapshot()).resolves.toMatchObject({
      version: 1,
      state: "starting",
      health: { live: true, ready: false },
      instanceId: "instance-1",
      pid: 42,
    });

    runtime.markRunning();
    await expect(runtime.snapshot()).resolves.toMatchObject({
      state: "ready",
      health: { live: true, ready: true },
    });
    runtime.markStopping();
    await expect(runtime.snapshot()).resolves.toMatchObject({
      state: "stopping",
      health: { live: true, ready: false },
    });
  });

  it("degrades when one of multiple channels is unavailable", async () => {
    const current = components();
    current.channels.push({ id: "secondary", type: "telegram", state: "failed" });
    const runtime = monitor(current);
    runtime.markRunning();

    await expect(runtime.snapshot()).resolves.toMatchObject({
      state: "degraded",
      health: { live: true, ready: true },
      degradedReasons: ["channel:secondary:failed"],
    });
  });

  it("is unhealthy without an available channel or with a critical worker failure", async () => {
    const noChannel = components();
    noChannel.channels[0]!.state = "failed";
    const runtime = monitor(noChannel);
    runtime.markRunning();
    await expect(runtime.snapshot()).resolves.toMatchObject({
      state: "unhealthy",
      health: { live: true, ready: false },
    });

    const workerFailure = components();
    workerFailure.workers.outbox = {
      state: "failed",
      failure: { code: "RUNTIME_FAILURE", message: "worker stopped" },
    };
    const failedRuntime = monitor(workerFailure);
    failedRuntime.markRunning();
    await expect(failedRuntime.snapshot()).resolves.toMatchObject({
      state: "unhealthy",
      degradedReasons: ["worker:outbox:failed"],
    });
  });

  it("surfaces message-store degradation without exposing message bodies", async () => {
    const current = components();
    current.messages!.degraded = true;
    current.messages!.degradedReasons = ["message_store_byte_limit_exceeded"];
    const runtime = monitor(current);
    runtime.markRunning();
    const snapshot = await runtime.snapshot();

    expect(snapshot.state).toBe("degraded");
    expect(snapshot.degradedReasons).toEqual(["messages:message_store_byte_limit_exceeded"]);
    expect(JSON.stringify(snapshot)).not.toContain("message.text");
  });

  it("redacts and bounds runtime error summaries", () => {
    const failure = runtimeFailure(
      new Error(`token=super-secret ${"x".repeat(500)}`),
      "CHANNEL_FAILURE",
    );
    expect(failure.code).toBe("CHANNEL_FAILURE");
    expect(failure.message).not.toContain("super-secret");
    expect(failure.message.length).toBeLessThanOrEqual(240);
  });

  it("includes bounded child-agent aggregates without result bodies", async () => {
    const runtime = monitor(components(), async () => ({
      total: 4,
      queued: 1,
      running: 2,
      interrupted: 1,
      pendingCompletion: 1,
      deliveryFailed: 0,
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        cost: 0.01,
      },
    }));
    const snapshot = await runtime.snapshot();
    expect(snapshot.agentRuns).toMatchObject({ running: 2, queued: 1, pendingCompletion: 1 });
    expect(JSON.stringify(snapshot)).not.toContain("child result body");
  });
});
