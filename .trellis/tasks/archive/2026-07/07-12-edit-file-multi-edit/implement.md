# edit_file multi-edit — execution plan

## Ordered Checklist

1. [ ] Update the typebox `Parameters` schema in `src/tools/edit-file.ts`:
   - Replace `oldText` / `newText` top-level fields with `edits: Type.Array(Type.Object({ oldText: Type.String(), newText: Type.String() }))`

2. [ ] Add `prepareEditArguments` function (legacy compat shim):
   - Handle `edits` as JSON string → parse to array
   - Handle legacy top-level `oldText` + `newText` → push into `edits[]`, strip top-level fields
   - Add `prepareArguments: prepareEditArguments` to the tool definition

3. [ ] Add `singleOrMultiError(msg, path, editIndex, totalEdits)` helper:
   - Single edit: `edit_file: <msg> in "<path>".`
   - Multi edit: `edit_file: edits[<i>] <msg> in "<path>".`

4. [ ] Rewrite `execute`:
   - Read file (unchanged)
   - Validate: `edits` non-empty array, each `oldText` non-empty
   - Match phase: for each edit, count occurrences in original text; collect `{index, oldText, newText}`. 0 → not found error; >1 → not unique error
   - Overlap detection: sort by index, reject if `prev.index + prev.oldText.length > curr.index`
   - Apply: reverse order, `result.slice(0, index) + newText + result.slice(index + oldText.length)`
   - Write file (unchanged)
   - Return `textResult("edited <path>", { path, replaced: edits.length })`

5. [ ] Update existing tests in `src/tools/__tests__/edit-file.test.ts`:
   - Existing single-edit tests: pass `{path, oldText, newText}` (legacy form) — should still pass via `prepareArguments`
   - Add test: multi-edit with `edits: [{oldText, newText}, ...]` — both applied
   - Add test: legacy form still works (explicit)
   - Add test: one edit not found in multi-edit → throws, file unchanged
   - Add test: one edit not unique in multi-edit → throws with `edits[i]` in message
   - Add test: overlapping edits → throws
   - Add test: `edits` as JSON string → handled

6. [ ] Run full validation:
   ```bash
   npm run typecheck && npm run lint && npm test
   ```

## Validation Commands

- `npx tsc --noEmit`
- `npx eslint src/tools/edit-file.ts`
- `npx vitest run src/tools/__tests__/edit-file.test.ts`

## Review Gates

- After step 4: review the match → overlap → apply flow (most logic-dense part)
- After step 5: verify atomicity test (file unchanged on partial failure) actually checks the file was not written
- After step 6: full suite green

## Rollback Points

- Revert `edit-file.ts` — schema + prepareArguments + execute are all in one file
- Existing tests updated in step 5 may need reverting too (new tests removed, legacy tests kept)

## Notes

- TUI `ToolCallBlock.tsx` references `args.oldText`/`args.newText` for diff rendering. After this change, the primary form uses `edits[]`. The TUI diff will not render correctly for multi-edit calls until updated — this is a known display-only issue, out of scope for this task. The tool result is correct regardless.