import type { ChannelAdapter, ChannelMessage, AgentProtocolAdapter } from "./types.js";
import type { QueueMode } from "../config.js";
import { isSilentReply } from "./routing.js";

/** A queued inbound message awaiting dispatch after the current run. */
export interface QueuedMessage {
  channel: ChannelAdapter;
  msg: ChannelMessage;
  mode: QueueMode;
}

/**
 * Per-sessionKey lane: guarantees serial harness execution (one run at a time)
 * and implements the queue-mode dispatch (steer / followup / interrupt).
 *
 * Slash commands never reach the lane — `GatewayApp` handles them inline
 * before calling `enqueue`. The lane only deals with normal user messages.
 */
export interface SessionLane {
  readonly sessionKey: string;
  status: "idle" | "running";
  /** Messages queued for after the current run (interrupt entries only). */
  queue: QueuedMessage[];
  lastActivity: number;
}

/** Create a fresh, idle lane for a session key. */
export function createSessionLane(sessionKey: string): SessionLane {
  return {
    sessionKey,
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
): Promise<void> {
  lane.lastActivity = Date.now();

  if (lane.status === "idle") {
    await runTurn(lane, agent, entry);
    return;
  }

  // Running — dispatch by mode.
  const { mode, msg } = entry;

  if (mode === "steer") {
    try {
      await agent.steer(lane.sessionKey, msg.text);
      return;
    } catch {
      // Steer not accepted — fall back to followUp.
      try {
        await agent.followUp(lane.sessionKey, msg.text);
      } catch {
        // Both failed — queue for after the run.
        lane.queue.push({ ...entry, mode: "interrupt" });
      }
      return;
    }
  }

  if (mode === "followup") {
    try {
      await agent.followUp(lane.sessionKey, msg.text);
      return;
    } catch {
      // followUp failed — queue for after the run.
      lane.queue.push({ ...entry, mode: "interrupt" });
    }
    return;
  }

  // interrupt: abort the current run, then queue for a fresh turn.
  try {
    await agent.abort(lane.sessionKey);
  } catch {
    // Abort failed — still queue; the current run will end on its own.
  }
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
): Promise<void> {
  const { channel, msg } = entry;
  lane.status = "running";
  lane.lastActivity = Date.now();

  const chatId = msg.remoteChatId;
  let silentCandidate = "";
  let silentPending = true;
  const callbacks = {
    onTextDelta: async (delta: string) => {
      if (silentPending) {
        silentCandidate += delta;
        if (isSilentPrefix(silentCandidate)) return;
        silentPending = false;
        await channel.sendEvent?.(chatId, { type: "text-delta", delta: silentCandidate });
        return;
      }
      await channel.sendEvent?.(chatId, { type: "text-delta", delta });
    },
    onReasoningDelta: async (delta: string) => {
      await channel.sendEvent?.(chatId, { type: "reasoning-delta", delta });
    },
    onToolEvent: async (event: import("../../tools/events.js").NoviToolEvent) => {
      await channel.sendEvent?.(chatId, {
        type: "tool-event",
        event,
      });
    },
    onTyping: async () => {
      await channel.sendTyping?.(chatId);
    },
    onTurnEnd: async (text: string) => {
      if (isSilentReply(text)) await channel.cancelStream?.(chatId);
      else await channel.send(chatId, text);
    },
  };

  try {
    await agent.runTurn({ sessionKey: lane.sessionKey, text: msg.text, callbacks });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await channel.send(chatId, `Error: ${message}`).catch(() => {});
  } finally {
    lane.lastActivity = Date.now();
  }

  // Drain queue: each queued (interrupt) message starts a fresh turn.
  if (lane.queue.length > 0) {
    const next = lane.queue.shift()!;
    await runTurn(lane, agent, next);
    return;
  }

  lane.status = "idle";
  lane.lastActivity = Date.now();
}

const SILENT_MARKERS = ["SILENT", "[SILENT]", "NO_REPLY", "NO REPLY"];
function isSilentPrefix(text: string): boolean {
  return SILENT_MARKERS.some((marker) => marker.startsWith(text.trim().toUpperCase()));
}
