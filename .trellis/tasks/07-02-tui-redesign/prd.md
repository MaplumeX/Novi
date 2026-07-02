# TUI Visual Redesign

## Goal

Redesign the Novi TUI's visual language to eliminate the current "ugly" emoji-heavy
iconography (`💭` `⚙`) and flat layout, replacing it with a coherent, industry-proven
design system inspired by Claude Code's terminal UI patterns.

## Background

### Current State (Evidence)

Five TUI files hardcode emoji/unicode symbols with no centralized icon system:

| Location | File | Current rendering |
|----------|------|------------------|
| Thinking label | `src/tui/MessageList.tsx:61,69,155` | `💭 thinking` / `💭 {firstLine}…` |
| Assistant role header | `src/tui/MessageList.tsx:98` | `✻ Assistant` (magenta bold) |
| User role label | `src/tui/MessageList.tsx:117` | `You ›` |
| Streaming tool call | `src/tui/MessageList.tsx:150` | `⚙ name… running` |
| Tool call collapsed | `src/tui/ToolCallBlock.tsx:201,212` | `● ⚙ name — summary` |
| StatusBar tools/queue | `src/tui/StatusBar.tsx:38` | `⚙{n} ⏵{n}` |
| Spinner | `src/tui/components/Spinner.tsx` | braille `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` (80ms) |
| InputBox prompt | `src/tui/InputBox.tsx:340` | `›` accent + `▏` cursor |

`theme.ts` is a flat ANSI color-name map (`cyan`, `magenta`, `dim`, etc.) with no
icon constants — all glyphs are hardcoded per-component.

### Industry Research (Claude Code — Ink/React, the reference standard)

Key finding: **Claude Code does not use emoji for status icons.** It uses:

- **Spinner**: dingbat characters `✶`(U+2736) `✻`(U+273B) `✳`(U+2733) `✢`(U+2722)
  paired with **status verbs** ("Undulating…" "Ideating…" "Sautéed for 1m 32s")
- **Tool calls**: `⎿ $ ls -la …` (left-bracket guides the argument), not `⚙ name`
- **Tool status dot**: `●` with color+blink encoding (dim+blink=running /
  green=done / red=error), multiple tools **blink in sync**
- **No standalone "Assistant" header** — the spinner symbol + verb IS the status line
- **Separators**: `─` gray for normal, **blue `─`** for permission prompts,
  dotted `╌` (U+254C) for content blocks within a prompt
- **Mode line**: `⏵⏵ bypass permissions on` (double triangle prefix)
- **Stall indication**: spinner color **smoothly interpolates to red** when no
  tokens arrive, subconsciously signaling "stuck"
- **Thinking blocks**: 200ms slow shimmer (vs 50ms fast for requesting),
  no `💭` emoji

Gemini CLI caveat: braille spinner `⠼` **flickers badly in tmux** → auto-degrades
to `. .. ...` pattern when tmux detected.

### Root Causes of "Ugly"

1. **Emoji as icons** (`💭` `⚙`) — breaks monospace alignment, inconsistent colors,
   deviates from industry practice
2. **Isolated role labels** — `✻ Assistant` puts decorative symbol as a static header
   instead of a live status line
3. **Tool blocks lack hierarchy** — collapsed `● ⚙ name — summary` is flat; expanded
   uses `single` border but no guiding brackets or block separators
4. **StatusBar emoji concatenation** — `⚙0 ⏵0` is cramped and semantically unclear
5. **Flat theme.ts** — no icon constant registry, glyphs scattered across components

## Requirements

### R1: Centralized icon constants
- Add an `icons` registry (or equivalent) to `theme.ts` so no component hardcodes
  emoji or ad-hoc unicode glyphs.
- Every visual symbol used in the TUI must trace to a named constant.

### R2: Remove all emoji from status/role/tool indicators
- `💭`, `⚙`, and any other emoji currently used as functional icons must be replaced
  with non-emoji unicode (dingbats / box-drawing / geometric shapes).

### R3: Spinner redesign
- Replace braille-only spinner with a dingbat frame sequence `✶`(U+2736)
  `✻`(U+273B) `✳`(U+2733) `✢`(U+2722), 4 frames, 80ms interval, forward-only
  cycle.
- Keep the `useEffect` + `setInterval` animation mechanism.
- Spinner color uses `theme.accent`; future stall indication is out of scope
  for this task (see Out of Scope).

### R4: Message role rendering
- Assistant messages (completed history): **no header label** — content
  indented under a dim left guide line `│`, separated by vertical spacing.
- Assistant messages (streaming): spinner symbol `✶` + dim status verb
  (e.g. `✶ thinking…` / `✶ responding…`) as a live status line, no static header.
- User messages: replace bold `You ›` with a dim lowercase label (e.g.
  `› user`) for visual consistency with the low-noise aesthetic.
- Thinking blocks: replace `💭` with dim text + guiding bracket/line.
  Folded: dim `│ {firstLine}…`; expanded: dim block under a `╌` separator.

### R5: Tool call block redesign
- Collapsed: replace `● ⚙ name — summary` with `● name — summary` —
  `●` status dot color-coded (yellow=running / green=done / red=error),
  no gear emoji.
- Expanded: remove `single` border; use dim left guide line `│` to lead
  arguments and output content; separate content sections (path / diff /
  output) with dim dotted `╌` separators. Header line identical to collapsed
  form (no duplicated border).

### R6: StatusBar cleanup
- Remove `⚙` and `⏵` emoji; use plain separators (`·` or `│`) and text labels
  for tool count / queue count.

## Acceptance Criteria

- [ ] `theme.ts` exports a centralized icon/glyph constant set; no component
      hardcodes `💭`, `⚙`, or other functional emoji.
- [ ] `grep -rn "💭\|⚙" src/tui` returns zero matches.
- [ ] Spinner uses a non-braille-only frame set (dingbat or validated alternative).
- [ ] Assistant and user role rendering no longer use `✻ Assistant` /
      `You ›` as-is; new design is applied.
- [ ] Tool call collapsed/expanded views use guiding brackets and color-coded
      status dots instead of gear emoji.
- [ ] StatusBar shows tool/queue counts without emoji.
- [ ] `npm run build` (or equivalent) passes.
- [ ] Existing tests pass (`npm test`).

## Out of Scope

- Spinner stall color-interpolation (gradual red shift) — complex animation,
  defer to a follow-up.
- tmux detection / spinner degradation — not yet a reported problem in Novi.
- Virtual scrolling / virtual message list.
- Permission prompt UI redesign (Novi doesn't have one yet).
- Syntax highlighting in diffs (separate concern).
- StreamingMarkdown incremental parsing optimization.
- Accessibility / reduced-motion support.

## Design Direction (Confirmed)

**Dingbat + status-verb route** (Claude Code style):
- No emoji for functional icons; use dingbat (`✶` `✻` `✳` `✢`),
  box-drawing (`⎿` `│` `╌` `─`), and geometric shape (`●`) glyphs.
- No Nerd Font dependency; no emoji retained for status/role/tool indicators.
- All glyphs centralized as named constants in `theme.ts`.
