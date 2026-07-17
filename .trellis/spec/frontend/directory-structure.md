# Directory Structure

> How frontend (TUI) code is organized in Novi.

---

## Overview

The frontend is a terminal UI built with **React 19 + Ink 7**. All TUI code
lives under `src/tui/`. It consumes `AgentHarness` events and renders them;
it does **not** contain business logic. `useHarnessState.ts` is the only TUI
harness subscriber; raw tool payload interpretation belongs to the shared
`src/tools/events.ts` decoder.

---

## Directory Layout

```
src/tui/
├── App.tsx                # Root component: wires hooks + child components + overlay
├── useHarnessState.ts     # Sole TUI subscriber; delegates tool events to shared reducer
├── useAgentRunState.ts    # Agent Run event-bus projection for queued/running counts
├── harness-handle.ts      # HarnessHandle wrapper: replace() rebuilds harness + session
├── MessageList.tsx        # Renders conversation history + streaming text/tool calls
├── ThinkingBlock.tsx      # Compact/default + detailed thinking presentation
├── ToolCallBlock.tsx      # Stable live-to-history tool activity row
├── tool-presentation.ts   # Pure semantic tool summaries, diffs, and truncation
├── StatusBar.tsx          # Single status line from HarnessState (no raw events)
├── InputBox.tsx           # Editor input: cursor model, Emacs keys, @file/!/Tab/Ctrl+G/Ctrl+I paste-image, pending attachments
├── editor-state.ts        # Pure editor model: { text, cursor } + insert/move/delete fns
├── editor-state.test.ts   # Unit tests for editor-state pure functions
├── bang.ts                # `!`/`!!` shell-bang parsing + execution (parseBang / runBang)
├── bang.test.ts           # Unit tests for bang parsing + mocked execution
├── external-editor.ts     # Ctrl+G: tmp-file → spawn $VISUAL/$EDITOR → read back
├── file-picker.tsx        # @file overlay: fuzzy file list + loadFileCandidates; image mode via acceptExtensions
├── SettingsForm.tsx       # /settings overlay component
├── PermissionPrompt.tsx   # Tool permission confirmation overlay (once/session/deny)
├── Markdown.tsx           # Renders a finalized assistant message via marked → Ink
├── commands.ts            # `/name args` registry + parseCommand + /skill: routing + /image /paste-image
├── image-submit.ts        # toPromptImages + nonVisionWarning helpers
├── commands.test.ts       # Co-located tests for parseCommand / skill invoke
├── markdown/
│   └── render-token.tsx   # Pure marked-token → Ink element mapping
└── components/
    ├── Panel.tsx          # Shared temporary decision/selection surface
    ├── SelectionRow.tsx   # Shared selected-row vocabulary
    └── Spinner.tsx        # Shared animated activity glyph
```

---

## Module Organization

- **Components** (`.tsx`): one component per file, default or named export
  matching the filename. Components consume `HarnessState` props or local
  `useState` only — never raw `AgentHarnessEvent`.
- **Hooks**: custom hooks live as `useXxx.ts` files
  (`useHarnessState.ts`). Hooks are the only place that touches the harness
  API directly.
- **Pure logic** (`.ts`): `commands.ts` (command registry + `parseCommand`),
  `editor-state.ts` (cursor model), and `bang.ts` (`parseBang` / `runBang`)
  are kept framework-agnostic so their core logic is unit-testable without Ink.
- **Presentation logic** (`tool-presentation.ts`): semantic labels, compact
  summaries, diffs, and truncation stay outside Ink components. Live and
  resumed transcripts must call the same helpers.
- **Shared visual primitives** (`components/`): only stateless, cross-screen
  primitives belong here. Picker/form keyboard state remains in its owning
  component; do not build a generic form framework.
- **Markdown rendering**: isolated in `markdown/render-token.tsx`. It is a
  pure token→element transform with no state and no harness access.

---

## Naming Conventions

- Component files: `PascalCase.tsx` (`MessageList.tsx`, `InputBox.tsx`).
- Hook files: `useXxx.ts` (`useHarnessState.ts`).
- Pure logic files: `kebab-case.ts` (`commands.ts`, `editor-state.ts`,
  `bang.ts`, `external-editor.ts`).
- React components: named exports, matching filename
  (`export function MessageList(…)`).
- Props interfaces: `<ComponentName>Props` (`MessageListProps`,
  `StatusBarProps`).

---

## Examples

- Root wiring: `src/tui/App.tsx`
- Event boundary: `src/tui/useHarnessState.ts`
- Pure editor model: `src/tui/editor-state.ts`
- Overlay (file picker): `src/tui/file-picker.tsx`
- External process management: `src/tui/external-editor.ts`
- Pure display component: `src/tui/StatusBar.tsx`
- Pure token renderer: `src/tui/markdown/render-token.tsx`
