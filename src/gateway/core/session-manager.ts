import type {
  ChannelAdapter,
  ChannelMessage,
  AgentProtocolAdapter,
  GatewaySessionRoute,
} from "./types.js";
import type { QueueMode } from "../config.js";
import {
  createSessionLane,
  enqueueMessage,
  enqueueSystemOperation,
  discardQueuedEntries,
  type SessionLane,
} from "./session-lane.js";
import type { GatewayMetrics } from "../runtime/metrics.js";

/** Constructor options for {@link GatewaySessionManager}. */
export interface GatewaySessionManagerOptions {
  agent: AgentProtocolAdapter;
  /** Idle timeout in ms before a lane is evicted (default 24h). */
  idleTimeoutMs: number;
  /** Max concurrent sessions; oldest idle is evicted when exceeded. */
  maxConcurrentSessions: number;
  /** Default queue mode for messages arriving mid-turn. */
  queueMode: QueueMode;
  metrics?: GatewayMetrics;
}

/**
 * Manages per-sessionKey lanes with lazy creation, idle-timeout eviction, and
 * max-concurrent eviction.
 *
 * Each lane wraps a `SessionLane` (serial queue + dispatch) backed by an
 * `AgentProtocolAdapter` harness. The manager periodically scans for idle
 * lanes past their timeout and closes them via `agent.closeSession`.
 *
 * Design (design.md §3.5):
 * - `getOrCreate(sessionKey)`: lazy-create lane on first inbound message.
 * - Idle timeout: scan every 2 min (unref'd), close lanes idle longer than
 *   `idleTimeoutMs` that are not actively processing.
 * - maxConcurrent: when at capacity, evict the oldest idle (non-running) lane.
 * - `stop()`: clear timer, close all sessions.
 */
export class GatewaySessionManager {
  private readonly agent: AgentProtocolAdapter;
  private readonly idleTimeoutMs: number;
  private readonly maxConcurrentSessions: number;
  private readonly queueMode: QueueMode;
  private readonly metrics: GatewayMetrics | undefined;
  private readonly lanes = new Map<string, SessionLane>();
  private readonly resets = new Map<string, Promise<void>>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: GatewaySessionManagerOptions) {
    this.agent = options.agent;
    this.idleTimeoutMs = options.idleTimeoutMs;
    this.maxConcurrentSessions = options.maxConcurrentSessions;
    this.queueMode = options.queueMode;
    this.metrics = options.metrics;
  }

  /**
   * Route an inbound message to the lane for `sessionKey`, creating the lane
   * if needed (with max-concurrent eviction).
   */
  async enqueue(
    route: GatewaySessionRoute,
    channel: ChannelAdapter,
    msg: ChannelMessage,
    queueMode?: QueueMode,
  ): Promise<void> {
    const resetting = this.resets.get(route.key);
    if (resetting) await resetting.catch(() => {});
    const lane = this.getOrCreate(route);
    const mode = queueMode ?? this.queueMode;
    await enqueueMessage(lane, this.agent, { channel, msg, mode }, this.metrics);
  }

  async enqueueSystemOperation(
    route: GatewaySessionRoute,
    operation: () => Promise<void>,
  ): Promise<void> {
    const resetting = this.resets.get(route.key);
    if (resetting) await resetting.catch(() => undefined);
    await enqueueSystemOperation(this.getOrCreate(route), operation);
  }

  /** Get or lazily create the lane for a session key. */
  getOrCreate(route: GatewaySessionRoute): SessionLane {
    let lane = this.lanes.get(route.key);
    if (lane) return lane;

    // Enforce max concurrent: evict oldest idle lane if at capacity.
    if (this.lanes.size >= this.maxConcurrentSessions) {
      this.evictOldestIdle();
    }

    lane = createSessionLane(route);
    this.lanes.set(route.key, lane);
    return lane;
  }

  /**
   * Force a fresh session for a route. The barrier is published before any
   * asynchronous work, so later messages wait and can only enter the new
   * session. Locally queued messages from the old generation are discarded.
   */
  async reset(route: GatewaySessionRoute): Promise<void> {
    const previous = this.resets.get(route.key);
    const operation = (async () => {
      if (previous) await previous.catch(() => {});
      const lane = this.lanes.get(route.key);
      if (lane)
        discardQueuedEntries(lane, new Error("session generation reset before queued operation"));
      try {
        await this.agent.resetSession(route);
      } finally {
        if (lane) {
          discardQueuedEntries(
            lane,
            new Error("session generation reset before queued operation"),
          );
          lane.status = "idle";
          lane.lastActivity = Date.now();
        }
      }
    })();
    this.resets.set(route.key, operation);
    try {
      await operation;
    } finally {
      if (this.resets.get(route.key) === operation) this.resets.delete(route.key);
    }
  }

  /** Start the periodic cleanup timer (2-min interval, unref'd). */
  startCleanupTimer(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => {
      void this.evictIdle();
    }, 120_000);
    this.cleanupTimer.unref();
  }

  /** Stop the manager: clear timer and close all sessions. */
  async stop(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    await Promise.allSettled([...this.resets.values()]);
    const routes = [...this.lanes.values()].map((lane) => lane.route);
    this.lanes.clear();
    await Promise.allSettled(routes.map((route) => this.agent.closeSession(route)));
  }

  /** Safe state summary for gateway diagnostics. */
  getStats(): { activeSessions: number; runningSessions: number; queuedMessages: number } {
    let runningSessions = 0;
    let queuedMessages = 0;
    for (const lane of this.lanes.values()) {
      if (lane.status === "running") runningSessions++;
      queuedMessages += lane.queue.length;
    }
    return { activeSessions: this.lanes.size, runningSessions, queuedMessages };
  }

  /** Close idle lanes that have exceeded the idle timeout. */
  private async evictIdle(): Promise<void> {
    const now = Date.now();
    const toClose: GatewaySessionRoute[] = [];
    for (const lane of this.lanes.values()) {
      if (lane.status === "running") continue;
      if (now - lane.lastActivity > this.idleTimeoutMs) {
        toClose.push(lane.route);
      }
    }
    for (const route of toClose) {
      this.lanes.delete(route.key);
      await this.agent.closeSession(route).catch(() => {});
    }
  }

  /** Evict the oldest idle (non-running) lane to make room. */
  private evictOldestIdle(): void {
    let oldestKey: string | null = null;
    let oldestActivity = Infinity;
    for (const [key, lane] of this.lanes) {
      if (lane.status === "running") continue;
      if (lane.lastActivity < oldestActivity) {
        oldestActivity = lane.lastActivity;
        oldestKey = key;
      }
    }
    if (oldestKey) {
      const route = this.lanes.get(oldestKey)?.route;
      this.lanes.delete(oldestKey);
      if (route) void this.agent.closeSession(route).catch(() => {});
    }
  }
}
