# Tool output truncation — execution plan

## Ordered Checklist

1. [ ] Add `truncateWithFooter(content, "head"|"tail")` helper to `src/tools/shared.ts`
   - Import `truncateHead`, `truncateTail`, `truncateLine`, `DEFAULT_MAX_LINES`, `DEFAULT_MAX_BYTES`, `GREP_MAX_LINE_LENGTH`, `TruncationResult` from `@earendil-works/pi-agent-core/node`
   - Return type: `{ text: string; truncated: boolean; truncatedBy: "lines"|"bytes"|null; totalLines: number; totalBytes: number; outputLines: number; outputBytes: number }`
   - Footer: `[Output truncated: {truncatedBy} limit hit. Original: {totalLines} lines / {totalBytes} bytes. Showing {outputLines} lines / {outputBytes} bytes.]`
   - Unit test in `tools/__tests__/shared.test.ts` (or inline in an existing test file)

2. [ ] `src/tools/bash.ts`: apply `truncateWithFooter(body, "tail")` before `textResult`
   - Keep `details.exitCode/stdout/stderr` as raw values
   - Add `details.truncation` from result
   - Test: command producing >2000 lines → ≤2000 lines + footer; >50KB → ≤50KB + footer

3. [ ] `src/tools/read-file.ts`: apply `truncateWithFooter(sliced, "head")` after `sliceLines`
   - Add `details.truncation`
   - Test: file >2000 lines, no `limit` → ≤2000 lines + footer; with `limit` under 2000 → no truncation

4. [ ] `src/tools/grep.ts`:
   - In `formatMatches` (or match construction), apply `truncateLine(m.text, GREP_MAX_LINE_LENGTH)` to each match text
   - Apply `truncateWithFooter(formatted, "head")` to the joined match list
   - Apply per-line truncation in **both** ripgrep `parseRipgrep` path and fallback path (do it in `formatMatches` to cover both)
   - Add `details.truncation` (the line-level truncation is visible in the text; no need to track it in details)
   - Test: match line >500 chars → truncated with suffix; >2000 matches → ≤2000 lines + footer

5. [ ] `src/tools/glob.ts`: apply `truncateWithFooter(joined, "head")` before `textResult`
   - Add `details.truncation`
   - Test: pattern matching >2000 files → ≤2000 lines + footer

6. [ ] `src/tools/ls.ts`: apply `truncateWithFooter(joined, "head")` before returning
   - Add `details.truncation`
   - Test: directory with >2000 entries → ≤2000 lines + footer

7. [ ] Verify `truncateLine` behavior: read the `.d.ts` or runtime to confirm whether it appends `[truncated]` automatically. If yes, don't double-append. If no, append when `wasTruncated === true`.

8. [ ] Run full validation:
   ```bash
   npm run typecheck && npm run lint && npm test
   ```

## Validation Commands

- `npx tsc --noEmit` — typecheck
- `npx eslint src/tools/` — lint the changed files
- `npx vitest run src/tools/__tests__/` — run all tool tests
- `npx vitest run src/tools/__tests__/bash.test.ts` — targeted

## Review Gates

- After step 1: confirm helper signature and footer format with a quick review
- After step 4: grep has the most complex change (per-line + list truncation) — review before proceeding
- After step 8: full suite green before marking child complete

## Rollback Points

- Each step is independently revertible (git revert the tool file change)
- The `truncateWithFooter` helper in `shared.ts` is additive — removing it is safe if all callers are removed first