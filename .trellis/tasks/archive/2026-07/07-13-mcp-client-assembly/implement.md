# Implement: MCP client transport and tool assembly

## Checklist

1. Add MCP SDK dependency.
2. Implement transport factory + client manager with timeouts/abort.
3. Implement tool adapter (descriptor + execute + intents).
4. Decide/implement capability fallback (`external.invoke` if needed).
5. Implement merge helpers for registry/assembly.
6. Unit tests with mocks/fakes.
7. Ensure builtin-only path still works via existing API.

## Validation

```bash
npm run typecheck
npm run lint
npm run test
npm run build
```

## Risks

- SDK package name/version API churn → pin and wrap behind `src/mcp/client-manager.ts`
- Sync→async assembly → keep child 2 API awaitable without forcing incomplete bootstrap edits; leave call-site switch to child 3 if necessary, but avoid temporary broken exports.

## Done when

- AC1–AC8 green
- Child 3 can import manager/assembly helpers without rewriting protocol code
