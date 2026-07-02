# Directory Structure

> How frontend (TUI) code is organized in Novi.

---

## Overview

The frontend is a terminal UI built with **React 19 + Ink 7**. All TUI code
lives under `src/tui/`. It consumes `AgentHarness` events and renders them;
it does **not** contain business logic. The boundary between backend and
frontend is precisely `useHarnessState.ts` — the only module that interprets
raw harness events.

---

## Directory Layout

```
src/tui/
├── App.tsx                # Root component: wires hooks + child components + overlay
├── useHarnessState.ts     # The event boundary: subscribes to harness, projects to state
├── harness-handle.ts      # HarnessHandle wrapper: replace() rebuilds harness + session
├── MessageList.tsx        # Renders conversation history + streaming text/tool calls
├── StatusBar.tsx          # Single status line from HarnessState (no raw events)
├── InputBox.tsx           # Editor input: cursor model, Emacs keys, @file/!/Tab/Ctrl+G
├── editor-state.ts        # Pure editor model: { text, cursor } + insert/move/delete fns
├── editor-state.test.ts   # Unit tests for editor-state pure functions
├── bang.ts                # `!`/`!!` shell-bang parsing + execution (parseBang / runBang)
├── bang.test.ts           # Unit tests for bang parsing + mocked execution
├── external-editor.ts     # Ctrl+G: tmp-file → spawn $VISUAL/$EDITOR → read back
├── file-picker.tsx        # @file overlay: fuzzy file list + loadFileCandidates
├── SettingsForm.tsx       # /settings overlay component
├── Markdown.tsx           # Renders a finalized assistant message via marked → Ink
├── commands.ts            # `/name args` command registry + parseCommand (pure)
├── commands.test.ts       # Co-located test for parseCommand
└── markdown/
    └── render-token.tsx   # Pure marked-token → Ink element mapping
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
