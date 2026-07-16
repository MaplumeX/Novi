# Implement: Cache-Aware Tool Registration Ordering

## Ordered Checklist

### 1. Sort builtin descriptors in `index.ts`

- [ ] In `src/tools/index.ts`: sort the `descriptors` array by `name`
      before the module-level `registry.add` loop
- [ ] Also sort `activeDescriptors` in `createBuiltinToolAssembly` before
      building (covers `additionalDescriptors` case)
- [ ] Helper: local `sortByName(descriptors)` function
- [ ] Update `index.test.ts`: assert `getBuiltinToolDescriptors()` returns
      alphabetical order

### 2. Sort external descriptors in `assembly.ts`

- [ ] In `src/tools/assembly.ts` `buildMergedAssembly`: sort the
      `adapted` descriptors by `name` before the registration loop
- [ ] Sort `mergeToolDescriptors` external input before concatenation
- [ ] Update `assembly.test.ts`: assert builtin-then-external order, both
      groups alphabetical

### 3. Set `cacheRetention` in `bootstrap.ts`

- [ ] In `src/bootstrap.ts` (~line 412): add `cacheRetention: "short"` to
      the `streamOptions` object
- [ ] Verify no type error (`AgentHarnessStreamOptions.cacheRetention`
      accepts `"short"`)
- [ ] Check Gateway path (`src/gateway/jobs/agent-runner.ts`) uses the same
      `streamOptions` from bootstrap — no separate setting needed

### 4. Update affected tests

- [ ] `src/tools/assembly.test.ts`: update expected descriptor order
- [ ] `src/tools/session-assembly.test.ts`: update expected order if it
      asserts ordering
- [ ] `src/tools/index.test.ts`: update expected builtin order
- [ ] Any other test that asserts `assembly.descriptors` or
      `assembly.activeToolNames` order

### 5. Full validation

- [ ] `npm run typecheck`
- [ ] `npm run lint`
- [ ] `npm run test`
- [ ] `npm run build`
- [ ] `git diff --check`

## Validation Commands

```bash
npm run typecheck && npm run lint && npm run test && npm run build && git diff --check
```

## Risky Files / Rollback Points

- `src/tools/index.ts` — builtin descriptor order. Rollback: remove sort.
- `src/tools/assembly.ts` — external descriptor order. Rollback: remove
  sort.
- `src/bootstrap.ts` — stream options. Rollback: remove `cacheRetention`
  line.
- Test files — expected order assertions. Rollback: revert expected
  arrays.

## Follow-Up Checks

- Verify that connecting/disconnecting an MCP server in a TUI session
  does not reshuffle builtin tools in `/tools` output.
- Verify that `cacheRead`/`cacheWrite` token counts in `/status` are
  non-zero after a multi-turn session (indicating prompt caching is
  active).