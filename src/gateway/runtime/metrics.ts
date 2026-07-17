export type GatewayCounterName =
  | "ingressAccepted"
  | "ingressDeduped"
  | "ingressInterrupted"
  | "agentSucceeded"
  | "agentFailed"
  | "deliveryAttempted"
  | "deliverySucceeded"
  | "deliveryFailed"
  | "deliveryRetried"
  | "alertsEnqueued"
  | "alertsSuppressed";

export interface GatewayMetricSnapshot {
  version: 1;
  counters: Record<GatewayCounterName, number>;
  gauges: {
    queueDepth: number;
    oldestPendingAgeMs: number;
    readyChannels: number;
    failedChannels: number;
    agentQueued?: number;
    agentRunning?: number;
    agentInterrupted?: number;
    agentPendingCompletion?: number;
  };
}

const COUNTERS: GatewayCounterName[] = [
  "ingressAccepted",
  "ingressDeduped",
  "ingressInterrupted",
  "agentSucceeded",
  "agentFailed",
  "deliveryAttempted",
  "deliverySucceeded",
  "deliveryFailed",
  "deliveryRetried",
  "alertsEnqueued",
  "alertsSuppressed",
];

/** Process-lifetime counters plus live gauges supplied by the runtime snapshot. */
export class GatewayMetrics {
  readonly #counters = new Map<GatewayCounterName, number>(COUNTERS.map((name) => [name, 0]));

  increment(name: GatewayCounterName, amount = 1): void {
    if (!Number.isSafeInteger(amount) || amount < 0)
      throw new Error("metric increment must be a non-negative integer");
    this.#counters.set(name, (this.#counters.get(name) ?? 0) + amount);
  }

  snapshot(gauges: GatewayMetricSnapshot["gauges"]): GatewayMetricSnapshot {
    return {
      version: 1,
      counters: Object.fromEntries(
        COUNTERS.map((name) => [name, this.#counters.get(name) ?? 0]),
      ) as Record<GatewayCounterName, number>,
      gauges: { ...gauges },
    };
  }
}
