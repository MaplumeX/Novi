# Implement: MCP session management and harness wiring

## Checklist

1. Generalize descriptor lookup used by PermissionGate beyond builtins.
2. Introduce shared `assembleSessionTools(...)` helper used by bootstrap + TUI rebuild.
3. Wire bootstrap/resume/gateway create to await MCP-enabled assembly.
4. Ensure close/dispose stops MCP clients.
5. Add `/mcp` command + help.
6. Implement approve/deny/reconnect → rebuild catalog path.
7. Update `/tools` formatting if source display insufficient.
8. Cross-mode tests + full quality gate.
9. Docs: README snippet for `.mcp.json` + approval model.

## Validation

```bash
npm run typecheck
npm run lint
npm run test
npm run build
git diff --check
```

## Done when

- AC1–AC8 green
- Parent AC1–AC9 ready for final review
