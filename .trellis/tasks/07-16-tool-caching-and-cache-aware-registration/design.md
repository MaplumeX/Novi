# Design: Tool-level Caching and Cache-Aware Tool Registration (Parent)

## Parent Role

This parent task does not directly implement code. It owns the cross-child
requirements, task map, and final integration review. Implementation lives
entirely in the two children:

- `07-16-read-result-dedup-cache/design.md` — Read result dedup cache
- `07-16-cache-aware-tool-registration/design.md` — Cache-aware tool ordering

## Integration Points

The two children are independent but share the `ToolExecutionRuntime` and
`src/tools/index.ts` surface:

- **Child A** adds a `ReadResultCache` to `ToolExecutionRuntime` and
  modifies `read-file.ts`, `edit-file.ts`, `write-file.ts`, and
  `compaction.ts` wiring.
- **Child B** sorts descriptors in `index.ts` and `assembly.ts`, and adds
  `cacheRetention` to `bootstrap.ts`.

If both children are implemented, `index.ts` descriptor factories for
`edit_file` and `write_file` will change (Child A changes factory args to
pass `runtime`). Child B's sort of the `descriptors` array does not touch
factory signatures. The merge order is: apply Child B's sort first (it's a
one-line sort), then Child A's factory signature changes. No conflict.

## Final Integration Review

After both children are archived, verify:

1. The tool list sent to the model is alphabetically sorted (builtins first,
   externals second).
2. `cacheRetention: "short"` is set in stream options.
3. Repeated `read_file` of an unchanged file returns the hint.
4. `edit_file`/`write_file` invalidates the read cache.
5. Compaction clears the read cache.
6. `npm run typecheck && npm run lint && npm run test && npm run build`
   passes.