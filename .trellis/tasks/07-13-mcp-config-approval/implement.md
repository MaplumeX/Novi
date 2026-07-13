# Implement: MCP config and approval store

## Checklist

1. Add `src/mcp/types.ts` with config/plan/approval types.
2. Implement `config.ts` path resolution, parse, validate, merge.
3. Implement fingerprint helper with stable canonicalization + hashing.
4. Implement `approval.ts` load/save/set/get.
5. Implement `plan.ts` `resolveMcpPlan`.
6. Export public API from `src/mcp/index.ts`.
7. Add unit tests for all acceptance paths.
8. Update directory-structure / settings docs only if required by check; otherwise leave parent finish.

## Validation

```bash
npm run typecheck
npm run lint
npm run test -- src/mcp
npm run test
```

## Risks

- Over-strict schema rejects Claude-compatible fields → start with common Claude subset (`command`/`args`/`env`/`url`/`headers`).
- Fingerprint too sensitive (env value order) → canonicalize keys sorted.

## Done when

- AC1–AC7 green
- No runtime wiring yet
