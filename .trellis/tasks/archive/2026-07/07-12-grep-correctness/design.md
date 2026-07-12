# grep correctness — technical design

## Architecture

All changes are within `src/tools/grep.ts`. No new files. The schema gains three optional parameters; the ripgrep command construction and fallback scan logic are updated to honor them.

## Changes

### 1. Schema

```ts
const Parameters = Type.Object({
  pattern: Type.String(),
  path: Type.Optional(Type.String()),
  glob: Type.Optional(Type.String()),
  ignoreCase: Type.Optional(Type.Boolean()),
  literal: Type.Optional(Type.Boolean()),
  context: Type.Optional(Type.Number()),
});
```

### 2. ripgrep command construction

```ts
const parts = ["rg", "--line-number", "--no-heading", "--color", "never", "--null"];
if (ignoreCase) parts.push("-i");
if (literal) parts.push("--fixed-strings");
if (glob) parts.push("--glob", shellQuote(glob));
if (context && context > 0) parts.push("-C", String(context));
parts.push("-e", shellQuote(pattern), "--", shellQuote(base));
```

`--null` is always added (replaces `:` with NUL between fields). This is safe — ripgrep 13+ supports it unconditionally.

### 3. parseRipgrep with NUL separator

Current (broken on colons):
```ts
const c1 = line.indexOf(":");
const c2 = line.indexOf(":", c1 + 1);
```

New:
```ts
function parseRipgrep(stdout: string): GrepMatch[] {
  const matches: GrepMatch[] = [];
  for (const record of stdout.split("\n")) {
    if (!record) continue;
    const parts = record.split("\0");
    // With --null: [file, line, text]
    // Context lines (--null with -C): may produce [file, line, text] for matched lines
    // and [file, line, text] for context lines — both have the same 3-field shape.
    if (parts.length < 3) continue;
    matches.push({ file: parts[0], line: Number(parts[1]), text: parts[2] });
  }
  return matches;
}
```

Note: with `--null` and `-C`, ripgrep separates context lines from match lines using a `--` separator line. The parser should handle empty `text` fields and the `--` separator gracefully (skip records that don't have 3 NUL-separated fields).

### 4. Fallback engine — glob parity

```ts
// Before (basename only):
if (glob && !minimatch(f.name, glob, { dot: true })) continue;

// After (full relative path):
if (glob) {
  const rel = path.relative(base, f.path);
  if (!minimatch(rel, glob, { dot: true })) continue;
}
```

### 5. Fallback engine — new options

```ts
// Build regex with flags
let re: RegExp;
try {
  const flags = ignoreCase ? "gi" : "g";
  const patternStr = literal ? escapeRegex(pattern) : pattern;
  re = new RegExp(patternStr, flags);
} catch (e) { throw new Error(...); }

// Context lines
const contextN = context && context > 0 ? context : 0;
// Track which line numbers are already output to avoid duplicates from overlapping context windows
const seen = new Set<number>();
for (const f of files) {
  // ... glob filter ...
  const lines = res.value.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) {
      for (let j = Math.max(0, i - contextN); j <= Math.min(lines.length - 1, i + contextN); j++) {
        if (!seen.has(j)) {
          seen.add(j);
          matches.push({ file: f.path, line: j + 1, text: lines[j] });
        }
      }
    }
  }
}
// Sort matches by file then line (context expansion may produce out-of-order)
matches.sort((a, b) => a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1);
```

`escapeRegex`: use `RegExp.escape(pattern)` if available (Node 22+), otherwise manual:
```ts
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
```

### 6. Context output formatting

`formatMatches` stays the same — it just renders `file:line:text` for each match. With context, the match list already includes context lines (from either engine), so no formatting change needed. The model sees them as additional lines in the output, which is the expected behavior.

## Data Flow

```
execute
  → resolve base path
  → tryRipgrep(pattern, base, glob, ignoreCase, literal, context, signal)
    → if rg available: run rg with --null + flags → parse NUL output
    → if rg unavailable: fallback scan with regex + glob(relativePath) + context
  → formatMatches (unchanged)
  → truncateWithFooter (from child task 1, if applied)
  → return result
```

## Compatibility

- New parameters are all optional — existing calls without them behave exactly as before (except `--null` which changes the parser, but output text is identical to the model).
- `GrepMatch` interface unchanged.
- `details.engine` unchanged.

## Trade-offs

- **`--null` always on**: slightly changes the rg invocation, but the output is equivalent after parsing. No downside.
- **Context in fallback uses `Set<number>` dedup**: adds per-file state, but files are processed one at a time so the set is per-file (reset between files).
- **`RegExp.escape` availability**: Node 22.19+ has it (ES2025). If not available, manual escaping is a 1-liner. Prefer `RegExp.escape` with manual fallback.

## Rollback

Revert `grep.ts` to previous version. No schema or interface changes to undo beyond the file itself.