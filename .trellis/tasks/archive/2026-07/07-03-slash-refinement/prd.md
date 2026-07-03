# Slash Command List Refinement

## Goal

Improve the slash-command picker UX in the TUI input box: trim unused commands,
add circular (wrap-around) keyboard navigation, and render descriptions in an
aligned column (computed padding replacing the ` — ` separator).

## Background

- Command registry: `src/tui/commands.ts` — `COMMANDS` array (18 entries today).
- Slash picker UI: `src/tui/InputBox.tsx` — renders `matchedCommands`, handles
  ↑/↓ selection. Navigation uses `Math.max(0, i-1)` / `Math.min(len-1, i+1)`,
  clamping at the ends (no wrap).
- Current description separator is `/{name} — {description}` in `InputBox.tsx`.
  The `/help` and `/templates` command bodies also format output with ` — `.
- Command tests: `src/tui/commands.test.ts`.

After R1, surviving commands are: `quit, model, new, resume, name, session,
compact, settings, reload` (9 entries).

## Requirements

### R1 — Delete commands

Remove the following 9 built-in commands from `COMMANDS`:
`goto`, `abort`, `help`, `thinking`, `tree`, `tools`, `history`, `queue`,
`templates`.

(User confirmed: `think` → `thinking`, `template` → `templates`.)

Clean up code that becomes dead after deletion:
- Helper functions only used by deleted commands: `entrySummary`,
  `loadSessionDisplayName`, `listSessionFiles`.
- Imports no longer referenced once the above are removed, e.g.
  `SessionTreeEntry`, `summarizeUsage`, `formatTokens`, `formatCost`,
  `messageText` — remove only those with zero remaining references (the
  `/session` command still uses `summarizeUsage`/`formatTokens`/`formatCost`;
  keep those). Verify each symbol's reference count before removing.
- `runCommand`'s empty-command and unknown-command fallback messages currently
  suggest `Try /help.`; since `/help` is being removed, reword them to not
  reference `/help` (e.g. "Try /quit /model /session ...").

### R2 — Circular navigation

In `InputBox.tsx`, replace the clamping logic for the slash picker:
- ↑ at index 0 → last index (`len - 1`).
- ↓ at last index → 0.

Use modulo wrap-around: `(i - 1 + len) % len` and `(i + 1) % len`. Guard
`len === 0` (already covered by `slashActive = matchedCommands.length > 0`).

### R3 — Aligned column for descriptions

Replace the ` — ` separator in the slash picker list with computed padding so
descriptions align in a column:
- Width = length of the longest visible (matched) command name.
- Each row renders `  /<name>` + space padding to `width + N` columns, then the
  description.
- Applies to the slash picker in `InputBox.tsx`.

Since `/templates` is deleted (R1) and `/help` is deleted, no other in-command
output formatting remains affected. (Verify no surviving command's `run` body
emits a ` — `-separated name/description list; if any does, apply the same
padding there too.)

## Acceptance Criteria

- [ ] The 9 listed commands no longer appear in `COMMANDS`; invoking any of
      them reports "Unknown command".
- [ ] `runCommand` fallback messages no longer reference the removed `/help`.
- [ ] Dead helper functions (`entrySummary`, `loadSessionDisplayName`,
      `listSessionFiles`) are removed.
- [ ] Imports left unused by the deletions are removed; imports still used by
      surviving commands (e.g. `summarizeUsage`, `formatTokens`, `formatCost`
      used by `/session`) are NOT removed.
- [ ] ↑ at the first slash-list item moves selection to the last item; ↓ at
      the last item moves to the first.
- [ ] Descriptions in the slash picker render in an aligned column (computed
      padding), not with ` — `.
- [ ] `commands.test.ts` updated: removed tests for deleted commands
      (`/templates`, `/thinking` parseCommand cases, `/help` builtin-priority
      case, `/goto`/`/tree` parseCommand cases), kept tests for surviving
      commands green; `parseCommand` tests still exercise general behavior.
- [ ] Lint + type-check pass.

## Out of Scope

- Adding new commands.
- Changing command argument parsing for surviving commands.
- Behavioral changes to non-deleted commands beyond the separator/format.
