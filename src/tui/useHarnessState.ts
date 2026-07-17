import { useEffect, useRef, useState } from "react";
import type {
  AgentHarness,
  AgentMessage,
  Session,
  ThinkingLevel,
} from "@earendil-works/pi-agent-core/node";
import type { JsonlSessionMetadata } from "@earendil-works/pi-agent-core/node";
import type { Api, Model } from "@earendil-works/pi-ai";
import { AutoCompactor, CONTEXT_WINDOW_FALLBACK } from "../compaction.js";
import type { CompactionSettings } from "@earendil-works/pi-agent-core/node";
import {
  addUsage,
  lastUsageSummary,
  summarizeUsage,
  usageToSummary,
  ZERO_USAGE,
  type UsageSummary,
} from "./usage.js";
import type { ToolCatalogSnapshot } from "../tools/contracts.js";
import { ToolEventDecoder, reduceToolCallState, type ToolCallView } from "../tools/events.js";
import { isInternalAgentCompletionWake } from "../agents/local-completion.js";
import { extractTextContent } from "../runs/execution.js";

export type { ToolCallView } from "../tools/events.js";

export type Phase = "idle" | "turn" | "compaction";

/**
 * Queued messages surfaced from `queue_update` events.
 *
 * The full `AgentMessage[]` arrays (not just counts) are projected so that
 * the restore / Alt+Up preview / `/queue` paths share a single decoded
 * view of the queue (see cross-layer-thinking-guide.md).
 */
export interface QueueState {
  steer: AgentMessage[];
  followUp: AgentMessage[];
  nextTurn: AgentMessage[];
}

export interface HarnessState {
  /** High-level run phase. "turn" while a prompt is in flight. */
  phase: Phase;
  /** Full conversation history (seeded on resume, appended on `message_end`). */
  messages: AgentMessage[];
  /** Accumulated assistant text for the current streaming response. */
  streamingText: string;
  /** Accumulated thinking text for the current streaming response. */
  streamingThinking: string;
  /** True only between thinking_start and thinking_end. */
  streamingThinkingActive: boolean;
  /** Tool calls currently executing (or just finished this turn). */
  streamingToolCalls: ToolCallView[];
  /** Active model, kept in sync with `model_update` events. */
  model: Model<Api>;
  /** Requested reasoning level, kept in sync with `thinking_level_update`. */
  thinkingLevel: ThinkingLevel;
  /** Active tool names from the validated catalog/harness active set. */
  activeToolNames: string[];
  /** Queued steer/followUp/nextTurn messages, projected from `queue_update`. */
  queue: QueueState;
  /** Most recent assistant usage projection (undefined until first turn, or
   *  after resume with no assistant messages). */
  lastUsage: UsageSummary | undefined;
  /** Cumulative usage across all assistant messages in the branch. */
  cumulativeUsage: UsageSummary;
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
  compactionSettings?: CompactionSettings,
  toolCatalog?: ToolCatalogSnapshot,
): HarnessState {
  // Dependency array below is [harness, session]; callers passing
  // handle.harness / handle.session get re-subscription on replace().
  const [state, setState] = useState<HarnessState>(() => ({
    phase: "idle",
    messages: [],
    streamingText: "",
    streamingThinking: "",
    streamingThinkingActive: false,
    streamingToolCalls: [],
    model: harness.getModel(),
    thinkingLevel: harness.getThinkingLevel(),
    activeToolNames: harness.getActiveTools().map((t) => t.name),
    queue: { steer: [], followUp: [], nextTurn: [] },
    lastUsage: undefined,
    cumulativeUsage: { ...ZERO_USAGE },
  }));

  // Synchronously-current messages mirror for handlers that need the latest
  // history outside React's render cycle (e.g. auto-compaction on `settled`,
  // which fires after the final `message_end` of the same tick).
  const messagesRef = useRef<AgentMessage[]>([]);
  // Auto-compactor instance persists across subscribe/unsubscribe cycles.
  // Initial settings come from the caller (App.tsx computes them via
  // resolveCompactionSettings); setSettings is called on every effect run so
  // /reload-triggered settings changes propagate to the compactor.
  const [compactor] = useState(() => new AutoCompactor(compactionSettings));

  useEffect(() => {
    let cancelled = false;

    // Sync the compactor's settings whenever this effect re-runs (e.g. after
    // /reload changes the resolved settings and App re-computes them).
    if (compactionSettings) compactor.setSettings(compactionSettings);

    // `setTools` runs before a replacement harness is published to React, so
    // its tools_update event is not observable by this subscription. Pull the
    // public getter on every re-subscribe to keep /reload and session switches
    // aligned with the catalog-computed active set.
    setState((prev) => ({
      ...prev,
      activeToolNames: harness.getActiveTools().map((tool) => tool.name),
    }));

    // Pull MessageEntry → message from a branch and sync both the ref (for
    // synchronous reads) and React state (for rendering).
    const reloadMessages = async (): Promise<void> => {
      if (!session) return;
      try {
        const branch = await session.getBranch();
        if (cancelled) return;
        const msgs = branch
          .filter((e): e is Extract<typeof e, { type: "message" }> => e.type === "message")
          .map((e) => e.message)
          .filter((message) => !isInternalWakeMessage(message));
        messagesRef.current = msgs;
        setState((prev) => ({
          ...prev,
          messages: msgs,
          lastUsage: lastUsageSummary(msgs),
          cumulativeUsage: summarizeUsage(msgs),
        }));
      } catch {
        // Reload is best-effort; live events still drive state.
      }
    };

    // Resume seeding: load the existing branch once on mount so previously
    // persisted messages render before the first event arrives. run() regenerates
    // the context, but we mirror the typed MessageEntry → message projection
    // rather than reaching into storage internals.
    void reloadMessages();

    const toolDecoder = new ToolEventDecoder(toolCatalog);
    const unsubscribe = harness.subscribe((event) => {
      const toolEvent = toolDecoder.decode(event);
      if (toolEvent) {
        setState((prev) => ({
          ...prev,
          streamingToolCalls: reduceToolCallState(prev.streamingToolCalls, toolEvent),
        }));
        return;
      }
      switch (event.type) {
        case "turn_start":
          setState((prev) => ({ ...prev, phase: "turn", streamingToolCalls: [] }));
          break;
        case "message_start":
          if (event.message.role === "assistant") {
            setState((prev) => ({
              ...prev,
              streamingText: "",
              streamingThinking: "",
              streamingThinkingActive: false,
            }));
          }
          break;
        case "message_update": {
          const ame = event.assistantMessageEvent;
          if (ame.type === "text_delta") {
            setState((prev) => ({ ...prev, streamingText: prev.streamingText + ame.delta }));
          } else if (ame.type === "thinking_start") {
            setState((prev) => ({
              ...prev,
              streamingThinking: "",
              streamingThinkingActive: true,
            }));
          } else if (ame.type === "thinking_delta") {
            setState((prev) => ({
              ...prev,
              streamingThinking: prev.streamingThinking + ame.delta,
              streamingThinkingActive: true,
            }));
          } else if (ame.type === "thinking_end") {
            setState((prev) => ({
              ...prev,
              streamingThinking: ame.content,
              streamingThinkingActive: false,
            }));
          }
          break;
        }
        case "message_end":
          // Append every role (user / assistant / toolResult) to history and
          // clear the streaming buffer only when an assistant message froze.
          // Update the ref synchronously so post-turn handlers (`settled`)
          // see the just-appended message.
          {
            if (isInternalWakeMessage(event.message)) break;
            const messages = [...messagesRef.current, event.message];
            messagesRef.current = messages;
            const isAssistantMsg = event.message.role === "assistant";
            const streamingText = isAssistantMsg ? "" : undefined;
            const streamingThinking = isAssistantMsg ? "" : undefined;
            // Project usage from the just-finished assistant message. Skipped
            // for other roles (no usage block). See usage.ts for the single
            // projection owner. Inline the role check so TS narrows
            // `event.message` to AssistantMessage before reading `.usage`.
            const usageDelta =
              event.message.role === "assistant" ? usageToSummary(event.message.usage) : undefined;
            setState((prev) => ({
              ...prev,
              messages,
              streamingText: streamingText === undefined ? prev.streamingText : streamingText,
              streamingThinking:
                streamingThinking === undefined ? prev.streamingThinking : streamingThinking,
              streamingThinkingActive: isAssistantMsg ? false : prev.streamingThinkingActive,
              lastUsage: usageDelta ?? prev.lastUsage,
              cumulativeUsage: usageDelta
                ? addUsage(prev.cumulativeUsage, usageDelta)
                : prev.cumulativeUsage,
            }));
          }
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
              steer: event.steer,
              followUp: event.followUp,
              nextTurn: event.nextTurn,
            },
          }));
          break;
        case "agent_end":
          setState((prev) => ({
            ...prev,
            phase: "idle",
            streamingText: "",
            streamingThinking: "",
            streamingThinkingActive: false,
            streamingToolCalls: [],
          }));
          break;
        case "settled":
          // Auto-compaction decision point: debounced by turn count, then
          // gated by `shouldCompact`. `harness.compact()` requires idle and
          // emits `session_compact`, which triggers reloadMessages below.
          //
          // `session_before_compact` is a hook event (emitHook) and is NOT
          // broadcast to subscribers, so the TUI cannot observe compaction
          // start that way. Instead flip to the "compaction" phase optimistically
          // via onStart (R2: during compaction, prompt submission is disabled).
          void compactor
            .maybeCompact(
              harness,
              messagesRef.current,
              harness.getModel().contextWindow ?? CONTEXT_WINDOW_FALLBACK,
              () => setState((prev) => ({ ...prev, phase: "compaction" })),
            )
            .catch(() => {
              // A skipped compaction never flipped the phase. A failed one did
              // (onStart fired) but emitted no `session_compact`, so reset it.
              setState((prev) => (prev.phase === "compaction" ? { ...prev, phase: "idle" } : prev));
            });
          break;
        case "session_compact":
          // Compaction rewrote the active leaf: reload the branch, and the
          // harness is back to idle, so clear any optimistic "compaction" phase.
          setState((prev) => (prev.phase === "compaction" ? { ...prev, phase: "idle" } : prev));
          void reloadMessages();
          break;
        case "session_tree":
          // Branch navigation rewrites the active leaf. Reload the branch so
          // the rendered history matches the new leaf.
          void reloadMessages();
          break;
      }
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [harness, session, compactionSettings, toolCatalog]);

  return state;
}

function isInternalWakeMessage(message: AgentMessage): boolean {
  return (
    message.role === "user" &&
    isInternalAgentCompletionWake(extractTextContent(message.content))
  );
}
