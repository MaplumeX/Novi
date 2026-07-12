# Tool output truncation — technical design

## Architecture

No new modules. The change adds a truncation step to each tool's `execute` function, between producing the raw output string and wrapping it in `textResult`.

### Shared helper

Add one helper to `src/tools/shared.ts`:

```ts
import { truncateHead, truncateTail, truncateLine, DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES, GREP_MAX_LINE_LENGTH, type TruncationResult } from "@earendil-works/pi-agent-core/node";
```

A single `truncateWithFooter(content, direction: "head" | "tail")` helper:
- Calls `truncateHead(content)` or `truncateTail(content)` (both default to `DEFAULT_MAX_LINES` / `DEFAULT_MAX_BYTES`).
- If `!result.truncated`, returns `content` as-is + `truncated: false`.
- If `result.truncated`, appends a footer line: `\n[Output truncated: {truncatedBy} limit hit. Original: {totalLines} lines / {totalBytes} bytes. Showing {outputLines} lines / {outputBytes} bytes.]`.
- Returns `{ text, truncated, truncatedBy, totalLines, totalBytes, outputLines, outputBytes }`.

This keeps all 5 tools DRY — each calls `truncateWithFooter(raw, "head"|"tail")` and passes the metadata into `details`.

### Per-tool integration

| Tool | Raw output | Direction | Notes |
|------|-----------|-----------|-------|
| bash | `exit {code}\n{stdout}{stderr?}` | tail | Truncate the full body; `details.exitCode/stdout/stderr` keep raw values for structured access |
| read_file | `sliceLines(text, offset, limit)` | head | Truncate post-slice |
| grep | `formatMatches(matches)` | head | Per-line `truncateLine` applied in `formatMatches` before join; then `truncateHead` on the joined result |
| glob | `matched.join("\n")` | head | Truncate joined result |
| ls | `rows.join("\n")` | head | Truncate joined result |

### grep per-line truncation

In `formatMatches` (or in the match construction), apply `truncateLine(m.text, GREP_MAX_LINE_LENGTH)` to each match's text. `truncateLine` returns `{ text, wasTruncated }`; use `text` and optionally append `[truncated]` if `wasTruncated` (the utility may already append this — verify against the `.d.ts`).

## Data Flow

```
tool execute
  → produce raw string (stdout/slice/matches/files/entries)
  → truncateWithFooter(raw, "head"|"tail")
    → truncateHead/Tail → TruncationResult
    → if truncated: content + footer
    → else: content as-is
  → textResult(result.text, { ...originalDetails, truncation: { truncated, truncatedBy, totalLines, totalBytes } })
```

## Compatibility

- No API signature changes to any tool — truncation is internal to `execute`.
- `details` objects gain optional `truncation` fields; existing consumers ignore unknown fields.
- `fetch_content` untouched.
- bash `details.stdout`/`details.stderr` keep raw (untruncated) values for structured access; only the model-facing `content` text is truncated. This is important: the TUI `ToolCallBlock` reads `result.content` for display (already truncates to `MAX_RESULT_LINES=20` itself), and structured consumers can still get full output from `details`.

## Trade-offs

- **bash details keep raw stdout/stderr**: doubles memory for large outputs (raw + truncated). Acceptable because details are for logs/UI, not persisted in context — and the model only sees the truncated `content`.
- **Footer format**: human-readable single line. Matches pi's style. Not machine-parsed; the model reads it as guidance.
- **No per-tool config**: limits are constants from pi. If a tool needs different limits later, `TruncationOptions` supports overrides, but we don't use them now.

## Rollback

Revert the `truncateWithFooter` calls in each tool's `execute` and remove the helper from `shared.ts`. No schema or signature changes to undo.