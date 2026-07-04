# Design: Tool Call TUI Redesign (Claude Code style)

## Visual Target

Adopt the Claude Code tool-call layout. Verified format from Claude Code
transcripts (GitHub issue anthropics/claude-code#40428):

```
⏺ Bash(npm test)
⎿ stdout line 1…
  +19 lines (ctrl+o to expand)
```

- **Header**: `⏺ ToolName(key_arg)` — filled circle marker + tool name +
  the single most identifying argument in parens. Status is encoded by
  marker color (yellow=running, green=done, red=error), same as today.
- **Result tree**: a `⎿` prefix on the first result line, continuation
  lines indented 2 spaces to align under the `⎿` content column.
- **Collapsed**: header + one `⎿` result-summary line (first output line
  / diff stat / generic first line) + a `+N lines (ctrl+o to expand)`
  hint when there is more content than shown.
- **Expanded**: header + `⎿` full result tree (no line limit beyond the
  existing `MAX_RESULT_LINES = 20` truncation with `… (N more lines)`).
- **No** `│` guide line, **no** `╌` dotted separators.

## Per-Tool Expanded Content

Semantics unchanged from current implementation; only presentation shifts
to the `⎿` tree.

| Tool | Header | Expanded `⎿` tree |
|------|--------|-------------------|
| `edit_file` | `⏺ edit_file(path)` | LCS diff lines: `-` red, `+` green, ctx dim. No separate `path:` label (path is in header). |
| `write_file` | `⏺ write_file(path)` | File content lines (truncated to 20). |
| `bash` | `⏺ bash(command)` | `$ command` line (dim) + output lines + optional `exit: error` (red). |
| default | `⏺ name(args_summary)` | Args JSON (dim) + result text lines. |

## Collapsed Result Summary

The `⎿` summary line per tool type when collapsed:

| Tool | Summary line |
|------|-------------|
| `edit_file` | `⎿ Updated — +N -M` (add/del counts from diff) |
| `write_file` | `⎿ Wrote N lines` |
| `bash` | `⎿ ` first output line (truncated), or `exit: error` if error |
| default | `⎿ ` first result text line (truncated) |

If the summary line would be empty (no result yet / running), show `⎿ …`
while running and nothing else. The `+N lines (ctrl+o to expand)` hint
appends when total content lines exceed the collapsed preview (1 line).

## Streaming Line (MessageList.tsx)

Current: `● toolname… running/(status)`
New: `⏺ toolname… running/(status)` — same marker glyph as the block.

## Glyph / Theme Changes (`theme.ts`)

| Icon | Before | After | Notes |
|------|--------|-------|-------|
| `statusDot` | `●` (U+25CF) | `⏺` (U+23FA) | Filled circle, Claude Code marker. Used in ToolCallBlock header + MessageList streaming. |
| `bracket` | `⎿` (reserved) | `⎿` (now used) | Result-tree indent prefix. Remove "reserved" comment. |
| `guide` | `│` | `│` (kept, now unused by ToolCallBlock) | Retained in registry as vocabulary; no longer consumed. |
| `separatorDotted` | `╌` | `╌` (kept, now unused) | Retained in registry; no longer consumed. |

No new color entries needed — reuse `theme.status.{idle,active,error}`,
`theme.dim`, `theme.diff.{del,add}`.

## Interaction (unchanged — Option A)

`Ctrl-O` in `App.tsx` toggles the global `toolExpanded` boolean; all
`ToolCallBlock` instances expand/collapse in lockstep. No state-management
changes, no `useHarnessState` changes, no new keybindings.

## Component Structure (`ToolCallBlock.tsx`)

```
ToolCallBlock({ call, result, expanded })
├─ Header line: `⏺ name(summary)` + status color + optional `(error)`
├─ if expanded:
│    └─ `⎿` + full content tree (per-tool sections, no separators)
└─ if collapsed:
     └─ `⎿` + summary line + optional `+N lines (ctrl+o to expand)`
```

Remove: `dottedSeparator()`, the `paddingLeft + icons.guide` indent row,
the `Fragment` separator interleaving.

Add: a `renderCollapsedSummary()` helper and a diff-line-count helper
(`+N -M` stat) for the edit_file collapsed summary.

## Files Touched

1. `src/tui/theme.ts` — `icons.statusDot` → `⏺`; update `bracket` comment.
2. `src/tui/ToolCallBlock.tsx` — full collapsed/expanded rewrite per above.
3. `src/tui/MessageList.tsx` — streaming line glyph (`icons.statusDot`
   already used; auto-picks up `⏺`). No code change needed beyond the
   theme glyph swap, but verify the streaming line reads correctly.

## Trade-offs

- **2-line collapsed vs 1-line**: Claude Code shows 2 lines collapsed
  (header + result preview). This is denser than the current 1-line but
  matches the target. Acceptable — the result preview adds scannability.
- **Keeping `guide`/`separatorDotted` in registry**: they become unused
  but remain as vocabulary entries. Removing them would be over-cleaning
  a shared registry; keeping them costs nothing and preserves the
  vocabulary for future use.
- **Tool display names**: kept as-is (`edit_file` not `Edit`). Renaming
  display names is out of scope; the `⏺ name(arg)` shape is what matters.

## Compatibility / Rollback

- Pure presentation change; no data-model, event, or persistence impact.
- Rollback: `git revert` the commit — no migration needed.