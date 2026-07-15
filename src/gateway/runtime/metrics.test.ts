import { describe, expect, it } from "vitest";
import { GatewayMetrics } from "./metrics.js";

describe("GatewayMetrics", () => {
  it("accumulates process counters and samples live gauges", () => {
    const metrics = new GatewayMetrics();
    metrics.increment("ingressAccepted");
    metrics.increment("deliveryAttempted", 2);

    expect(
      metrics.snapshot({
        queueDepth: 3,
        oldestPendingAgeMs: 500,
        readyChannels: 1,
        failedChannels: 0,
      }),
    ).toMatchObject({
      version: 1,
      counters: { ingressAccepted: 1, deliveryAttempted: 2, deliverySucceeded: 0 },
      gauges: { queueDepth: 3, oldestPendingAgeMs: 500 },
    });
  });

  it("rejects invalid increments", () => {
    const metrics = new GatewayMetrics();
    expect(() => metrics.increment("agentFailed", -1)).toThrow(/non-negative integer/);
    expect(() => metrics.increment("agentFailed", 0.5)).toThrow(/non-negative integer/);
  });
});
