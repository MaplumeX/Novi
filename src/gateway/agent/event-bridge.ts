import type {
  AgentHarness,
  AgentHarnessEvent,
  AgentMessage,
} from "@earendil-works/pi-agent-core/node";
import { extractText } from "../../headless/events.js";
import type { ToolCatalogSnapshot } from "../../tools/contracts.js";
import { ToolEventDecoder } from "../../tools/events.js";
import type { AgentProtocolTurnCallbacks } from "../core/types.js";

/**
 * Subscribe to harness events and project them into gateway channel callbacks.
 *
 * This is the gateway's single event boundary (N2): the only place that
 * decodes raw `AgentHarnessEvent` shapes. Channels receive callbacks only —
 * they never see harness events directly. Reuses `extractText` from
 * `headless/events.ts` so the text-projection decoder stays shared.
 *
 * Projection rules:
 * - `turn_start` → `onTyping()`
 * - `message_update` `text_delta` → `onTextDelta(delta)`
 * - `message_update` `thinking_delta` → `onReasoningDelta(delta)`
 * - tool execution lifecycle → shared Novi `onToolEvent(event)` projection
 * - `message_end` (assistant) → buffer the latest assistant text
 * - `agent_end` → `onTurnEnd(buffered final assistant text)`
 *
 * `onTurnEnd` fires once per run with the **final** assistant message text.
 * A multi-turn run (tool calls) emits several `message_end` (assistant)
 * events — one per turn (tool-call narration + final reply). Surfacing every
 * one would send multiple messages to the user, so the bridge buffers the
 * latest assistant text and flushes it on `agent_end`, which fires exactly
 * once at the end of the run (see pi-agent-core-api.md event union).
 *
 * Returns the `unsubscribe` function from `harness.subscribe()`.
 */
export function createEventBridge(
  harness: AgentHarness,
  callbacks: AgentProtocolTurnCallbacks,
  toolCatalog?: ToolCatalogSnapshot,
): () => void {
  let lastAssistantText = "";
  const toolDecoder = new ToolEventDecoder(toolCatalog);

  return harness.subscribe((event: AgentHarnessEvent) => {
    const toolEvent = toolDecoder.decode(event);
    if (toolEvent) {
      void callbacks.onToolEvent?.(toolEvent);
      return;
    }
    switch (event.type) {
      case "turn_start":
        callbacks.onTyping?.();
        break;

      case "message_update": {
        const ame = event.assistantMessageEvent;
        if (ame.type === "text_delta") {
          callbacks.onTextDelta?.(ame.delta);
        } else if (ame.type === "thinking_delta") {
          callbacks.onReasoningDelta?.(ame.delta);
        }
        break;
      }

      case "message_end": {
        const message = event.message as AgentMessage as {
          role: string;
          content?: string | readonly unknown[];
        };
        if (message.role === "assistant") {
          // Buffer the latest assistant text; flush on `agent_end` so
          // multi-turn runs send only the final reply to the channel.
          lastAssistantText = extractText(message.content ?? "");
        }
        break;
      }

      case "agent_end":
        callbacks.onTurnEnd?.(lastAssistantText);
        lastAssistantText = "";
        break;

      default:
        // Other events are not relevant to channel rendering.
        break;
    }
  });
}
