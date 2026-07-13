# Registry Implementation Plan

- [x] Add `src/tools/contracts.ts` with descriptor, capability, availability,
  permission-intent, assembly, and serializable projection types.
- [x] Rewrite `src/tools/registry.ts` around validated descriptors; add
  duplicate, invalid metadata, and descriptor/tool-name mismatch tests.
- [x] Convert all ten built-ins in `src/tools/index.ts` to descriptors with
  explicit capabilities, risks, defaults, stream mode, and intent resolvers.
- [x] Introduce one assembly function returning tools, active names,
  availability, diagnostics, and descriptor projections.
- [x] Add explicit enabled/disabled settings resolution with global override,
  project tighten-only behavior, and external-source default disabled.
- [x] Switch fresh bootstrap, resume bootstrap, gateway session creation, and
  TUI `replayHarnessState` to the assembly result; never derive active names
  independently at call sites.
- [x] Add unavailable handling for optional Web-provider configuration without
  silently switching provider.
- [x] Add `/tools` diagnostics surface or extend the existing command layer to
  show active/disabled/unavailable/denied states and reasons.
- [x] Extend `tools_update` source data so the later event child can serialize
  descriptor source/capability/availability.
- [x] Update registry/index/bootstrap/harness-handle tests for identical fresh,
  resume, reload, and gateway assembly.

## Validation

```bash
npm run typecheck
npm run lint
npm run test -- --run src/tools src/bootstrap.test.ts src/tui/harness-handle.test.ts src/gateway
npm run build
git diff --check
```

## Rollback

If assembly wiring fails, revert the descriptor conversion and all four
harness call sites together; do not retain two registries or a compatibility
adapter. Unchanged public built-in names are a product choice, not a legacy
contract that blocks the new design.
