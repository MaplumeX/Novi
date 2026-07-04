# Redesign tool call TUI styling

## Goal

Redesign the tool-call block TUI (`src/tui/ToolCallBlock.tsx` and related) to
match the Claude Code visual style — `⏺ ToolName(args)` header with a `⎿`
indented result tree — so collapsed and expanded views look like a typical
coding agent.

## Background

Current implementation (verified from code):

- **Collapsed**: single line `● toolname — summary`. The `icons.statusDot`
  (`●`) color encodes status: yellow=running, green=done, red=error.
- **Expanded**: the same header line, then a `│` (`icons.guide`) left guide
  line with dotted `╌` (`icons.separatorDotted`) separators between
  per-tool sections:
  - `edit_file` → `path:` label + LCS diff (`-` red / `+` green)
  - `write_file` → `path:` label + content (truncated to 20 lines)
  - `bash` → `$ cmd` line + output (truncated to 20 lines) + optional
    `exit: error`
  - default → args JSON + result text
- **Interaction**: `Ctrl-O` flips a single global boolean `toolExpanded` in
  `App.tsx`; every `ToolCallBlock` instance receives the same value, so all
  blocks expand/collapse in lockstep.
- **Streaming** (`MessageList.tsx`): in-flight tool calls render separately
  as `● toolname… running/(status)`, not via `ToolCallBlock`.
- `theme.ts` already defines `icons.bracket: "⎿"` but marks it "reserved,
  MVP not used". `icons.statusDot: "●"` is the current block marker.

Relevant files:

- `src/tui/ToolCallBlock.tsx` — the block component (collapsed + expanded)
- `src/tui/MessageList.tsx` — renders `ToolCallBlock` per assistant
  `toolCall` part; also renders `streamingToolCalls` inline
- `src/tui/theme.ts` — `theme.*` colors + `icons.*` glyph registry
  (single source of truth; no hardcoded glyphs/colors allowed)
- `src/tui/App.tsx` — owns `toolExpanded` state + `Ctrl-O` handler
- `src/tui/useHarnessState.ts` — `ToolCallView` for streaming display

## Requirements

- Adopt Claude Code-style glyphs for the tool-call block: `⏺` block marker
  and `⎿` result-tree indent, replacing the current `●` + `│` + `╌` combo.
- Collapsed view shows a compact, single-line tool header consistent with
  Claude Code (tool name + arg summary + status), not the current `● … — …`
  shape.
- Expanded view renders the tool's result/diff/output under a `⎿` indented
  tree, like a typical coding agent — no dotted `╌` separators.
- Per-tool expanded content keeps its current semantics (edit→diff,
  write→content, bash→cmd+output, generic→result), only the visual
  presentation changes.
- All new glyphs/colors go through `theme.ts` (`icons.*` / `theme.*`); no
  hardcoded Ink color strings or ad-hoc unicode in components (frontend
  spec: "Theme & Colors").
- Collapsed/expanded interaction stays global `Ctrl-O` lockstep (Option A):
  no per-block independence, no new keybindings, no `useHarnessState` or
  `App.tsx` state changes.

## Acceptance Criteria

- [ ] `ToolCallBlock` collapsed output visually matches the Claude Code
      `⏺ ToolName(args)` shape.
- [ ] `ToolCallBlock` expanded output uses `⎿` indented result tree with no
      `╌` dotted separators.
- [ ] `theme.ts` gains any new glyph/color used; no hardcoded glyphs/colors
      in `ToolCallBlock.tsx` or `MessageList.tsx`.
- [ ] Streaming tool-call line in `MessageList.tsx` is restyled to match
      the new block marker.
- [ ] `Ctrl-O` global lockstep expand/collapse behavior preserved (no
      new keybindings, no per-block state).
- [ ] `npm run lint` and `tsc` pass.

## Out of Scope

- Changing which tools exist or their execution semantics.
- Changing `useHarnessState` event projection.
- Markdown rendering (`Markdown.tsx`) changes.
- Per-block independent collapse (out of scope for this task — global
  lockstep preserved).