# Tool-level Caching and Cache-Aware Tool Registration

## Goal

Reduce wasted tokens and improve prompt cache hit rates by (1) deduplicating
repeated read-tool calls within a session when the file is unchanged, and (2)
stabilizing the tool-definition prefix sent to the model so prompt caching
remains effective across turns and MCP server changes.

## Parent Scope

This is a parent task owning two independently verifiable child deliverables:

- **Child A — `07-16-read-result-dedup-cache`**: per-session read-tool result
  caching with stat-based invalidation, edit/write invalidation, and
  compaction reset.
- **Child B — `07-16-cache-aware-tool-registration`**: deterministic,
  cache-stable tool registration ordering (builtin sorted prefix + external
  sorted suffix) plus enabling `cacheRetention` in stream options.

The parent owns cross-child acceptance criteria and final integration review.
Children may be planned, implemented, checked, and archived independently.
Child B does not depend on Child A; either may land first.

## Background (confirmed from codebase)

- `src/tools/read-file.ts`: streaming `createReadStream`, no caching, no stat
  check. Every `read_file` call re-reads the full file.
- `src/tools/edit-file.ts`, `src/tools/write-file.ts`: modify files but do not
  notify any read cache.
- `src/tools/runtime/runtime.ts`: `ToolExecutionRuntime` is session-scoped and
  already wraps every tool call; it owns timeout, bounded output, artifacts,
  and the concurrency semaphore. Natural owner for a per-session read cache.
- `src/tools/index.ts`: builtin descriptors are registered in a hardcoded order
  (read_file, write_file, edit_file, bash, ls, glob, grep, todo, web_search,
  fetch_content) — not alphabetically sorted.
- `src/tools/assembly.ts` `buildMergedAssembly`: registers builtins first, then
  `additionalDescriptors`, then MCP-adapted tools. Builtin/external separation
  already exists, but neither group is sorted, and the `mergeToolDescriptors`
  helper also concatenates without sorting.
- `src/tools/registry.ts` `ToolRegistry.build`: iterates descriptors in
  insertion order. No sort step.
- `src/bootstrap.ts` (line ~412): builds `streamOptions` without setting
  `cacheRetention`. The field exists on `AgentHarnessStreamOptions` and is
  forwarded to the provider.
- `@earendil-works/pi-ai` providers already support prompt caching: Anthropic
  uses `cacheControlFormat: "anthropic"`, applies `cache_control` markers to
  system prompt, last tool definition, and last user/assistant text content;
  OpenAI uses session-id affinity headers. `supportsCacheControlOnTools`
  controls whether tool definitions get cache markers.
- `src/compaction.ts`: `AutoCompactor` triggers on context threshold; no hook
  to reset a read cache today, but `session_before_compact` hook event exists.
- `src/tools/web/cache.ts`: web tools already have a disk cache with
  TTL + retention; this is a separate subsystem and not affected.

## Cross-Child Acceptance Criteria

1. A repeated `read_file` call for an unchanged file (same path, same
   offset/limit, unchanged mtime+size) returns a lightweight hint text
   `"[cached] File unchanged since last read (path, offset, limit). Refer to
   that earlier tool_result."` with `details.cache: "hit"`, without re-reading
   the file from disk. Full file content is NOT re-sent; the model is told to
   refer to the earlier tool_result.
2. After `edit_file` or `write_file` modifies a file, the per-session read
   cache entry for that path is invalidated (deleted) so a subsequent
   `read_file` returns fresh content, not a stale cached snapshot.
3. After compaction, the read cache is reset so the model can re-read files
   whose previous tool results were summarized away.
4. Cache invalidation uses stat (mtime+size) checked via `env.fileInfo` on
   every `read_file` call. This detects external modifications (IDE, other
   processes) as well as Novi's own edit/write operations.
5. Cache key is `(resolvedAbsolutePath, offset, limit)`. Different read ranges
   of the same file are cached independently. When a file's stat changes, all
   cache entries for that path are invalidated as a batch.
6. Cache value is a stat snapshot (mtime+size) only — no file content is
   stored. Memory overhead is negligible (~48 bytes per entry), so no LRU or
   size limit is needed. On a cache hit, the hint text is returned without
   reading the file; on a miss, the file is read normally and the stat
   snapshot is stored.
7. Builtin tool descriptors are assembled in deterministic alphabetical
   order by `descriptor.name`. External (MCP) tool descriptors follow as a
   separately sorted suffix (also alphabetical by name). The two groups
   never interleave. The sorted builtin order is: `bash, edit_file,
   fetch_content, glob, grep, ls, read_file, todo, web_search, write_file`.
8. Connecting or disconnecting an MCP server does not change the order of
   builtin tools in the assembled catalog or the model-visible tool list.
9. `cacheRetention` is explicitly set to `"short"` in `streamOptions` so
   the provider applies prompt-cache breakpoints (including on the last tool
   definition for Anthropic-compatible providers). The value is explicit
   rather than relying on the downstream default.
10. All existing tool tests, typecheck, lint, and build pass.

## Out of Scope

- Prompt-level cache breakpoint placement on individual messages (pi-ai
  handles this internally via `cacheControlFormat`).
- Session pruning of old tool results (separate future task).
- System prompt tiering (stable/context/volatile split).
- Caching for `ls`, `glob`, `grep`, or `bash` results (only `read_file`).
- Cross-session read cache persistence.