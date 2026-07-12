# grep correctness — execution plan

## Ordered Checklist

1. [ ] Add three optional params (`ignoreCase`, `literal`, `context`) to the typebox `Parameters` schema in `src/tools/grep.ts`

2. [ ] Fix colon-in-path parsing:
   - Add `--null` to the rg command parts in `tryRipgrep`
   - Rewrite `parseRipgrep` to split on `\0` instead of `:`: `record.split("\0")` → `[file, line, text]`
   - Test: create a temp dir with a colon in the name (`test:dir/file.txt`), grep for content, verify file/line/text parsed correctly (ripgrep path)

3. [ ] Fix glob semantic parity (fallback engine):
   - Import `path` from `node:path` in `grep.ts` (already imported? check)
   - Change `minimatch(f.name, glob)` → `minimatch(path.relative(base, f.path), glob, { dot: true })`
   - Test: fallback with glob `src/**/*.ts` matches nested file; verify ripgrep and fallback give same results for the same glob

4. [ ] Add `ignoreCase` support:
   - ripgrep: add `-i` when `ignoreCase` is true
   - fallback: `new RegExp(patternStr, ignoreCase ? "gi" : "g")`
   - Test: search "Needle" with `ignoreCase: true` finds "needle" (both engines)

5. [ ] Add `literal` support:
   - ripgrep: add `--fixed-strings` when `literal` is true
   - fallback: escape pattern before building RegExp (use `RegExp.escape` if available, else manual `escapeRegex`)
   - Test: search `array[0]` with `literal: true` finds literal `array[0]` in a file (both engines)

6. [ ] Add `context` support:
   - ripgrep: add `-C <n>` when `context > 0`
   - fallback: expand context window with `Set<number>` dedup per file, sort matches after
   - Test: search with `context: 1` returns 1 line before and after each match (both engines); overlapping windows don't duplicate lines

7. [ ] Handle ripgrep context output format: with `--null` + `-C`, ripgrep may emit `--` separator lines between match groups. Verify parser skips empty/malformed records gracefully (records with <3 NUL fields are skipped).

8. [ ] Run full validation:
   ```bash
   npm run typecheck && npm run lint && npm test
   ```

## Validation Commands

- `npx tsc --noEmit`
- `npx eslint src/tools/grep.ts`
- `npx vitest run src/tools/__tests__/grep.test.ts`

## Review Gates

- After step 2: verify the `--null` parser handles real ripgrep output with colon-in-path (the highest-risk change)
- After step 6: verify context dedup logic with overlapping matches (edge case)
- After step 8: full suite green

## Rollback Points

- Each step is within `grep.ts` — git revert the file restores previous behavior
- The schema change (step 1) is backward-compatible (all new params optional)