# Tool Event Implementation Plan

- [x] Add `ToolResultEnvelope`, Novi tool-event union, JSON-safety validator,
  decoder, and lifecycle reducer in the tool contract owner modules.
- [x] Decode stable `NOVI_ERROR:<code>:<message>` gate failures into final
  envelopes while preserving bounded readable text and resume behavior.
- [x] Update the execution runtime to emit sequence-numbered deltas and final
  envelopes that the decoder can validate directly.
- [x] Replace Headless tool event projection with `tool.start`, `tool.delta`,
  and `tool.end`; delete legacy field branches and update JSON tests.
- [x] Refactor `useHarnessState` tool projections to call the shared reducer;
  keep it as the only TUI subscriber.
- [x] Update `ToolCallView`, `MessageList`, and `ToolCallBlock` to consume the
  final envelope and bounded accumulated delta.
- [x] Rewrite `tool-presentation.ts` specialized edit handling for canonical
  `edits[]`, including multi-edit summary and detail hunks.
- [x] Route Gateway event-bridge tool observation through the shared decoder;
  keep channel-specific rendering outside the contract owner.
- [x] Ensure persisted/resumed ToolResultMessage projection reconstructs the
  same final view from envelope details.
- [x] Remove old compatibility tests, casts, and duplicate raw payload parsing.
- [x] Update README and architecture documentation with the new JSONL examples.

## Required Tests

- start → multiple ordered deltas → final reconstruction;
- duplicate/gapped/out-of-order updates and end-before-start resilience;
- JSON safety, cycles, unknown payloads, secret-field exclusion;
- success/error/cancelled/truncated/artifact envelopes;
- Headless exact breaking schema and no legacy fields;
- TUI live/persisted deduplication and resume reconstruction;
- single/multiple canonical edit diffs and summaries;
- Gateway uses shared projection without altering final assistant delivery.

## Validation

```bash
npm run typecheck
npm run lint
npm run test -- --run src/headless src/tui src/gateway src/tools
npm run build
git diff --check
```

## Rollback

The event union, decoder, Headless projection, TUI reducer, and Gateway bridge
must change or revert together. No dual-schema compatibility layer is allowed.
