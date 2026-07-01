import { useEffect, useState } from "react";
import type { AgentHarness } from "@earendil-works/pi-agent-core/node";

export type Phase = "idle" | "turn";

export interface HarnessState {
  /** Accumulated assistant text for the current streaming response. */
  streamingText: string;
  /** High-level run phase. "turn" while a prompt is in flight. */
  phase: Phase;
}

/**
 * Subscribe to harness events and project them into minimal TUI state.
 *
 * This hook owns the TUI↔harness boundary: it is the only place that interprets
 * raw `AgentHarnessEvent`s. Display code consumes `HarnessState`, never raw
 * events (see cross-layer-thinking-guide.md, "Every Consumer Parses The Same
 * Payload" anti-pattern).
 */
export function useHarnessState(harness: AgentHarness): HarnessState {
  const [streamingText, setStreamingText] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");

  useEffect(() => {
    const unsubscribe = harness.subscribe((event) => {
      switch (event.type) {
        case "turn_start":
          setPhase("turn");
          break;
        case "message_start":
          if (event.message.role === "assistant") {
            setStreamingText("");
          }
          break;
        case "message_update": {
          const ame = event.assistantMessageEvent;
          if (ame.type === "text_delta") {
            setStreamingText((prev) => prev + ame.delta);
          }
          break;
        }
        case "message_end":
          // History rendering belongs to child 2; current text stays frozen
          // in `streamingText` until the next message_start clears it.
          break;
        case "agent_end":
          setPhase("idle");
          break;
      }
    });
    return unsubscribe;
  }, [harness]);

  return { streamingText, phase };
}
