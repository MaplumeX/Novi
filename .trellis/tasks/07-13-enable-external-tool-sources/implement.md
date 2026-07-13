# Implement plan (parent)

## Order

1. **Child 1: `07-13-mcp-config-approval`**
   - Config schema, loader, merge, fingerprint, approval store, unit tests.
   - No live MCP connection required.
2. **Child 2: `07-13-mcp-client-assembly`**
   - Depends on child 1 types/APIs.
   - SDK client, stdio + Streamable HTTP, descriptor adapter, unified assembly, unit/integration tests with fake transports.
3. **Child 3: `07-13-mcp-session-wiring`**
   - Depends on child 1 + 2.
   - Wire bootstrap/resume/reload/gateway; `/mcp` command; catalog refresh; cross-mode tests.
4. **Parent integration review**
   - Run full validation; confirm AC1–AC9; update specs; archive children then parent.

## Validation (every child)

```bash
npm run typecheck
npm run lint
npm run test
npm run build
git diff --check
```

## Parent-only final checks

- Empty MCP config path equals pre-task builtin behavior.
- User stdio server + project pending server diagnostics.
- Approve project server → tools appear → call goes through PermissionGate ask.
- HTTP server with header env substitution.
- One server crash does not remove builtins.
- `/reload` and gateway session create keep catalog consistency.

## Rollback points

- After child 1: pure additive modules; safe.
- After child 2: assembly API may change; keep `createBuiltinToolAssembly` as thin wrapper if needed.
- After child 3: full feature; disable by emptying MCP configs.

## Spec updates (parent finish)

- `tool-runtime-contracts.md`: external source assembly + availability reasons
- `database-guidelines.md` or settings docs: MCP files + approvals path
- `directory-structure.md`: `src/mcp/`
- Frontend command guidelines if `/mcp` lands
