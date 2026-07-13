# Design: MCP session management and harness wiring

## Boundary

Wire child 1+2 into product surfaces. No new transport protocol.

## Call sites to update

- `src/bootstrap.ts`
  - preflight: validate config/plan diagnostics; avoid heavy connect if possible
  - `createHarnessForSession` / resume: await unified assembly with MCP
- `src/tui/harness-handle.ts`
  - rebuild/reload: re-resolve plan, reconnect policy, refresh toolCatalog + permission descriptors
- `src/tui/commands.ts`
  - add `/mcp`
  - extend help text
- Headless/Gateway event projection already catalog-driven; ensure new catalogs flow through

## Harness handle extensions

```ts
interface HarnessHandle {
  ...
  mcp?: McpRuntimeHandle;
  toolCatalog: ToolCatalogSnapshot;
}
```

Dispose/close path must `await mcp.close()`.

## `/mcp` UX

Minimal text command, not full Ink app:

- `/mcp` or `/mcp list`
- `/mcp approve <name>`
- `/mcp deny <name>`
- `/mcp reconnect [name]`

Output includes origin, transport summary, status, tool count, last error.

Approve/deny:

1. write approval store
2. resolve plan
3. rebuild tools via shared helper
4. `setTools`
5. replace `toolCatalog`
6. print summary

## Headless / Gateway

- Load approvals silently
- Pending project servers → diagnostics only
- No interactive approve
- Document that operators must approve via TUI or by writing approval store (TUI preferred)

## Permission wiring

- Ensure MCP descriptors are registered in the map used by PermissionGate (`getBuiltinToolDescriptor` currently builtin-only → generalize to catalog lookup).
- Critical: gate must resolve external descriptors, not only builtins.

## Tests

- integration: plan pending → approve → active tools
- reload preserves approvals
- gateway create with user MCP mock
- help/commands registration
- no-config regression

## Risks

- Descriptor lookup still hardcoded to builtin registry → must fix for ask/deny to work
- React toolCatalog identity updates on hot reload
- Process leak if stdio servers not closed on `/new`/`/quit`
