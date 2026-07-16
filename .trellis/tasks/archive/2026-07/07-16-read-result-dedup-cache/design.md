# Design: Read Tool Result Dedup Caching

## Architecture

The read cache is a per-session, in-memory stat snapshot store hosted on
`ToolExecutionRuntime`. It intercepts `read_file` before the streaming
pipeline and short-circuits unchanged re-reads with a hint result.

```
ToolExecutionRuntime (session-scoped)
  └── ReadResultCache
        Map<key: (absPath, offset, limit), value: { mtimeMs, size }>
```

## Data Flow

### Cache hit path

```
read_file(params)
  → scopeGuard.assertNativeFileAccess(...)
  → abs = resolveAbsolutePath(params.path)
  → stat = env.fileInfo(abs)               // O(1) syscall
  → key = (abs, params.offset, params.limit)
  → entry = cache.get(key)
  → if entry && entry.mtimeMs === stat.mtimeMs && entry.size === stat.size:
       return hintResult(params, "hit")    // no file stream opened
```

### Cache miss path

```
  → else:
       // existing streaming read pipeline (createReadStream → capture)
       result = streamRead(...)
       cache.set(key, { mtimeMs: stat.mtimeMs, size: stat.size })
       return result with details.cache = "miss"
```

### Edit/write invalidation

```
edit_file(params) / write_file(params)
  → ... write succeeds ...
  → cache.invalidateByPath(abs)   // batch delete all (abs, *, *) entries
```

### Compaction reset

```
AutoCompactor / session_before_compact hook
  → cache.clear()
```

## Contracts

### New: `ReadResultCache`

```ts
interface ReadCacheKey {
  absPath: string;
  offset: number;   // 1-based, default 1
  limit: number | undefined;
}

interface ReadCacheEntry {
  mtimeMs: number;
  size: number;
}

class ReadResultCache {
  private entries = new Map<string, ReadCacheEntry>();
  // path → set of serialized keys, for batch invalidation
  private pathIndex = new Map<string, Set<string>>();

  private key(k: ReadCacheKey): string {
    return JSON.stringify([k.absPath, k.offset ?? 1, k.limit ?? null]);
  }

  get(k: ReadCacheKey, stat: { mtimeMs: number; size: number }): ReadCacheEntry | undefined {
    const entry = this.entries.get(this.key(k));
    if (!entry) return undefined;
    if (entry.mtimeMs !== stat.mtimeMs || entry.size !== stat.size) {
      this.deleteKey(k);
      return undefined;
    }
    return entry;
  }

  set(k: ReadCacheKey, stat: { mtimeMs: number; size: number }): void {
    const keyStr = this.key(k);
    this.entries.set(keyStr, { mtimeMs: stat.mtimeMs, size: stat.size });
    let set = this.pathIndex.get(k.absPath);
    if (!set) { set = new Set(); this.pathIndex.set(k.absPath, set); }
    set.add(keyStr);
  }

  invalidateByPath(absPath: string): void {
    const keys = this.pathIndex.get(absPath);
    if (!keys) return;
    for (const keyStr of keys) this.entries.delete(keyStr);
    this.pathIndex.delete(absPath);
  }

  clear(): void {
    this.entries.clear();
    this.pathIndex.clear();
  }

  private deleteKey(k: ReadCacheKey): void {
    const keyStr = this.key(k);
    this.entries.delete(keyStr);
    const set = this.pathIndex.get(k.absPath);
    if (set) { set.delete(keyStr); if (set.size === 0) this.pathIndex.delete(k.absPath); }
  }
}
```

### `ToolExecutionRuntime` changes

Add a `readonly readCache: ReadResultCache` field. The cache is created in
the constructor and lives for the lifetime of the runtime (session-scoped).

### `read_file` changes

The `createReadFileTool` factory already receives `runtime`. Before the
streaming pipeline, add the cache check using `runtime.readCache` and
`env.fileInfo`. On a hit, return a `textResult` with the hint text and
`details.cache = "hit"`. On a miss, after the existing `capture.finalize`,
store the stat snapshot and add `cache: "miss"` to details.

### `edit_file` / `write_file` changes

Both factories need access to the `ReadResultCache`. Currently `edit_file`
receives `budget` and `write_file` receives neither runtime nor budget.

Option: Change `edit_file` to receive `runtime` (instead of just `budget`)
and `write_file` to receive `runtime`. After a successful write, call
`runtime.readCache.invalidateByPath(abs)`.

Alternatively, the `ToolExecutionRuntime.wrap()` layer could detect
`edit_file`/`write_file` by tool name and invalidate automatically — but
this couples the runtime to specific tool names. Prefer explicit
invalidation calls in the tool implementations.

### Compaction reset

In `src/compaction.ts`, the `AutoCompactor` calls `harness.compact()`.
The harness emits `session_before_compact`. Two options:

1. **Hook approach**: Register a hook handler for `session_before_compact`
   that calls `runtime.readCache.clear()`. This is clean but requires
   wiring the runtime into the hook system.

2. **Direct approach**: The `AutoCompactor` already has access to the
   harness. After `harness.compact()` returns, clear the cache. But the
   compactor doesn't own the runtime.

3. **Event-driven**: Listen for the `session_compact` event in the TUI
   `useHarnessState` hook (where `reloadMessages` already fires on compact)
   and clear the cache there. This is fragile because it's TUI-specific.

**Recommended**: Option 1 — register a `session_before_compact` hook
handler during bootstrap that clears the read cache. This is consistent
with how other hook handlers work and covers all surfaces (TUI, Headless,
Gateway).

## Compatibility

- No public API change to `read_file`, `edit_file`, or `write_file` tool
  schemas. The cache is transparent to the model except for the hint text.
- `createReadFileTool` signature changes: it already receives `runtime`,
  no change needed.
- `createEditFileTool` signature changes: from `(env, scopeGuard, budget)`
  to `(env, scopeGuard, runtime)`. The `budget` is accessible via
  `runtime.budget`.
- `createWriteFileTool` signature changes: from `(env, scopeGuard)` to
  `(env, scopeGuard, runtime)`. The runtime is used only for cache
  invalidation.
- Descriptor factories in `src/tools/index.ts` that construct these tools
  must pass `runtime` instead of `budget`.

## Tradeoffs

- **Stat vs hash**: Stat is O(1) but can miss sub-second edits on
  filesystems with 1-second mtime granularity. Acceptable for Novi's
  single-machine local usage.
- **Hint vs full content**: Hint saves tokens but relies on the model
  understanding "refer to earlier tool_result." All major models handle
  this well in practice (Claude Code uses the same pattern).
- **In-memory vs disk**: In-memory is fast and simple but doesn't survive
  session resume. Since the cache is only a stat snapshot (not content),
  rebuilding it on resume is cheap (one stat per re-read).