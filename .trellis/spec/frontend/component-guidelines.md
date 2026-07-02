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

### One root component owns the HarnessHandle

`App.tsx` is the only component that receives a `HarnessHandle` (containing
`harness` / `session` / `sessionPath` / `replace()`). It holds the handle as
React state and passes derived state down as props:

```tsx
function App({ initialHandle, models, sessionsDir, ... }: AppProps) {
  const [handle, setHandle] = useState<HarnessHandle>(() =>
    createHarnessHandle({ harness, session, sessionPath }, { env, models, cwd, systemPrompt, setHandle }),
  );
  const state = useHarnessState(handle.harness, handle.session);
  // … passes state.messages, state.phase, etc. to children
}
```

`handle.replace()` rebuilds the underlying `AgentHarness` and calls
`setHandle`, which triggers `useHarnessState` to re-subscribe. See
`backend/pi-agent-core-api.md` § "Harness 重建模式" for the full flow.

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
  `<>` fragment with `MessageList`, `StatusBar`, and either `InputBox` or an
  overlay component (see below) as siblings.
- Keyed lists use the index for short-lived render output (acceptable for
  markdown tokens / notice lines):
  ```tsx
  {notice.map((line, i) => <Text key={i} …>)}
  ```

---

## Overlay Pattern

The editor area (where `InputBox` normally renders) can be temporarily
replaced by an overlay component. This is used by `/settings` (child 1) and
will be reused by child 2 (file picker).

### Overlay union state

```tsx
/** Overlay union: null = normal input; settings = interactive form. */
type Overlay = null | { kind: "settings" };
// child 2 will extend: | { kind: "filePicker"; query: string; cursor: number }

const [overlay, setOverlay] = useState<Overlay>(null);
```

### Render branch

```tsx
{overlay === null ? (
  <InputBox phase={…} onPrompt={…} onCommand={…} />
) : overlay.kind === "settings" ? (
  <SettingsForm settings={…} onExit={() => setOverlay(null)} onReload={…} />
) : null}
```

**Critical**: when an overlay is open, `InputBox` is **not mounted** — its
`useInput` is not active. This prevents duplicate key handling. The overlay
component owns its own `useInput`.

Ctrl-C while an overlay is open closes the overlay instead of exiting:

```tsx
useInput((value, key) => {
  if (key.ctrl && value === "c") {
    if (overlay !== null) { setOverlay(null); return; }
    // … normal exit flow
  }
});
```

### Adding a new overlay kind

1. Add a variant to the `Overlay` union.
2. Add a render branch in `App.tsx`.
3. Create the overlay component with its own `useInput`.
4. Ensure `InputBox` is not mounted when the overlay is active.

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
