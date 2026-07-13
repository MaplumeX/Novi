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
  "model" | "thinkingLevel" | "lastUsage" | "cumulativeUsage"
>;

export function StatusBar({ model, thinkingLevel, … }: StatusBarProps): React.ReactElement { … }
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
  `<>` fragment whose top-to-bottom order is: `MessageList`, optional notice
  rail, focused `InputBox` (or one temporary panel), then one compact
  `StatusBar`. The footer owns model, thinking level, usage, session name,
  detail-mode action, and `/help`; do not restore separate divider/session/help
  rows or duplicate the active-turn status in the input.
- Keyed lists use the index for short-lived render output (acceptable for
  markdown tokens / notice lines):
  ```tsx
  {notice.map((line, i) => <Text key={i} …>)}
  ```

---

## Overlay Pattern

The editor area (where `InputBox` normally renders) can be temporarily
replaced by an overlay component. This is used by `/settings` (child 1) and
the `@file` file picker (child 2).

### Overlay union state

```tsx
/** Overlay union: null = normal input; settings = form; filePicker = @file. */
type Overlay = null | { kind: "settings" } | { kind: "filePicker" };

const [overlay, setOverlay] = useState<Overlay>(null);
```

Keep overlay variants minimal — store only the `kind` discriminant in the
union. Any query/cursor the overlay needs should be local `useState` inside
the overlay component itself (see `FilePicker`).

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

1. Add a variant to the `Overlay` union (just the `kind` discriminant).
2. Add a render branch in `App.tsx`.
3. Create the overlay component with its own `useInput`.
4. Ensure `InputBox` is not mounted when the overlay is active.
5. **Lift input state to App** if the overlay needs to read/modify
   `InputBox`'s text (see below).

### Lifted editor state across overlay transitions

`InputBox` is unmounted when an overlay opens. If it owns its input as local
`useState`, that state is **destroyed** on unmount and lost when the overlay
closes. To survive the overlay lifecycle, `App` holds the editor state:

```tsx
// App.tsx
const [editorState, setEditorState] = useState<EditorState>({ text: "", cursor: 0 });

// InputBox receives state + setState as props, does not own the state.
<InputBox state={editorState} setState={setEditorState} … />

// When filePicker inserts a path, App mutates editorState directly:
<FilePicker onInsert={(p) => { setEditorState((prev) => insert(prev, p)); setOverlay(null); }} … />
```

This is required whenever an overlay callback needs to modify the input
content (file picker insert, external editor result, etc.).

---

## Theme & Colors

`src/tui/theme.ts` is the single source of truth for colors, dividers, and
visual constants. All components import from it — never hardcode Ink color
strings directly.

```tsx
// Good
import { theme } from "../theme.js";
<Text color={theme.role.user}>…</Text>
<Text color={theme.text.muted}>…</Text>

// Bad — scattered hardcoded colors
<Text dimColor>…</Text>
<Text color="cyan">…</Text>
```

- Prefer semantic tokens such as `theme.text.muted`, `theme.status.running`,
  `theme.borderTone.focus`, and `theme.surface.user`. Do not choose a literal
  color based on the component name.
- The focused `InputBox` owns the persistent boundary. Do not add full-width
  dividers between transcript, input, and footer; spacing and the focus border
  already express those regions.
- When adding a new color role, add it to `theme.ts` first, then consume it
  via `theme.*` — do not add a new hardcoded color literal in a component.
- `theme.ts` also exports an `icons` constant registry — all visual glyphs
  (spinner frames, status dots, guide lines, separators, prompt symbols)
  must trace to a named `icons.*` constant. Never hardcode emoji or ad-hoc
  unicode glyphs in a component; import from `icons` and consume via
  `icons.*`. This keeps the glyph vocabulary centralized and avoids
  monospace-alignment-breaking emoji in the TUI.

### Transcript density and detail mode

- The default transcript protects the user/answer reading path. Thinking is a
  compact `Thought` row and tools are one or two semantic lines.
- `App` owns one `detailMode` boolean toggled by `Ctrl-O`. It controls complete
  thinking and tool arguments/output/diffs together; do not add independent
  global expansion state for each content type.
- `MessageList` associates live tool state, assistant `toolCall` parts, and
  persisted `ToolResultMessage`s by `toolCallId`. A tool must not use a separate
  live-only component that changes shape when it completes.
- Tool-facing labels come from `tool-presentation.ts`. Default rows describe
  user actions (`Read`, `Update`, `Run`, `Search web`), not raw JSON or internal
  snake_case names.

### Shared temporary panels

Use `Panel` for permission prompts, pickers, settings, onboarding, and trust
decisions. Its semantic order is title → optional description → content → key
hints. Use `SelectionRow` for selected markers and secondary row descriptions.
The owning screen keeps its own `useInput` and business state.

```tsx
<Panel title="Switch model" footer="↑↓ navigate · Enter switch · Esc cancel">
  <SelectionRow selected={index === cursor}>{model.id}</SelectionRow>
</Panel>
```

This keeps the visual vocabulary shared without coupling unrelated keyboard
state or save behavior.

## Forbidden Patterns

- Do not subscribe to harness events inside components. All event handling
  goes through `useHarnessState`.
- Do not pass `AgentHarness` or `Session` instances to display components
  (`MessageList`, `StatusBar`). They receive already-projected state.
- Do not call harness methods (`prompt`, `abort`,…) directly from display
  components. Route through callbacks defined in `App.tsx`.
- `Markdown` debounces its input with a 50ms `setTimeout` before running
  `marked.lexer`, so streaming deltas are acceptable — the throttle bounds
  re-lexer frequency. The final `message_end` flush renders complete text.
