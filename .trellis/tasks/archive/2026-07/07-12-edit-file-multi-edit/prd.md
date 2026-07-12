# edit_file multi-edit support: array of edits in one call

## Goal

Support applying multiple text replacements in a single `edit_file` call, reducing round-trips and retry loops when the model needs to change several disjoint locations in one file.

## Background

Current `src/tools/edit-file.ts` accepts `{ path, oldText, newText }` for a single replacement. The model must issue multiple `edit_file` calls to change multiple locations, each requiring `oldText` to be globally unique in the file — hard for large files, and often leads to `>1 matches` retry loops.

pi's edit tool (`@earendil-works/pi-coding-agent/dist/core/tools/edit.js`) uses `{ path, edits: [{oldText, newText}] }` as the primary schema, with a `prepareArguments` shim that converts legacy `{path, oldText, newText}` into `edits: [{oldText, newText}]`.

Confirmed decisions:
- **API**: primary schema is `{ path, edits: [{oldText, newText}] }`; `prepareArguments` converts legacy `{path, oldText, newText}` → `edits: [{oldText, newText}]` for backward compatibility.
- **Application semantics**: all edits match against the **original file content** (not incrementally); edits are applied in reverse order by match position so offsets stay stable. Overlapping edits are rejected. **Atomic**: any edit failing (not found / not unique / overlap) → entire operation throws, file is not written.
- **Out of scope**: fuzzy matching, BOM stripping, CRLF/LF normalization, diff/patch generation — these are pi enhancements beyond current needs.

## Requirements

- Schema: `{ path: string, edits: Array<{ oldText: string, newText: string }> }`.
- `prepareArguments`: if input has top-level `oldText`+`newText` (legacy form), convert to `edits: [{oldText, newText}]` and strip the top-level fields. If input already has `edits`, pass through. Also handle the edge case where a model sends `edits` as a JSON string (parse it).
- Validation: `edits` must be a non-empty array; each edit must have non-empty `oldText`.
- Matching: each edit's `oldText` is searched in the original file content. Must match exactly once (0 → "not found" error, >1 → "not unique" error). Error messages should reference `edits[i]` when there are multiple edits, or use a simpler message for single-edit calls (matching pi's style).
- Overlap detection: sort matched positions by index; reject if any edit's range `[matchIndex, matchIndex + oldText.length)` overlaps the next edit's range.
- Application: apply replacements in reverse order (highest matchIndex first) so earlier offsets remain stable.
- Atomicity: read file → validate all edits → if any fails, throw without writing. Only write after all edits pass validation.
- Return: `textResult("edited <path>", { path, replaced: <editCount> })` on success.

## Acceptance Criteria

- [ ] A call with `edits: [{oldText: "a", newText: "x"}, {oldText: "b", newText: "y"}]` applies both replacements atomically
- [ ] Legacy call `{path, oldText, newText}` still works (via `prepareArguments`)
- [ ] When one edit in a multi-edit call has 0 matches, the entire operation throws and the file is unchanged
- [ ] When one edit in a multi-edit call has >1 matches, the entire operation throws with a clear error referencing `edits[i]`
- [ ] Overlapping edits (same region) are rejected with an error
- [ ] `edits` as a JSON string is handled by `prepareArguments`
- [ ] `npm test` passes with new tests for multi-edit, legacy compat, atomicity, overlap
- [ ] `tsc --noEmit` passes
- [ ] `eslint` passes

## Out of Scope

- Fuzzy matching (trailing whitespace / Unicode normalization fallback)
- BOM detection and stripping
- CRLF/LF line ending detection and restoration
- Diff/patch generation in `details`
- File mutation queue (concurrent edit serialization)
- `prepareArguments` for non-string/JSON-string `edits` beyond the basic case pi handles

## Constraints

- `prepareArguments` is an optional property on `AgentTool` — add it to the tool definition.
- `execute` signature unchanged (4 params: toolCallId, params, signal, onUpdate).
- Tools depend only on `ExecutionEnv` + node stdlib + pi-agent-core public exports.
- The `PermissionGate` and `summarizeToolInput` currently reference `edit_file` with `path` — the `path` field is unchanged, so no permission changes needed.