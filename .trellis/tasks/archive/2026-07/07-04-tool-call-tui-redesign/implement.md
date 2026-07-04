# Implement: Tool Call TUI Redesign

## Ordered Checklist

1. **`src/tui/theme.ts`** — change `icons.statusDot` from `"●"` to `"⏺"`;
   update `bracket` comment from "Reserved; not used in MVP" to note it is
   now the result-tree indent prefix. Leave `guide` and `separatorDotted`
   in place (now unused by ToolCallBlock, retained as vocabulary).

2. **`src/tui/ToolCallBlock.tsx`** — rewrite:
   - **Header**: `⏺ name(summary)` with status-colored marker. Use
     `summarizeArgs()` already present (keep its per-tool logic). Show
     `(error)` suffix when `result?.isError`.
   - **Collapsed** (`!expanded`): header line + `⎿` summary line per the
     per-tool table in design.md. Add `renderCollapsedSummary()` helper.
     Append `+N lines (ctrl+o to expand)` when content lines > 1.
   - **Expanded**: header line + `⎿` + full per-tool content tree (reuse
     `renderExpanded()` logic for diff/content/bash-output/args). Remove
     `dottedSeparator()` and the `icons.guide` indent row. Replace with a
     single `⎿` prefix on the first content line, continuation lines
     indented to align under `⎿ ` (2 chars).
   - Add a `diffStat(diffLines)` helper: returns `+{adds} -{dels}` for
     `edit_file` collapsed summary.
   - Remove the `Fragment` separator interleaving in the expanded branch.
   - Keep `MAX_RESULT_LINES = 20` truncation (`… (N more lines)`).

3. **`src/tui/MessageList.tsx`** — streaming line already uses
   `icons.statusDot`, so it auto-picks up `⏺`. Verify the line reads
   correctly (`⏺ toolname… running`). No code change expected unless
   spacing needs a tweak.

4. **Verify `Ctrl-O` path unchanged** — `App.tsx` `toolExpanded` boolean
   + `Ctrl-O` handler stay as-is. No edits to `App.tsx`.

## Validation Commands

```bash
npm run typecheck   # tsc --noEmit
npm run lint        # eslint flat config
npm run test        # vitest run
npm run build       # tsc emit
```

All four must pass before `task.py start` is NOT needed (these run during
implementation, i.e. after start). Run them after code edits in Phase 2.

## Risky Files / Rollback Points

- `src/tui/theme.ts` — single-line glyph change; lowest risk. If `⏺`
  (U+23FA) renders as a missing glyph in some terminals, fall back to
  `●` (revert this one line). Rollback point.
- `src/tui/ToolCallBlock.tsx` — full rewrite of render branches. Keep the
  diff/content/bash helper logic intact; only restructure presentation.
  If the rewrite introduces a TS error, narrow to the specific branch.
- `src/tui/MessageList.tsx` — expect zero edits; if the streaming line
  breaks, it is the `icons.statusDot` consumption, not new code.

## Follow-up Checks Before `task.py start`

- [ ] `prd.md` convergence pass done (no resolved open questions left).
- [ ] `design.md` reviewed with user.
- [ ] `implement.md` reviewed with user.
- [ ] `implement.jsonl` + `check.jsonl` have real curated entries.