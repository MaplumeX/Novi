# Unified Tool Result and Event Design

## Dependencies

Implementation starts after the registry, permission, and resource children.
It consumes descriptor projections, stable permission error codes, and the
runtime-owned bounded envelope/delta stream. This child owns consumer decoding
and presentation, not execution buffering or permission policy.

## Contract Owner

`src/tools/events.ts` owns typed Novi tool events and the only decoder from
generic `AgentHarnessEvent` payloads. TUI, Headless, and Gateway import its
projections/reducer; they do not cast raw tool fields independently.

## Result Envelope

```ts
type JsonValue = null | boolean | number | string | JsonValue[] |
  { [key: string]: JsonValue };

interface ToolResultEnvelope {
  version: 1;
  status: "success" | "error" | "cancelled";
  data?: JsonValue;                  // JSON-safe, bounded structured result
  preview: string;                   // model/TUI bounded text
  error?: {
    code: string;
    message: string;
    retryable: boolean;
  };
  metrics: {
    startedAt: number;
    durationMs: number;
    inputItems?: number;
    outputBytes: number;
    outputLines: number;
  };
  truncation: {
    truncated: boolean;
    reasons: string[];
    shownBytes: number;
    shownLines: number;
  };
  artifacts: Array<{
    kind: "full-output" | "document";
    path: string;
    bytes: number;
  }>;
}
```

Before emission, a JSON-safety validator rejects functions, symbols, cyclic
data, and secret-bearing internal fields. Tool content is derived from
`preview`; details contain the envelope but never another full output copy.

## Novi Tool Events

The old Headless projection is replaced by:

```ts
type NoviToolEvent =
  | { type: "tool.start"; toolCallId: string; tool: ToolRef; input: JsonValue; at: number }
  | { type: "tool.delta"; toolCallId: string; sequence: number; delta: string; at: number }
  | { type: "tool.end"; toolCallId: string; result: ToolResultEnvelope; at: number };
```

`ToolRef` contains name, label, source, capabilities, and risk from the
descriptor projection. Sequence starts at one per call and must increase by
one. The decoder tolerates an upstream update/end arriving before start by
creating a minimal call state, but reports sequence gaps in diagnostics.

This protocol is a full breaking replacement. No old
`tool_execution_start/update/end` JSON shapes or compatibility aliases remain
in Headless output.

## Shared Reducer

A pure `reduceToolCallState` owns lifecycle transitions. It accumulates bounded
deltas into `ToolCallView`, freezes the final envelope, and is used by
`useHarnessState` and event tests. Display components consume this typed state.

## TUI

- `useHarnessState` remains the only harness subscriber.
- Tool rows use descriptor metadata for generic action labels.
- Specialized built-in formatters consume typed normalized input/result.
- `edit_file` reads canonical `edits[]`; multi-edit summaries aggregate all
  hunks and detail mode renders each diff without reverting to legacy top-level
  `oldText/newText`.
- Permission prompt continues to have priority over normal overlays.

## Headless and Gateway

- JSON mode emits the exact Novi event discriminated union.
- Print mode continues to print final assistant text, not raw tool JSON.
- Gateway's event bridge uses the same decoder/reducer for tool observability;
  channel delivery may ignore deltas, but cannot define a second payload
  parser.
- Unknown future non-tool harness events retain their existing safe fallback;
  unknown tool payloads fail closed into a bounded generic error result.

## Security

Events contain redacted permission summaries, bounded input projections, and
artifact paths, never API keys, Authorization headers, full environment maps,
stacks, or unbounded raw provider payloads.
