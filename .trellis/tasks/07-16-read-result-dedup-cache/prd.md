# Read Tool Result Dedup Caching

## Goal

Add a per-session read-result cache to `read_file` that short-circuits
repeated reads of unchanged files with a lightweight hint, reducing wasted
tokens and context bloat from redundant file reads.

## Parent

Child A of `07-16-tool-caching-and-cache-aware-registration`.

## Requirements

1. **Cache location**: The cache lives on the session-scoped
   `ToolExecutionRuntime` (`src/tools/runtime/runtime.ts`). It is an
   in-memory `Map` keyed by `(resolvedAbsolutePath, offset, limit)` and
   valued by a stat snapshot `{ mtimeMs, size }`. No file content is stored.

2. **Cache check**: On every `read_file` call, after permission/scope checks
   and path resolution, call `env.fileInfo(abs)` to get the current stat.
   - If a cache entry exists for `(abs, offset, limit)` and its
     `{ mtimeMs, size }` matches the current stat → **cache hit**: return
     a hint text result without reading the file.
   - Otherwise → **cache miss**: read the file normally via the existing
     streaming pipeline, then store the new stat snapshot in the cache.

3. **Hint text on hit**: Return:
   ```
   content: [{ type: "text", text: "[cached] File unchanged since last read (<path>, offset=<offset>, limit=<limit>). Refer to that earlier tool_result." }]
   details: { cache: "hit", path, offset, limit, resource: { outputBytes, outputLines } }
   ```
   The hint must include the original `path`, `offset`, and `limit` values so
   the model can locate the earlier tool_result.

4. **Edit/write invalidation**: After `edit_file` or `write_file` successfully
   modifies a file, the cache must remove all entries for that resolved path
   (all offset/limit variants). This is a batch delete by path prefix.

5. **Compaction reset**: When compaction fires (`session_before_compact` hook
   or the `AutoCompactor` trigger in `src/compaction.ts`), the entire read
   cache is cleared. After compaction, old tool results are summarized away,
   so the model must be able to re-read files and get full content again.

6. **Stat-based invalidation**: Because stat is checked on every call,
   external modifications (IDE saves, other processes) are automatically
   detected. The edit/write invalidation (requirement 4) is an optimization
   that avoids a redundant stat mismatch on the next read, but stat remains
   the source of truth.

7. **No content stored**: The cache stores only stat snapshots (~48 bytes per
   entry). No LRU, no size limit, no TTL. The cache is bounded by the number
   of distinct (path, offset, limit) combinations read in a session, which is
   naturally small.

8. **No cross-session persistence**: The cache is in-memory only, scoped to
   the `ToolExecutionRuntime` instance. Resumed sessions get a fresh cache.

## Acceptance Criteria

- [ ] A repeated `read_file` call for an unchanged file returns the hint text
      with `details.cache: "hit"` and does not open a file stream.
- [ ] After `edit_file` modifies a file, a subsequent `read_file` of that
      path returns fresh content (cache miss), not the hint.
- [ ] After `write_file` creates/overwrites a file, a subsequent `read_file`
      of that path returns fresh content.
- [ ] After an external modification changes the file's mtime+size, a
      `read_file` call returns fresh content (stat mismatch → miss).
- [ ] After compaction, a `read_file` call for a previously-cached file
      returns full content, not the hint.
- [ ] Different `(offset, limit)` ranges of the same file are cached
      independently.
- [ ] `npm run typecheck`, `npm run lint`, `npm run test`, `npm run build`
      pass.

## Out of Scope

- Caching for `ls`, `glob`, `grep`, or `bash` results.
- Cross-session cache persistence.
- Content hash fallback for filesystems without reliable mtime.
- Storing full file content for replay.