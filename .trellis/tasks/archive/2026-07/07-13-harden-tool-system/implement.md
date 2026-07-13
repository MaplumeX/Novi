# Parent Implementation Plan

## Execution Order

- [ ] Complete `07-13-platformize-tool-registry` first; it introduces the
  descriptor/catalog contract consumed by later children.
- [ ] Complete `07-13-harden-tool-permissions`; it consumes descriptor
  permission intents and defines active-set deny semantics.
- [ ] Complete `07-13-govern-tool-resources`; it wraps catalog-built tools with
  budgets, deltas, artifacts, and retention.
- [ ] Complete `07-13-unify-tool-events`; it switches all consumers to the
  final envelope/delta contract.
- [ ] Run a parent integration pass across fresh bootstrap, resume, `/reload`,
  TUI, print/json Headless, and multi-session Gateway creation.
- [ ] Update `ARCHITECTURE.md`, `README.md`, settings examples, and relevant
  `.trellis/spec/` executable contracts after behavior is verified.

## Cross-child Gates

- [ ] One `ToolDescriptor` and one `ToolResultEnvelope` owner; no parallel UI,
  permission, or Headless copies.
- [ ] `prepareGatewayEnv`, `createHarnessForSession`, resume bootstrap, and
  `replayHarnessState` resolve/build the same catalog, policy, and budgets.
- [ ] Static deny is evaluated before any session grant.
- [ ] Whole-tool availability and scoped runtime permission remain distinct.
- [ ] No unbounded output copy survives in content, details, error messages,
  events, React state, or JSONL history.
- [ ] No legacy Headless tool-event compatibility branch remains.

## Validation

Run after every child and once at parent completion:

```bash
npm run typecheck
npm run lint
npm run test
npm run build
git diff --check
```

The final integration pass must add focused tests for:

- fresh/resume/reload active-set parity;
- gateway sessions sharing immutable configuration but not mutable grants or
  tool-call streaming state;
- Headless start/delta/end reconstruction;
- permission denial after an earlier session grant;
- bounded output with an artifact continuation path;
- TUI single- and multi-edit presentation.

## Rollback Points

- Registry contract commit before permission consumption.
- Permission policy commit before resource wrappers.
- Resource runtime commit before event protocol replacement.
- Event protocol replacement must be reverted as one unit across all
  consumers; partial rollback is not supported.

