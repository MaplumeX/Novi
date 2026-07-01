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
├── App.tsx                # Root component: wires hooks + child components + Ctrl-C
├── useHarnessState.ts     # The event boundary: subscribes to harness, projects to state
├── MessageList.tsx        # Renders conversation history + streaming text/tool calls
├── StatusBar.tsx          # Single status line from HarnessState (no raw events)
├── InputBox.tsx           # Single-line input, routes `/commands` vs plain prompts
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
- **Pure logic** (`.ts`): `commands.ts` contains the command registry and
  `parseCommand`. It is kept framework-agnostic so `parseCommand` can be
  unit-tested without Ink.
- **Markdown rendering**: isolated in `markdown/render-token.tsx`. It is a
  pure token→element transform with no state and no harness access.

---

## Naming Conventions

- Component files: `PascalCase.tsx` (`MessageList.tsx`, `InputBox.tsx`).
- Hook files: `useXxx.ts` (`useHarnessState.ts`).
- Pure logic files: `kebab-case.ts` (`commands.ts`).
- React components: named exports, matching filename
  (`export function MessageList(…)`).
- Props interfaces: `<ComponentName>Props` (`MessageListProps`,
  `StatusBarProps`).

---

## Examples

- Root wiring: `src/tui/App.tsx`
- Event boundary: `src/tui/useHarnessState.ts`
- Pure display component: `src/tui/StatusBar.tsx`
- Pure token renderer: `src/tui/markdown/render-token.tsx`
