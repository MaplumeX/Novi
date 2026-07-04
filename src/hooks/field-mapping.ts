import type { RegisterHooksDeps } from "./types.js";

/**
 * Explicit field-mapping tables for hook IPC.
 *
 * core events use camelCase fields; hook scripts receive snake_case JSON on
 * stdin and return snake_case JSON on stdout. Rather than a generic converter,
 * each event has an explicit allow-list so internal fields like `resources`,
 * `signal`, `preparation.settings`, etc. are never leaked to user scripts.
 */

// ---------------------------------------------------------------------------
// stdin: core event (camelCase) → hook input (snake_case)
// ---------------------------------------------------------------------------

/** Per-event map of core field name → snake_case stdin field name. */
const EVENT_INPUT_FIELDS: Record<string, Record<string, string>> = {
  tool_call: {
    toolCallId: "tool_call_id",
    toolName: "tool_name",
    input: "input",
  },
  tool_result: {
    toolCallId: "tool_call_id",
    toolName: "tool_name",
    input: "input",
    content: "content",
    details: "details",
    isError: "is_error",
  },
  before_agent_start: {
    prompt: "prompt",
    images: "images",
    systemPrompt: "system_prompt",
  },
  session_before_compact: {
    preparation: "preparation",
  },
};

/**
 * Build the stdin JSON payload for a hook script.
 *
 * Always includes `session_id`, `cwd`, and `hook_event_name`, then the
 * event-specific fields (snake_case) drawn from the core event object. Fields
 * absent from the core event are omitted from the payload.
 */
export function toHookInput(
  event: Record<string, unknown>,
  eventType: string,
  deps: RegisterHooksDeps,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    session_id: deps.sessionId,
    cwd: deps.cwd,
    hook_event_name: eventType,
  };
  const fields = EVENT_INPUT_FIELDS[eventType];
  if (fields) {
    for (const [coreKey, snakeKey] of Object.entries(fields)) {
      if (event[coreKey] !== undefined) {
        payload[snakeKey] = event[coreKey];
      }
    }
  }
  return payload;
}

// ---------------------------------------------------------------------------
// stdout: hook result (snake_case) → core result (camelCase)
// ---------------------------------------------------------------------------

/** Per-event map of snake_case stdout field → core camelCase result field. */
const EVENT_RESULT_FIELDS: Record<string, Record<string, string>> = {
  tool_call: {
    block: "block",
    reason: "reason",
  },
  tool_result: {
    content: "content",
    details: "details",
    is_error: "isError",
    terminate: "terminate",
  },
  before_agent_start: {
    messages: "messages",
    system_prompt: "systemPrompt",
  },
  session_before_compact: {
    cancel: "cancel",
    compaction: "compaction",
  },
};

/**
 * Convert a parsed stdout `result` object (snake_case) into the core result
 * shape (camelCase) for `eventType`. Unknown keys are ignored; only the
 * allow-listed fields for this event are forwarded.
 */
export function toCoreResult(
  stdoutResult: Record<string, unknown>,
  eventType: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const fields = EVENT_RESULT_FIELDS[eventType];
  if (fields) {
    for (const [snakeKey, coreKey] of Object.entries(fields)) {
      if (stdoutResult[snakeKey] !== undefined) {
        out[coreKey] = stdoutResult[snakeKey];
      }
    }
  }
  return out;
}