# State Management

> State library, patterns, and data flow in the Novi TUI.

---

## Overview

Novi uses **no state management library** (no Redux, Zustand, Jotai, etc.).
State is plain React: `useState` + `useRef` + a single custom hook
(`useHarnessState`). The harness itself is the source of truth for
agent/session state; the TUI mirrors it via event subscription.

There are five categories of state:

| Category | Mechanism | Owner |
|----------|-----------|-------|
| Agent/session state (messages, phase, model, queue, tools) | `HarnessState` via `useHarnessState` | `App.tsx` passes down as props |
| HarnessHandle state (replaceable harness + session) | `useState<HarnessHandle>` in `App` | `App.tsx` — `handle.replace()` triggers re-subscription |
| Local UI state (notice, input buffer, overlay) | `useState` in the component | `App.tsx` / `InputBox.tsx` |
| Pending image attachments (multimodal) | `useState<PendingImage[]>` in `App` | `App.tsx` — shared by commands + submit handlers; InputBox only displays |
| Synchronous mirror (latest messages for async callbacks) | `useRef` | `useHarnessState.ts` |

---

## Data Flow

```
AgentHarness (source of truth)
  │  subscribe(AgentHarnessEvent)
  ▼
useHarnessState  ──►  HarnessState (React state)
  │                      │ props
  │                      ▼
  │  messagesRef.current (sync mirror)
  │
  ▼
Display components (MessageList, StatusBar, InputBox)
```

- **One direction.** Harness → events → `useHarnessState` → props →
  components. Components never mutate harness state directly.
- **One exception:** user actions go back through `App.tsx` handlers
  (`handlePrompt`, `handleCommand`) that call harness methods. The resulting
  state change comes back through the event stream.

---

## Patterns

### HarnessHandle as React state

`App.tsx` holds a `HarnessHandle` (not a raw `AgentHarness`) as `useState`.
The handle's `replace()` method rebuilds the harness and calls `setHandle`,
which changes `handle.harness` identity. Since `useHarnessState` depends on
`[harness, session, compactionSettings]`, this automatically triggers
unsubscribe → re-subscribe → `reloadMessages()`. This is the mechanism behind
`/reload` and session switching (`/new`, `/resume`).

`replace()` returns `{ diagnostics: string[] }` — resource-load warnings
from skill/template files are surfaced by the caller (`/reload`, `/new`,
`/resume` print each as `warning: …`). `/reload` passes `resolvedSettings`
so `replayHarnessState` re-resolves model/thinking/stream/queue-modes from
disk; `/new`/`/resume` omit it to preserve the current runtime config.

Compaction settings flow through React state: `App.tsx` computes
`const compactionSettings = useMemo(() => resolveCompactionSettings(settings), [settings])`
and passes it as the third argument to `useHarnessState`. When `/reload`
updates `settings`, the memo recomputes → the effect re-runs →
`compactor.setSettings(compactionSettings)` syncs the new thresholds/enabled
flag.

```tsx
const [handle, setHandle] = useState<HarnessHandle>(() =>
  createHarnessHandle({ harness, session, sessionPath, trusted }, { env, models, cwd, systemPrompt, setHandle }),
);
const compactionSettings = useMemo(() => resolveCompactionSettings(settings), [settings]);
const state = useHarnessState(handle.harness, handle.session, compactionSettings);
```

### Overlay state

`App.tsx` owns an `Overlay` union (`null | { kind: "settings" } | …`). When
non-null, the overlay component replaces `InputBox` in the render tree (see
`component-guidelines.md` § "Overlay Pattern").

```tsx
const [overlay, setOverlay] = useState<Overlay>(null);
```

### Permission prompt state

Tool permission confirmation is **not** an Overlay variant: it comes from
`TuiApprover.subscribe()` into `permissionPrompt` state. When non-null it
takes render priority over InputBox/overlays so the in-flight turn can wait
without flipping phase to idle. Esc/Ctrl-C while a prompt is active resolves
as Deny via `tuiApprover.denyAll()`.

```tsx
const [permissionPrompt, setPermissionPrompt] = useState<PermissionPromptState | null>(null);
useEffect(() => tuiApprover?.subscribe(setPermissionPrompt), [tuiApprover]);
```

### Pass slices, not the whole store

Use `Pick<HarnessState, …>` to pass only what each component needs:

```tsx
type StatusBarProps = Pick<HarnessState, "phase" | "model" | "thinkingLevel" | "activeToolNames" | "queue">;
```

### Local UI state stays local

`InputBox` owns its `input` buffer (`useState("")`). It does not push it into
`HarnessState`. `App` owns the `notice` array and exposes `print()` as a
callback:

```tsx
const [notice, setNotice] = useState<string[]>([]);
const print = (text: string): void => { setNotice(text.split("\n")); };
```

### Ref mirror for async reads

`messagesRef` mirrors `messages` so async handlers (e.g. `settled` →
auto-compaction) can read the latest history without stale-closure bugs:

```ts
const messagesRef = useRef<AgentMessage[]>([]);
// in message_end handler:
messagesRef.current = [...messagesRef.current, event.message];
```

---

## Forbidden Patterns

- Do not introduce a global store (Redux / context-based) without an explicit
  task. `useState` + props is sufficient for this app size.
- Do not duplicate harness state into `useState`. If `HarnessState` already
  has it, derive / pass it down.
- Do not put the input buffer or notice lines into `HarnessState` — they are
  pure UI concerns.
- Do not read `state.messages` inside async callbacks; use `messagesRef.current`.
