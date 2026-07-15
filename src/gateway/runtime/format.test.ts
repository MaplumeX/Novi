import { describe, expect, it } from "vitest";
import { formatGatewayStatus, gatewayStatusExitCode, stoppedGatewaySnapshot } from "./format.js";
import type { GatewayRuntimeSnapshot } from "./snapshot.js";

describe("Gateway runtime status formatting", () => {
  it("formats a stable stopped diagnostic", () => {
    const stopped = stoppedGatewaySnapshot();
    expect(formatGatewayStatus(stopped)).toBe(
      "state: stopped\nlive: no\nready: no\nreason: control socket is unavailable\n",
    );
    expect(gatewayStatusExitCode(stopped.state)).toBe(1);
  });

  it("uses the documented status exit codes", () => {
    expect(gatewayStatusExitCode("ready")).toBe(0);
    expect(gatewayStatusExitCode("degraded")).toBe(2);
    expect(gatewayStatusExitCode("starting")).toBe(1);
    expect(gatewayStatusExitCode("unhealthy")).toBe(1);
    expect(gatewayStatusExitCode("stopping")).toBe(1);
  });

  it.each([
    ["starting", 1],
    ["ready", 0],
    ["degraded", 2],
    ["unhealthy", 1],
    ["stopping", 1],
  ] as const)("formats the %s fixture with a stable state and exit code", (state, exitCode) => {
    const snapshot = fixture(state);
    const output = formatGatewayStatus(snapshot);
    expect(output).toContain(`state: ${state}\n`);
    expect(output).toContain(`ready: ${snapshot.health.ready ? "yes" : "no"}\n`);
    expect(output).not.toContain("secret message body");
    expect(JSON.parse(JSON.stringify(snapshot))).toMatchObject({ version: 1, state });
    expect(gatewayStatusExitCode(state)).toBe(exitCode);
  });
});

function fixture(state: GatewayRuntimeSnapshot["state"]): GatewayRuntimeSnapshot {
  return {
    version: 1,
    instanceId: "instance-1",
    pid: 42,
    state,
    health: { live: true, ready: state === "ready" || state === "degraded" },
    startedAt: "2026-07-15T00:00:00.000Z",
    observedAt: "2026-07-15T00:01:00.000Z",
    cwd: "/workspace",
    configDigest: "config-1",
    channels: [{ id: "primary", type: "telegram", state: "ready" }],
    sessions: { activeSessions: 1, runningSessions: 0, queuedMessages: 0 },
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
      gauges: { queueDepth: 0, oldestPendingAgeMs: 0, readyChannels: 1, failedChannels: 0 },
    },
    degradedReasons: state === "degraded" ? ["channel:secondary:failed"] : [],
  };
}
