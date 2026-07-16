# Implement: Read Tool Result Dedup Caching

## Ordered Checklist

### 1. Create `ReadResultCache` class

- [ ] New file `src/tools/runtime/read-cache.ts`
- [ ] Implement `ReadResultCache` per design.md: `get`, `set`,
      `invalidateByPath`, `clear`
- [ ] Key: serialized `[absPath, offset, limit]`; path index for batch
      invalidation
- [ ] Unit test `src/tools/runtime/read-cache.test.ts`: get/set/miss,
      stat mismatch → miss, invalidateByPath, clear, multiple offset/limit
      independence

### 2. Wire `ReadResultCache` into `ToolExecutionRuntime`

- [ ] In `src/tools/runtime/runtime.ts`: add `readonly readCache:
      ReadResultCache` field, initialized in constructor
- [ ] Export `ReadResultCache` from `src/tools/runtime/index.ts`

### 3. Add cache check to `read_file`

- [ ] In `src/tools/read-file.ts`: after path resolution, call
      `env.fileInfo(abs)` to get stat
- [ ] Check `runtime.readCache.get(key, stat)`; on hit, return hint
      text result with `details.cache = "hit"`
- [ ] On miss, proceed with existing streaming pipeline, then call
      `runtime.readCache.set(key, stat)` and add `details.cache = "miss"`
- [ ] Hint text: `"[cached] File unchanged since last read (<path>, offset=<offset>, limit=<limit>). Refer to that earlier tool_result."`
- [ ] Update `read-file.test.ts`: test hit (unchanged file), miss (first
      read), miss after external edit (stat mismatch), different offset/
      limit independence

### 4. Add invalidation to `edit_file`

- [ ] Change `createEditFileTool` signature from `(env, scopeGuard, budget)`
      to `(env, scopeGuard, runtime: ToolExecutionRuntime)`
- [ ] Use `runtime.budget` where `budget` was used
- [ ] After successful write, call
      `runtime.readCache.invalidateByPath(abs)`
- [ ] Update `index.ts` descriptor factory: pass `runtime` instead of
      `runtime!.budget`
- [ ] Update `edit-file.test.ts`: verify cache invalidated after edit

### 5. Add invalidation to `write_file`

- [ ] Change `createWriteFileTool` signature from `(env, scopeGuard)` to
      `(env, scopeGuard, runtime: ToolExecutionRuntime)`
- [ ] After successful write, call
      `runtime.readCache.invalidateByPath(abs)`
- [ ] Update `index.ts` descriptor factory: pass `runtime`
- [ ] Update `write-file.test.ts`: verify cache invalidated after write

### 6. Add compaction reset

- [ ] In bootstrap (`src/bootstrap.ts`): register a `session_before_compact`
      hook handler (or equivalent) that calls `runtime.readCache.clear()`
- [ ] Alternatively, wire into `AutoCompactor` in `src/compaction.ts` if
      the hook path is too complex for this task scope
- [ ] Test: after compaction, read cache is empty

### 7. Full validation

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

- `src/tools/runtime/runtime.ts` — core runtime, changes here affect all
  tools. Rollback: remove `readCache` field.
- `src/tools/read-file.ts` — read path change. Rollback: remove cache
  check block.
- `src/tools/edit-file.ts`, `src/tools/write-file.ts` — signature
  changes. Rollback: revert to `(env, scopeGuard, budget)` /
  `(env, scopeGuard)`.
- `src/tools/index.ts` — factory wiring. Rollback: revert factory
  arguments.

## Follow-Up Checks

- Verify that a real session (TUI) shows `[cached]` hint on repeated reads.
- Verify that editing a file in an external editor (not through Novi)
  triggers a cache miss on the next read.