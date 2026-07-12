import type { ChannelAdapter, ChannelMessage, AgentProtocolAdapter } from "./types.js";
import type { QueueMode } from "../config.js";
import { createSessionLane, enqueueMessage, type SessionLane } from "./session-lane.js";

/** Constructor options for {@link GatewaySessionManager}. */
export interface GatewaySessionManagerOptions {
  agent: AgentProtocolAdapter;
  /** Idle timeout in ms before a lane is evicted (default 24h). */
  idleTimeoutMs: number;
  /** Max concurrent sessions; oldest idle is evicted when exceeded. */
  maxConcurrentSessions: number;
  /** Default queue mode for messages arriving mid-turn. */
  queueMode: QueueMode;
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
  private readonly lanes = new Map<string, SessionLane>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: GatewaySessionManagerOptions) {
    this.agent = options.agent;
    this.idleTimeoutMs = options.idleTimeoutMs;
    this.maxConcurrentSessions = options.maxConcurrentSessions;
    this.queueMode = options.queueMode;
  }

  /**
   * Route an inbound message to the lane for `sessionKey`, creating the lane
   * if needed (with max-concurrent eviction).
   */
  async enqueue(
    sessionKey: string,
    channel: ChannelAdapter,
    msg: ChannelMessage,
    queueMode?: QueueMode,
  ): Promise<void> {
    const lane = this.getOrCreate(sessionKey);
    const mode = queueMode ?? this.queueMode;
    await enqueueMessage(lane, this.agent, { channel, msg, mode });
  }

  /** Get or lazily create the lane for a session key. */
  getOrCreate(sessionKey: string): SessionLane {
    let lane = this.lanes.get(sessionKey);
    if (lane) return lane;

    // Enforce max concurrent: evict oldest idle lane if at capacity.
    if (this.lanes.size >= this.maxConcurrentSessions) {
      this.evictOldestIdle();
    }

    lane = createSessionLane(sessionKey);
    this.lanes.set(sessionKey, lane);
    return lane;
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
    const keys = [...this.lanes.keys()];
    this.lanes.clear();
    await Promise.allSettled(keys.map((key) => this.agent.closeSession(key)));
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
    const toClose: string[] = [];
    for (const [key, lane] of this.lanes) {
      if (lane.status === "running") continue;
      if (now - lane.lastActivity > this.idleTimeoutMs) {
        toClose.push(key);
      }
    }
    for (const key of toClose) {
      this.lanes.delete(key);
      await this.agent.closeSession(key).catch(() => {});
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
      this.lanes.delete(oldestKey);
      void this.agent.closeSession(oldestKey).catch(() => {});
    }
  }
}
