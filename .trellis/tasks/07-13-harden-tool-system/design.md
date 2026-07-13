# Tool System Hardening Design

## Scope

This parent task coordinates four independently verifiable changes:

1. capability- and scope-aware permissions;
2. bounded execution, artifacts, traversal, and cache retention;
3. descriptor-based registration and active-tool selection;
4. one typed tool-event/result contract shared by TUI, Headless, and Gateway.

The parent owns shared contracts and integration order. It is not the first implementation target.

## Architecture

```text
settings layers + CLI
        │
        ▼
ToolPolicyResolver ───────► ResolvedToolPolicy
        │                         │
        │                         ├─ permissions / workspace boundary
        │                         ├─ execution budgets / artifact policy
        │                         └─ enabled sources and tools
        ▼
ToolDescriptorRegistry ───► ToolCatalog + diagnostics
        │                         │
        │                         ├─ active tool names
        │                         └─ wrapped AgentTool[]
        ▼
AgentHarness.setTools(tools, activeNames)
        │
        ├─ tool_call hook ─► PermissionGate(scope intent)
        ├─ execute wrapper ─► budget + delta stream + artifact sink
        └─ harness events ─► shared ToolEvent decoder/reducer
                                  ├─ TUI HarnessState
                                  ├─ Headless JSONL
                                  └─ Gateway event bridge
```

## Shared Contracts

`src/tools/contracts.ts` owns the public tool-system vocabulary:

- `ToolDescriptor`: name, source, capabilities, risk, default permission,
  availability, streaming mode, factory, and permission-intent resolver.
- `ToolCapability`: `filesystem.read`, `filesystem.write`, `shell.execute`,
  `network.search`, `network.fetch`, `state.todo`.
- `ToolPermissionIntent`: capability, canonical target, scope kind, and a
  redacted human summary.
- `ToolExecutionBudget`: resolved hard and soft limits.
- `ToolResultEnvelope`: status, bounded data/preview, structured error,
  metrics, truncation, and artifact metadata.
- `ToolAvailability`: active, disabled, unavailable, or denied, with source
  and machine-readable reason.

The descriptor is the single source for registry validation, permission
summaries, active-set computation, `/tools`, and presentation fallback. UI and
Headless code must not recreate capability mappings from raw tool names.

## Configuration Boundaries

- Built-in defaults are safe and deterministic.
- Global settings may loosen or tighten permissions/budgets and may add
  workspace-external write allowlists.
- Trusted project settings may only tighten permissions, budgets, tool
  availability, and paths.
- CLI can override execution budgets for the current run and can convert
  interactive `ask` decisions to allow through the existing `--yes` behavior;
  CLI never converts a static `deny` to allow.
- Resolved configuration and provenance are produced once in
  `prepareGatewayEnv` and reused by fresh, resume, rebuild, and gateway paths.

## Availability Versus Permission

- Whole-tool deny, explicit disable, unavailable initialization, or an
  unenabled external source removes the tool from the model-visible active set.
- Allow, ask, and scoped-deny tools remain visible. The runtime gate evaluates
  each concrete input.
- Runtime permission checks remain installed even for hidden tools as a
  defense against stale or malformed tool calls.

## Result and Event Flow

Tool implementations return standard pi `AgentToolResult` objects whose text
content is the bounded model preview and whose details contain one validated
`ToolResultEnvelope`. Streaming tools emit bounded delta envelopes with a
monotonic sequence. A shared decoder owns conversion from generic harness
events to typed Novi tool events. The protocol is replaced atomically; no old
Headless fields or dual parser remain.

Expected tool failures use stable Novi error codes. Where pi-agent-core turns a
thrown error into a generic error result, the decoder emits
`TOOL_EXECUTION_FAILED` with the bounded public message. Expected batched Web
item failures continue to use their existing normalized per-item codes.

The public `BeforeToolCallResult` contract can carry only a reason string. Gate
failures therefore use a bounded, single-line `NOVI_ERROR:<code>:<message>`
codec. The shared decoder recognizes the prefix and reconstructs the error
envelope; the persisted text retains the code without depending on
pi-agent-core internals. Runtime-owned expected failures return envelopes
instead of throwing. Unexpected throws remain generic and bounded.

## Persistence

- Tool-call history stores only bounded previews and envelope metadata.
- Overflow is streamed to `~/.novi/artifacts/<sessionId>/<toolCallId>/` with
  mode `0600`, unless globally disabled.
- Artifact and Web-cache retention share quota/age cleanup primitives but keep
  distinct roots and policies.
- Permission denials are never persisted as artifacts.

## Compatibility and Non-goals

- This is a deliberate breaking replacement of the internal and Headless tool
  protocol. Every in-repository consumer changes in one rollout.
- No old registry, settings, result, or Headless schema is retained for
  compatibility. Existing user-facing tool names may remain where the new
  design has no reason to change them, but compatibility is not a constraint.
- No MCP transport, plugin marketplace, browser renderer, OCR, or OS shell
  sandbox is introduced. Bash approval remains independent and can access
  paths outside the native file-tool boundary after approval.

## Rollout and Rollback

Implement children in dependency order: registry contracts, permissions,
resource runtime, event consumers. Each child must leave the full repository
green. Rollback is child-by-child; shared contract changes must not be merged
without all direct consumers compiling.
