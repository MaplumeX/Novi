# Component Guidelines

> Patterns, props, and composition conventions for Novi TUI components.

---

## Overview

Novi components are **Ink** components (React 19). They render terminal UI
from `HarnessState` props or local `useState`. The guiding rule:

> Display components consume `HarnessState`, never raw events.
> Only `useHarnessState` interprets `AgentHarnessEvent`s.

(See `guides/cross-layer-thinking-guide.md`, "Every Consumer Parses The Same
Payload" anti-pattern.)

---

## Component Patterns

### Props-driven, stateless display

Most components are pure functions of their props. No harness access, no event
subscription:

```tsx
// StatusBar.tsx
type StatusBarProps = Pick<
  HarnessState,
  "phase" | "model" | "thinkingLevel" | "activeToolNames" | "queue"
>;

export function StatusBar({ phase, model, … }: StatusBarProps): React.ReactElement { … }
```

Use `Pick<HarnessState, …>` to declare exactly which slices a component needs.

### One root component owns the harness

`App.tsx` is the only component that receives the `harness` / `session` /
`models` instances. It passes derived state down as props:

```tsx
function App({ harness, session, sessionPath, models, sessionsDir }: AppProps) {
  const state = useHarnessState(harness, session);
  // … passes state.messages, state.phase, etc. to children
}
```

### Local state only for UI concerns

`useState` is used for purely visual concerns (notice line, input buffer) —
never for harness-derived data:

```tsx
const [notice, setNotice] = useState<string[]>([]);
const [input, setInput] = useState("");
```

### Return `React.ReactElement`

Components declare an explicit return type of `React.ReactElement` (not the
implicit `JSX.Element`):

```tsx
export function MessageList(…): React.ReactElement { … }
```

---

## Props Conventions

- **Interfaces, not type aliases**, for component props:
  `interface MessageListProps { … }`.
- **Destructure in the parameter**, do not use `props.xxx`:
  ```tsx
  function App({ harness, session, sessionPath, models, sessionsDir }: AppProps) {
  ```
- **Callback props** are named `onXxx`: `onPrompt`, `onCommand`.
- **Boolean-render** with ternaries returning `null` for optional UI:
  ```tsx
  {notice.length > 0 ? notice.map(…) : null}
  ```

---

## Composition

- Compose via children / fragments, not deep prop drilling. `App` returns a
  `<>` fragment with `MessageList`, `StatusBar`, and `InputBox` siblings.
- Keyed lists use the index for short-lived render output (acceptable for
  markdown tokens / notice lines):
  ```tsx
  {notice.map((line, i) => <Text key={i} …>)}
  ```

---

## Forbidden Patterns

- Do not subscribe to harness events inside components. All event handling
  goes through `useHarnessState`.
- Do not pass `AgentHarness` or `Session` instances to display components
  (`MessageList`, `StatusBar`). They receive already-projected state.
- Do not call harness methods (`prompt`, `abort`,…) directly from display
  components. Route through callbacks defined in `App.tsx`.
- Do not feed streaming deltas into `Markdown` — it runs `marked.lexer` over
  full text. During streaming, render `<Text>` directly (see `MessageList`).
