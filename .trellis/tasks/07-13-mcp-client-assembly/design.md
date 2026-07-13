# Design: MCP client transport and tool assembly

## Boundary

Depends on `src/mcp` plan/approval APIs from child 1.

Owns live client connections and descriptor adaptation.

Does not own TUI commands or bootstrap call-site migration (child 3), but should make migration mechanical.

## Dependencies

- `@modelcontextprotocol/sdk` (or current official client package compatible with Node 22)
- Existing `ToolRegistry`, `ToolExecutionRuntime`, permission contracts

## Modules

- `src/mcp/transport.ts` — create stdio/http transports from resolved config
- `src/mcp/client-manager.ts` — connect/list/call/close per server
- `src/mcp/tool-adapter.ts` — MCP tool → ToolDescriptor + AgentTool factory
- `src/tools/assembly.ts` — unified assembly entry
- Keep `createBuiltinToolAssembly` as wrapper or re-export for compatibility during migration

## Connection flow

```
for entry in plan.entries where status==connectable && source enabled:
  resolve env/headers placeholders
  if missing required env -> unavailable diagnostic
  else connect with timeout
  tools/list
  adapt tools
on failure: mark source unavailable, continue
```

## Naming

- source id: `mcp:<serverName>`
- tool name: `mcp_<server>_<tool>` lowercased, non `[a-z0-9_]` → `_`
- if still duplicates inside registry: append numeric suffix deterministically; diagnostic emitted
- original MCP name retained in label/details

## Adapter execute

```ts
async execute(toolCallId, params, signal, onUpdate?) {
  const result = await manager.callTool(server, mcpToolName, params, signal);
  // map MCP content[] to text preview + structured data
  // throw NOVI_ERROR for transport/tool errors so runtime envelope stays consistent
}
```

Streaming: v1 `streaming: "none"` even if MCP supports progress.

## Capability mapping (coarse)

Heuristics (order matters):

1. tool annotations/readOnlyHint/destructiveHint if present
2. arg schema property names: `path/file/directory` → filesystem.*
3. `url/uri` → network.fetch
4. `command/shell` → shell.execute
5. fallback: add `external.invoke` capability if needed

**Decision gate during implement:**

- If adding `external.invoke` is required for policy vocabulary, update `TOOL_CAPABILITIES`, policy validation, and tests in this child.
- defaultPermission remains `ask`
- risk default: stdio tools `execute`, http-origin tools at least `network` (may also be execute)

## Unified assembly

```ts
async function createToolAssembly(env, sessionId, options): Promise<ToolAssembly & { mcp?: McpRuntimeHandle }>
```

Note: current builtin assembly is sync. MCP connect is async.

Options:

1. Make unified assembly async and update all call sites in child 3.
2. Keep sync builtin; child 3 awaits `attachMcpSources(assembly, ...)`.

Prefer **async unified `createToolAssembly`** and migrate call sites in child 3. Child 2 can export both:

- `createBuiltinToolAssembly` (sync, unchanged)
- `createMcpDescriptors(plan, ...)` / `McpClientManager`
- `mergeToolAssemblies` / `buildExternalDescriptors`

so child 2 tests don't need full bootstrap.

## Lifecycle handle

```ts
interface McpRuntimeHandle {
  plan: McpPlan;
  close(): Promise<void>;
  reconnect(serverName?: string): Promise<void>;
  getDiagnostics(): string[];
}
```

Child 3 stores handle on harness handle / gateway session for `/mcp` and dispose.

## Tests

- fake stdio transport using in-process mock client (no real npx)
- mock HTTP client
- fail-soft server
- name sanitization/collision
- source disable
- permission intent shape
- runtime wrap still applied

## Trade-offs

- Async assembly migration cost deferred mostly to child 3
- Official SDK preferred over hand-rolled JSON-RPC
