import type { AgentHarnessEvent } from "@earendil-works/pi-agent-core/node";
import type { ToolCatalogSnapshot } from "../tools/contracts.js";
import { findPermissionError } from "../permissions/errors.js";
import type { AssistantMessage } from "@earendil-works/pi-ai";

/**
 * Extract a plain-text view from any agent message content shape.
 *
 * Headless mode owner of the `AgentMessage.content` → string projection so
 * `projectEvent` / `runPrint` share a single decoder (see
 * cross-layer-thinking-guide.md, "Every Consumer Parses The Same Payload").
 */
export function extractText(content: string | readonly unknown[]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (c): c is { type: "text"; text: string } =>
        typeof c === "object" && c !== null && (c as { type?: string }).type === "text",
    )
    .map((c) => c.text)
    .join("");
}

/** Project the usage stats of an assistant message, or `undefined`. */
function projectUsage(
  message: unknown,
): { input: number; output: number; cacheRead: number; cacheWrite: number } | undefined {
  const usage = (message as AssistantMessage)?.usage;
  if (!usage || typeof usage !== "object") return undefined;
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
  };
}

/**
 * Project a raw harness event into a JSON-serializable plain object.
 *
 * White-lists fields per event type; strips `Model` instances, functions, and
 * `AbortSignal`s so the result is always `JSON.stringify`-safe. Unknown event
 * types collapse to `{ type, _raw: "unknown" }` rather than throwing.
 *
 * This is the single event → plain-object decoder for headless mode; consumers
 * of `--mode json` read the projected output, never raw events (see
 * cross-layer-thinking-guide.md).
 */
export function projectToolCatalog(
  catalog: ToolCatalogSnapshot,
  source: string,
  activeToolNames: readonly string[] = catalog.activeToolNames,
): Record<string, unknown> {
  const availability = new Map(catalog.availability.map((entry) => [entry.name, entry]));
  return {
    type: "tools_update",
    source,
    activeToolNames: [...activeToolNames],
    tools: catalog.descriptors.map((descriptor) => {
      const state = availability.get(descriptor.name);
      return {
        name: descriptor.name,
        label: descriptor.label,
        source: descriptor.source,
        capabilities: descriptor.capabilities,
        risk: descriptor.risk,
        modes: descriptor.modes,
        status: state?.status ?? "unavailable",
        ...(state?.reasonCode ? { reasonCode: state.reasonCode } : {}),
        ...(state?.reason ? { reason: state.reason } : {}),
      };
    }),
    diagnostics: catalog.diagnostics,
  };
}

export function projectEvent(
  event: AgentHarnessEvent,
  toolCatalog?: ToolCatalogSnapshot,
): Record<string, unknown> {
  const base: Record<string, unknown> = { type: event.type };
  switch (event.type) {
    case "agent_start":
      return { ...base };
    case "agent_end":
      return { ...base, messageCount: event.messages.length };
    case "turn_start":
      return { ...base };
    case "turn_end":
      return { ...base, role: event.message.role };
    case "message_start":
      return { ...base, role: event.message.role };
    case "message_update":
      return event.assistantMessageEvent.type === "text_delta"
        ? { ...base, delta: event.assistantMessageEvent.delta }
        : { ...base, subType: event.assistantMessageEvent.type };
    case "message_end":
      return {
        ...base,
        role: event.message.role,
        text: extractText((event.message as { content?: string | unknown[] }).content ?? ""),
        usage: projectUsage(event.message),
      };
    case "tool_execution_start":
      return {
        ...base,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.args,
      };
    case "tool_execution_update":
      return {
        ...base,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
      };
    case "tool_execution_end": {
      const executionError = findPermissionError(event.result);
      return {
        ...base,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        isError: event.isError,
        ...(executionError
          ? { errorCode: executionError.code, errorMessage: executionError.message }
          : {}),
      };
    }
    case "queue_update":
      return {
        ...base,
        steer: event.steer.length,
        followUp: event.followUp.length,
        nextTurn: event.nextTurn.length,
      };
    case "save_point":
      return { ...base, hadPendingMutations: event.hadPendingMutations };
    case "abort":
      return {
        ...base,
        clearedSteer: event.clearedSteer.length,
        clearedFollowUp: event.clearedFollowUp.length,
      };
    case "settled":
      return { ...base, nextTurnCount: event.nextTurnCount };
    case "before_agent_start":
      return {
        ...base,
        prompt: event.prompt,
        systemPrompt: typeof event.systemPrompt === "string" ? event.systemPrompt : undefined,
      };
    case "context":
      return { ...base, messageCount: event.messages.length };
    case "before_provider_request":
      return {
        ...base,
        provider: event.model?.provider,
        modelId: event.model?.id,
        sessionId: event.sessionId,
      };
    case "before_provider_payload":
      return { ...base, provider: event.model?.provider, modelId: event.model?.id };
    case "after_provider_response":
      return { ...base, status: event.status, headers: event.headers };
    case "tool_call":
      return {
        ...base,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        input: event.input,
      };
    case "tool_result": {
      const permissionError = findPermissionError(event.content);
      return {
        ...base,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        isError: event.isError,
        contentCount: Array.isArray(event.content) ? event.content.length : 0,
        ...(permissionError
          ? { errorCode: permissionError.code, errorMessage: permissionError.message }
          : {}),
      };
    }
    case "session_compact":
      return {
        ...base,
        firstKeptEntryId: event.compactionEntry.firstKeptEntryId,
        tokensBefore: event.compactionEntry.tokensBefore,
        fromHook: event.fromHook,
      };
    case "session_tree":
      return {
        ...base,
        newLeafId: event.newLeafId,
        oldLeafId: event.oldLeafId,
        fromHook: event.fromHook,
      };
    case "model_update":
      return {
        ...base,
        provider: event.model?.provider,
        modelId: event.model?.id,
        source: event.source,
      };
    case "thinking_level_update":
      return { ...base, level: event.level, previousLevel: event.previousLevel };
    case "resources_update":
      return {
        ...base,
        skills: (event.resources?.skills ?? []).map((s) => s.name),
        promptTemplates: (event.resources?.promptTemplates ?? []).map((t) => t.name),
      };
    case "tools_update":
      if (toolCatalog) {
        return projectToolCatalog(toolCatalog, event.source, event.activeToolNames);
      }
      return {
        ...base,
        toolNames: event.toolNames,
        activeToolNames: event.activeToolNames,
        source: event.source,
      };
    // `session_before_compact` / `session_before_tree` are hook-only events and
    // are not broadcast to subscribers, but handle them defensively anyway.
    case "session_before_compact":
    case "session_before_tree":
      return { ...base, _raw: "hook" };
    default:
      return { ...base, _raw: "unknown" };
  }
}
