# Fix grep tool: colon-in-path parsing, glob semantic parity, add ignoreCase/context/literal options

## Goal

Fix three correctness/compatibility gaps in the grep tool:
1. **Colon-in-path parsing bug**: ripgrep output parser breaks when file paths contain colons.
2. **Glob semantic mismatch**: ripgrep `--glob` matches the full relative path, but the fallback engine uses `minimatch(f.name, glob)` (basename only) — same query gives different results across engines.
3. **Missing options**: `ignoreCase`, `context` (lines before/after), `literal` (treat pattern as literal string, not regex) are absent but commonly needed.

## Background

Current `src/tools/grep.ts`:
- `parseRipgrep` splits `file:line:text` using `indexOf(":")` from the left — breaks on paths like `path:with:colon/file.ts`.
- ripgrep `--glob` matches the full relative path against the glob; fallback uses `minimatch(f.name, glob)` matching only basename. Verified: ripgrep `--glob "*.ts"` matches files at any depth (`src/nested/file.ts`), and `--glob "src/**/*.ts"` matches by path. `minimatch("file.ts", "*.ts")` works for simple cases but `minimatch("file.ts", "src/**/*.ts")` fails (basename doesn't contain the path prefix).
- No way to do case-insensitive search, get context lines, or search for a literal string containing regex metacharacters (e.g. `array[0]`).

## Requirements

### 1. Colon-in-path fix

- Switch ripgrep to NUL-separated output: add `--null` flag to the rg command.
- `--null` changes the output separator from `:` to NUL (`\0`) between file path, line number, and text. Verified output format: `path\0line\0text\n`.
- Update `parseRipgrep` to split on NUL instead of colon: `line.split("\0")` → `[file, lineNumber, text]`.
- Handle the trailing `\n` (split on `\n` first, then each record splits on `\0`).

### 2. Glob semantic parity

- **Fallback engine**: change `minimatch(f.name, glob)` to `minimatch(relativePath, glob, { dot: true })` where `relativePath = path.relative(base, f.path)`. This matches ripgrep's full-relative-path semantics.
- Both engines now match against the full relative path from the search base directory.

### 3. New options

Add three optional parameters to the typebox schema:

- **`ignoreCase`** (`Type.Optional(Type.Boolean())`):
  - ripgrep: add `-i` flag.
  - fallback: `new RegExp(pattern, "i")`.
- **`literal`** (`Type.Optional(Type.Boolean())`):
  - When true, treat `pattern` as a literal string (escape regex metacharacters).
  - ripgrep: add `--fixed-strings` flag (alias `-F`).
  - fallback: escape pattern with `RegExp.escape()` (or manual escaping if not available) before constructing RegExp.
- **`context`** (`Type.Optional(Type.Number())`):
  - Number of context lines to show before and after each match.
  - ripgrep: add `-C <n>` flag.
  - fallback: when scanning lines, include `n` lines before and after each match in the output. Track line numbers to avoid duplicate output for overlapping windows.

## Acceptance Criteria

- [ ] grep on a file path containing a colon returns correct file/line/text (ripgrep path)
- [ ] grep fallback with glob `src/**/*.ts` matches nested files (not just basename)
- [ ] grep with `ignoreCase: true` finds matches regardless of case (both engines)
- [ ] grep with `literal: true` finds `array[0]` as literal text, not as regex (both engines)
- [ ] grep with `context: 2` shows 2 lines before and after each match (both engines)
- [ ] `npm test` passes with new tests for each fix/option
- [ ] `tsc --noEmit` passes
- [ ] `eslint` passes

## Out of Scope

- `multiline` regex mode
- `glob` exclude patterns (`--glob '!...'`)
- Output truncation (handled by child task `tool-output-truncation`)
- Binary file detection / skip

## Constraints

- ripgrep fallback (when rg unavailable) must support all three new options with equivalent semantics.
- `--null` flag must not change when ripgrep is unavailable (only affects rg command construction).
- Context lines in fallback must not produce duplicate lines for overlapping windows (deduplicate by line number).
- `RegExp.escape` is available in Node 22+ — verify before using, otherwise implement manual escaping.