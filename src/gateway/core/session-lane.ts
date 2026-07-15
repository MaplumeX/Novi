import type {
  ChannelAdapter,
  ChannelMessage,
  AgentProtocolAdapter,
  GatewaySessionRoute,
} from "./types.js";
import type { QueueMode } from "../config.js";
import { isSilentReply } from "./routing.js";
import { channelTargetForMessage } from "./routing.js";
import type { GatewayMetrics } from "../runtime/metrics.js";

/** A queued inbound message awaiting dispatch after the current run. */
export interface QueuedMessage {
  kind?: "message";
  channel: ChannelAdapter;
  msg: ChannelMessage;
  mode: QueueMode;
}

export interface QueuedSystemOperation {
  kind: "system-operation";
  run: () => Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
}

type QueuedLaneEntry = QueuedMessage | QueuedSystemOperation;

/**
 * Per-sessionKey lane: guarantees serial harness execution (one run at a time)
 * and implements the queue-mode dispatch (steer / followup / interrupt).
 *
 * Slash commands never reach the lane — `GatewayApp` handles them inline
 * before calling `enqueue`. The lane only deals with normal user messages.
 */
export interface SessionLane {
  readonly route: GatewaySessionRoute;
  status: "idle" | "running";
  /** Messages queued for after the current run (interrupt entries only). */
  queue: QueuedLaneEntry[];
  lastActivity: number;
}

export async function enqueueSystemOperation(
  lane: SessionLane,
  operation: () => Promise<void>,
): Promise<void> {
  lane.lastActivity = Date.now();
  if (lane.status === "idle") {
    await runSystemOperation(lane, operation);
    return;
  }
  await new Promise<void>((resolve, reject) => {
    lane.queue.push({ kind: "system-operation", run: operation, resolve, reject });
  });
}

/** Create a fresh, idle lane for a session key. */
export function createSessionLane(route: GatewaySessionRoute): SessionLane {
  return {
    route,
    status: "idle",
    queue: [],
    lastActivity: Date.now(),
  };
}

/**
 * Enqueue a message and process it according to the queue mode.
 *
 * Dispatch logic (design.md §3.4):
 * - **idle**: start a new turn immediately via `agent.runTurn`.
 * - **running** + `steer`: inject into the current turn via `agent.steer`.
 *   If steer throws (run not steerable), fall back to `agent.followUp`.
 * - **running** + `followup`: queue via `agent.followUp` (harness internal
 *   queue handles delivery within the current run).
 * - **running** + `interrupt`: abort the current run, then queue the message
 *   so it starts a fresh turn once the aborted run settles.
 *
 * Only `interrupt` messages are stored in the lane queue — steer/followup are
 * forwarded to the harness immediately and never enqueued locally.
 */
export async function enqueueMessage(
  lane: SessionLane,
  agent: AgentProtocolAdapter,
  entry: QueuedMessage,
  metrics?: GatewayMetrics,
): Promise<void> {
  lane.lastActivity = Date.now();

  if (lane.status === "idle") {
    await runTurn(lane, agent, entry, metrics);
    return;
  }

  // Running — dispatch by mode.
  const { mode, msg } = entry;

  if (mode === "steer") {
    try {
      await agent.steer(lane.route, msg.text);
      return;
    } catch {
      // Steer not accepted — fall back to followUp.
      try {
        await agent.followUp(lane.route, msg.text);
      } catch {
        // Both failed — queue for after the run.
        lane.queue.push({ ...entry, mode: "interrupt" });
      }
      return;
    }
  }

  if (mode === "followup") {
    try {
      await agent.followUp(lane.route, msg.text);
      return;
    } catch {
      // followUp failed — queue for after the run.
      lane.queue.push({ ...entry, mode: "interrupt" });
    }
    return;
  }

  // interrupt: abort the current run, then queue for a fresh turn.
  try {
    await agent.abort(lane.route);
  } catch {
    // Abort failed — still queue; the current run will end on its own.
  }
  metrics?.increment("ingressInterrupted");
  lane.queue.push(entry);
}

/**
 * Run a single turn, then drain any queued interrupt messages.
 *
 * Wires channel callbacks so streaming events are forwarded to the channel
 * during the turn. After the turn ends, processes queued messages in order
 * (each starts a fresh `runTurn`).
 */
async function runTurn(
  lane: SessionLane,
  agent: AgentProtocolAdapter,
  entry: QueuedMessage,
  metrics?: GatewayMetrics,
): Promise<void> {
  const { channel, msg } = entry;
  lane.status = "running";
  lane.lastActivity = Date.now();

  const target = channelTargetForMessage(msg);
  let silentCandidate = "";
  let silentPending = true;
  const callbacks = {
    onTextDelta: async (delta: string) => {
      if (silentPending) {
        silentCandidate += delta;
        if (isSilentPrefix(silentCandidate)) return;
        silentPending = false;
        await channel.sendEvent?.(target, { type: "text-delta", delta: silentCandidate });
        return;
      }
      await channel.sendEvent?.(target, { type: "text-delta", delta });
    },
    onReasoningDelta: async (delta: string) => {
      await channel.sendEvent?.(target, { type: "reasoning-delta", delta });
    },
    onToolEvent: async (event: import("../../tools/events.js").NoviToolEvent) => {
      await channel.sendEvent?.(target, {
        type: "tool-event",
        event,
      });
    },
    onTyping: async () => {
      await channel.sendTyping?.(target);
    },
    onTurnEnd: async (text: string) => {
      if (isSilentReply(text)) await channel.cancelStream?.(target);
      else await channel.send(target, text);
    },
  };

  try {
    await agent.runTurn({ route: lane.route, text: msg.text, callbacks });
    metrics?.increment("agentSucceeded");
  } catch (e) {
    metrics?.increment("agentFailed");
    const message = e instanceof Error ? e.message : String(e);
    await channel.send(target, `Error: ${message}`).catch(() => {});
  } finally {
    lane.lastActivity = Date.now();
  }

  // Drain queue: each queued (interrupt) message starts a fresh turn.
  if (lane.queue.length > 0) {
    const next = lane.queue.shift()!;
    if (next.kind === "system-operation") {
      try {
        await next.run();
        next.resolve();
      } catch (error) {
        next.reject(error);
      }
      await drainQueue(lane, agent, metrics);
    } else {
      await runTurn(lane, agent, next, metrics);
    }
    return;
  }

  lane.status = "idle";
  lane.lastActivity = Date.now();
}

async function runSystemOperation(
  lane: SessionLane,
  operation: () => Promise<void>,
): Promise<void> {
  lane.status = "running";
  try {
    await operation();
  } finally {
    lane.lastActivity = Date.now();
    lane.status = "idle";
  }
}

async function drainQueue(
  lane: SessionLane,
  agent: AgentProtocolAdapter,
  metrics?: GatewayMetrics,
): Promise<void> {
  const next = lane.queue.shift();
  if (!next) {
    lane.status = "idle";
    lane.lastActivity = Date.now();
    return;
  }
  if (next.kind === "system-operation") {
    try {
      await next.run();
      next.resolve();
    } catch (error) {
      next.reject(error);
    }
    await drainQueue(lane, agent, metrics);
    return;
  }
  await runTurn(lane, agent, next, metrics);
}

const SILENT_MARKERS = ["SILENT", "[SILENT]", "NO_REPLY", "NO REPLY"];
function isSilentPrefix(text: string): boolean {
  return SILENT_MARKERS.some((marker) => marker.startsWith(text.trim().toUpperCase()));
}
