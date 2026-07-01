import { useEffect, useState } from "react";
import type {
  AgentHarness,
  AgentMessage,
  Session,
  ThinkingLevel,
} from "@earendil-works/pi-agent-core/node";
import type { JsonlSessionMetadata } from "@earendil-works/pi-agent-core/node";
import type { Api, Model } from "@earendil-works/pi-ai";

export type Phase = "idle" | "turn";

/** Lightweight view of an in-flight tool call, for streaming display. */
export interface ToolCallView {
  id: string;
  name: string;
  status: "running" | "done" | "error";
}

/** Queue lengths surfaced from `queue_update` events. */
export interface QueueState {
  steer: number;
  followUp: number;
  nextTurn: number;
}

export interface HarnessState {
  /** High-level run phase. "turn" while a prompt is in flight. */
  phase: Phase;
  /** Full conversation history (seeded on resume, appended on `message_end`). */
  messages: AgentMessage[];
  /** Accumulated assistant text for the current streaming response. */
  streamingText: string;
  /** Tool calls currently executing (or just finished this turn). */
  streamingToolCalls: ToolCallView[];
  /** Active model, kept in sync with `model_update` events. */
  model: Model<Api>;
  /** Requested reasoning level, kept in sync with `thinking_level_update`. */
  thinkingLevel: ThinkingLevel;
  /** Active tool names, kept in sync with `tools_update`. Empty before child 3. */
  activeToolNames: string[];
  /** Queue lengths, kept in sync with `queue_update`. */
  queue: QueueState;
}

/**
 * Subscribe to harness events and project them into TUI state.
 *
 * This hook owns the TUI↔harness boundary: it is the only place that interprets
 * raw `AgentHarnessEvent`s. Display code consumes `HarnessState`, never raw
 * events (see cross-layer-thinking-guide.md, "Every Consumer Parses The Same
 * Payload" anti-pattern). Markdown rendering (Markdown.tsx) is a pure
 * token→element transform and never touches the harness.
 */
export function useHarnessState(
  harness: AgentHarness,
  session?: Session<JsonlSessionMetadata>,
): HarnessState {
  const [state, setState] = useState<HarnessState>(() => ({
    phase: "idle",
    messages: [],
    streamingText: "",
    streamingToolCalls: [],
    model: harness.getModel(),
    thinkingLevel: harness.getThinkingLevel(),
    activeToolNames: harness.getActiveTools().map((t) => t.name),
    queue: { steer: 0, followUp: 0, nextTurn: 0 },
  }));

  useEffect(() => {
    // Resume seeding: load the existing branch once on mount so previously
    // persisted messages render before the first event arrives. run() regenerates
    // the context, but we mirror the typed MessageEntry → message projection
    // rather than reaching into storage internals.
    let cancelled = false;
    const seed = async (): Promise<void> => {
      if (!session) return;
      try {
        const branch = await session.getBranch();
        if (cancelled) return;
        const msgs = branch
          .filter((e): e is Extract<typeof e, { type: "message" }> => e.type === "message")
          .map((e) => e.message);
        setState((prev) => ({ ...prev, messages: msgs }));
      } catch {
        // Resume seeding is best-effort; live events still drive state.
      }
    };
    void seed();

    const unsubscribe = harness.subscribe((event) => {
      switch (event.type) {
        case "turn_start":
          setState((prev) => ({ ...prev, phase: "turn", streamingToolCalls: [] }));
          break;
        case "message_start":
          if (event.message.role === "assistant") {
            setState((prev) => ({ ...prev, streamingText: "" }));
          }
          break;
        case "message_update": {
          const ame = event.assistantMessageEvent;
          if (ame.type === "text_delta") {
            setState((prev) => ({ ...prev, streamingText: prev.streamingText + ame.delta }));
          }
          break;
        }
        case "message_end":
          // Append every role (user / assistant / toolResult) to history and
          // clear the streaming buffer only when an assistant message froze.
          setState((prev) => {
            const messages = [...prev.messages, event.message];
            const streamingText =
              event.message.role === "assistant" ? "" : prev.streamingText;
            return { ...prev, messages, streamingText };
          });
          break;
        case "tool_execution_start":
          setState((prev) => ({
            ...prev,
            streamingToolCalls: [
              ...prev.streamingToolCalls,
              { id: event.toolCallId, name: event.toolName, status: "running" },
            ],
          }));
          break;
        case "tool_execution_end":
          setState((prev) => ({
            ...prev,
            streamingToolCalls: prev.streamingToolCalls.map((tc) =>
              tc.id === event.toolCallId
                ? { ...tc, status: event.isError ? "error" : "done" }
                : tc,
            ),
          }));
          break;
        case "model_update":
          setState((prev) => ({ ...prev, model: event.model }));
          break;
        case "thinking_level_update":
          setState((prev) => ({ ...prev, thinkingLevel: event.level }));
          break;
        case "tools_update":
          setState((prev) => ({ ...prev, activeToolNames: event.activeToolNames }));
          break;
        case "queue_update":
          setState((prev) => ({
            ...prev,
            queue: {
              steer: event.steer.length,
              followUp: event.followUp.length,
              nextTurn: event.nextTurn.length,
            },
          }));
          break;
        case "agent_end":
          setState((prev) => ({
            ...prev,
            phase: "idle",
            streamingText: "",
            streamingToolCalls: [],
          }));
          break;
      }
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [harness, session]);

  return state;
}
