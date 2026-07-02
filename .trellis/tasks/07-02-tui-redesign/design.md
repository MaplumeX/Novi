# Design: TUI Visual Redesign

## Architecture & Boundaries

This task touches only the presentation layer — no changes to
`useHarnessState`, `AgentHarness`, session I/O, or tool execution logic.
All changes live within `src/tui/`.

### Files in Scope

| File | Change |
|------|--------|
| `src/tui/theme.ts` | Add `icons` constant registry + new color roles (`guide`, `separator`) |
| `src/tui/components/Spinner.tsx` | Replace braille FRAMES with dingbat frames |
| `src/tui/MessageList.tsx` | Rework assistant/user role rendering, thinking blocks, streaming tool calls |
| `src/tui/ToolCallBlock.tsx` | Rework collapsed (remove `⚙`) and expanded (remove border, add `│` + `╌`) views |
| `src/tui/StatusBar.tsx` | Remove `⚙` / `⏵` emoji, use `·` separators + text labels |
| `src/tui/InputBox.tsx` | Consume `icons.prompt` instead of hardcoded `›`; no logic change |

### Files NOT in Scope

`App.tsx`, `useHarnessState.ts`, `Markdown.tsx`, `markdown/render-token.tsx`,
`InputBox.tsx` input handling logic, `commands.ts`, `bang.ts`, all overlay
components. These render no emoji status icons today.

## Contracts

### theme.ts additions

```ts
export const icons = {
  spinner: ["✶", "✻", "✳", "✢"],     // dingbat frames (U+2736, U+273B, U+2733, U+2722)
  statusDot: "●",                     // tool status (color-coded)
  guide: "│",                         // left guide line for assistant content / tool args
  bracket: "⎿",                       // (reserved; not used in MVP — guide line suffices)
  separatorDotted: "╌",              // content block separator within expanded tool/thinking
  separatorSolid: "─",               // (already exists as DIVIDER_CHAR)
  prompt: "›",                        // InputBox prompt prefix + user label prefix
  mode: "·",                          // StatusBar inline separator
} as const;

// New color roles added alongside existing theme.role/status/accent/dim/border:
//   guide: "dim"     — color for the │ left guide line
// (No new colors needed — dim covers all guide/separator rendering.)
```

### Spinner.tsx

- `FRAMES` constant replaced with `icons.spinner`.
- `SpinnerProps` unchanged (`color?: string`).
- Animation interval stays 80ms; the array is now 4 elements (was 10) so the
  visual cycle is faster — acceptable, dingbats read well at this speed.
- No `status` prop or verb text added in this task (Spinner renders only
  the glyph; callers compose the verb text alongside it).

### MessageList.tsx — Role Rendering

**Completed assistant message** (history):

```
    │ (markdown content indented under dim │ guide line)
    │ (continued…)
```

- `marginTop={1}` spacer before each message (unchanged).
- No `✻ Assistant` header line.
- Content wrapped in a `<Box paddingLeft={1}>` with a dim `│` prefix per line
  is not feasible via per-line prefix in Ink (Markdown renders its own Box
  tree). Instead: a `<Box flexDirection="row">` with a dim `│` `<Text>` in a
  fixed-width column + the content `<Box>` beside it. This gives the
  visual guide line without injecting characters into markdown text.

**Streaming assistant message**:

```
✶ responding…
(streaming markdown content)
```

- When `streamingText` or `streamingThinking` is non-empty, render a status
  line: `<Spinner /> <Text color={theme.dim}>{verb}…</Text>`.
- Verb logic: `streamingThinking.length > 0` → `"thinking"`; else
  `streamingText.length > 0` → `"responding"`; else omitted.
- Replaces both the old `💭 thinking` block and the implicit assistant
  header.

**User message**:

```
› user
(content text)
```

- `You ›` (bold cyan) → `› user` (dim).
- User content on the same line if short, or next line if long — keep
  current single-line behavior (content appended after label) for minimal
  change.

**Thinking blocks** (inside `renderAssistantMessage`):

- Folded: `│ {firstLine}…` (dim, guided by `│`).
- Expanded: dim block under a `╌╌╌` separator line, content prefixed with
  `│ ` per line (same guide-line column approach as assistant content).
- Streaming thinking: folded form, `│ {streamingThinking first line}…`.

### ToolCallBlock.tsx

**Collapsed** (unchanged structure, glyph removal):

```
● name — summary
```

- `●` color: `theme.status.active` (yellow) when running, `theme.status.idle`
  (green) when done, `theme.status.error` (red) on error. (Maps to existing
  `badgeColor` logic — just remove the `⚙ ` prefix from the name Text.)
- No `⚙`, no border.

**Expanded** (border removed, guide line added):

```
● name — summary
│ path: src/tui/theme.ts
╌╌╌
│ - old line
│ + new line
╌╌╌
│ (output…)
```

- Header `<Text>` identical to collapsed form.
- Content wrapped in `<Box paddingLeft={1}>` with dim `│` guide column
  (same row-layout approach as MessageList assistant content).
- `renderExpanded` output sections separated by dim `╌` lines.
- `borderStyle="single"` removed.

### StatusBar.tsx

- `⚙{n}` → `{n} tool{n≠1 ? "s" : ""}` (plain text), or compact `tools:{n}`.
  Recommended: compact `tools:{n} queue:{n}` separated by ` · `.
- `⏵{n}` (queue) merged into the above.
- Inline `·` (U+00B7) as the separator between status segments.
- No structural change to the status icon / phase / model / usage segments.

### InputBox.tsx

- Hardcoded `› ` → `{icons.prompt} `.
- `▏` cursor stays (not an emoji, renders well).
- No logic change.

## Data Flow

No data-flow changes. All visual constants flow from `theme.ts` → component.
`HarnessState` shape and prop contracts are unchanged.

## Compatibility & Migration

- **No breaking API changes** — `theme.ts` exports are additive (new
  `icons` object; existing `theme.*` color fields unchanged).
- **No config migration** — no user-facing settings reference emoji or
  icon glyphs.
- **No persistence impact** — JSONL session files store message content,
  not rendering glyphs. Historical sessions re-render with the new UI
  automatically.
- **Test impact** — tests that assert on specific glyph strings (e.g.
  `"✻ Assistant"`) will break. Audit: `grep -rn "✻\|💭\|⚙\|⏵" src/tui
  __tests__` to find them. Expected: no such assertions exist today
  (tests cover logic, not rendering text), but this must be verified
  during implementation.

## Trade-offs

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Guide line via Box row layout | Yes | Per-line `│ ` text prefix | Markdown renders its own Box tree; injecting prefixes into text breaks wrapping. Row layout is cleaner. |
| Spinner 4 frames, no reverse | Yes | 8-frame forward+reverse (Claude Code style) | 4 dingbats are visually distinct; reverse cycling adds complexity for marginal smoothness. |
| No status verb param on Spinner | Yes | Add `verb` prop to Spinner | Spinner is a pure glyph animator; callers compose verbs. Keeps component simple. Single caller (InputBox) currently; MessageList composes its own status line. |
| `╌` separator as full-width string | Yes | Dynamic terminal-width-aware | Matches existing `divider()` approach (fixed `DIVIDER_WIDTH`). Consistency over responsiveness. |
| Keep `⏵` mode-line glyph out of scope | Yes | Add mode-line prefix | Novi has no permission/mode system yet; `⏵` removal is only about StatusBar queue count. |

## Rollback

All changes are isolated to `src/tui/` presentation files. Rollback =
revert the commit(s). No database/config/session migration to undo.
