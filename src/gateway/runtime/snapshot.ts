import { randomUUID } from "node:crypto";
import { redactAndBoundError } from "../messages/errors.js";
import type { MessageStoreSnapshot } from "../messages/store.js";
import type { SchedulerStats } from "../jobs/scheduler.js";
import type { GatewayMetricSnapshot } from "./metrics.js";
import type { AgentRunRuntimeStats } from "../../agents/runtime.js";

export type GatewayRuntimeState = "starting" | "ready" | "degraded" | "unhealthy" | "stopping";
export type GatewayChannelState = "starting" | "ready" | "failed" | "stopped";

export interface RuntimeFailureSummary {
  code: string;
  message: string;
}

export interface GatewayChannelRuntime {
  id: string;
  type: string;
  state: GatewayChannelState;
  failure?: RuntimeFailureSummary;
}

export interface GatewayWorkerRuntime {
  state: "ready" | "failed" | "stopped";
  failure?: RuntimeFailureSummary;
}

export interface GatewayRuntimeComponents {
  channels: GatewayChannelRuntime[];
  sessions: { activeSessions: number; runningSessions: number; queuedMessages: number };
  messages?: GatewayMessageRuntime;
  workers: {
    inbox: GatewayWorkerRuntime;
    outbox: GatewayWorkerRuntime;
  };
}

export interface GatewayMessageRuntime extends MessageStoreSnapshot {
  oldestPendingAgeMs: number;
  retryCount: number;
  exhaustedCount: number;
}

export interface GatewayRuntimeSnapshot {
  version: 1;
  instanceId: string;
  pid: number;
  state: GatewayRuntimeState;
  health: { live: boolean; ready: boolean };
  startedAt: string;
  observedAt: string;
  cwd: string;
  configDigest: string;
  channels: GatewayChannelRuntime[];
  sessions: GatewayRuntimeComponents["sessions"];
  messages?: GatewayMessageRuntime;
  agentRuns?: AgentRunRuntimeStats;
  scheduler?: SchedulerStats;
  workers: GatewayRuntimeComponents["workers"];
  metrics: GatewayMetricSnapshot;
  degradedReasons: string[];
}

export interface GatewayRuntimeMonitorOptions {
  components: () => GatewayRuntimeComponents;
  schedulerStats: () => Promise<SchedulerStats>;
  now?: () => Date;
  instanceId?: string;
  pid?: number;
  cwd: string;
  configDigest: string;
  metrics: (
    components: GatewayRuntimeComponents,
    agentRuns?: AgentRunRuntimeStats,
  ) => GatewayMetricSnapshot;
  agentRunStats?: () => Promise<AgentRunRuntimeStats>;
  degradationReasons?: () => string[];
}

/** Aggregates live component state into one immutable, versioned operator snapshot. */
export class GatewayRuntimeMonitor {
  readonly #options: GatewayRuntimeMonitorOptions;
  readonly #startedAt: string;
  readonly #instanceId: string;
  #phase: "starting" | "running" | "stopping" = "starting";

  constructor(options: GatewayRuntimeMonitorOptions) {
    this.#options = options;
    this.#startedAt = (options.now ?? (() => new Date()))().toISOString();
    this.#instanceId = options.instanceId ?? randomUUID();
  }

  markRunning(): void {
    if (this.#phase !== "stopping") this.#phase = "running";
  }

  markStopping(): void {
    this.#phase = "stopping";
  }

  async snapshot(): Promise<GatewayRuntimeSnapshot> {
    const components = this.#options.components();
    let scheduler: SchedulerStats | undefined;
    let schedulerFailure = false;
    let agentRuns: AgentRunRuntimeStats | undefined;
    let agentRunsFailure = false;
    try {
      scheduler = await this.#options.schedulerStats();
    } catch {
      schedulerFailure = true;
    }
    try {
      agentRuns = await this.#options.agentRunStats?.();
    } catch {
      agentRunsFailure = true;
    }

    const degradedReasons = [
      ...new Set([
        ...collectReasons(components, schedulerFailure, agentRunsFailure),
        ...(this.#options.degradationReasons?.() ?? []),
      ]),
    ].sort();
    const state = evaluateState(this.#phase, components, schedulerFailure, degradedReasons);
    return {
      version: 1,
      instanceId: this.#instanceId,
      pid: this.#options.pid ?? process.pid,
      state,
      health: { live: true, ready: state === "ready" || state === "degraded" },
      startedAt: this.#startedAt,
      observedAt: (this.#options.now ?? (() => new Date()))().toISOString(),
      cwd: this.#options.cwd,
      configDigest: this.#options.configDigest,
      channels: structuredClone(components.channels),
      sessions: { ...components.sessions },
      ...(components.messages === undefined
        ? {}
        : { messages: structuredClone(components.messages) }),
      ...(scheduler === undefined ? {} : { scheduler: { ...scheduler } }),
      ...(agentRuns === undefined ? {} : { agentRuns: structuredClone(agentRuns) }),
      workers: structuredClone(components.workers),
      metrics: this.#options.metrics(components, agentRuns),
      degradedReasons,
    };
  }
}

export function runtimeFailure(error: unknown, code = "RUNTIME_FAILURE"): RuntimeFailureSummary {
  return { code, message: redactAndBoundError(error, 240) || "runtime operation failed" };
}

function evaluateState(
  phase: "starting" | "running" | "stopping",
  components: GatewayRuntimeComponents,
  schedulerFailure: boolean,
  degradedReasons: string[],
): GatewayRuntimeState {
  if (phase === "starting") return "starting";
  if (phase === "stopping") return "stopping";
  const availableChannels = components.channels.filter(
    (channel) => channel.state === "ready",
  ).length;
  const criticalWorkerFailure =
    schedulerFailure ||
    components.workers.inbox.state === "failed" ||
    components.workers.outbox.state === "failed";
  if (availableChannels === 0 || criticalWorkerFailure) return "unhealthy";
  return degradedReasons.length > 0 ? "degraded" : "ready";
}

function collectReasons(
  components: GatewayRuntimeComponents,
  schedulerFailure: boolean,
  agentRunsFailure: boolean,
): string[] {
  const reasons = new Set<string>();
  for (const channel of components.channels) {
    if (channel.state !== "ready") reasons.add(`channel:${channel.id}:${channel.state}`);
  }
  if (components.workers.inbox.state === "failed") reasons.add("worker:inbox:failed");
  if (components.workers.outbox.state === "failed") reasons.add("worker:outbox:failed");
  if (schedulerFailure) reasons.add("scheduler:unavailable");
  if (agentRunsFailure) reasons.add("agents:unavailable");
  for (const reason of components.messages?.degradedReasons ?? [])
    reasons.add(`messages:${reason}`);
  return [...reasons].sort();
}
