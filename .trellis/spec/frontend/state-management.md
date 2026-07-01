# State Management

> State library, patterns, and data flow in the Novi TUI.

---

## Overview

Novi uses **no state management library** (no Redux, Zustand, Jotai, etc.).
State is plain React: `useState` + `useRef` + a single custom hook
(`useHarnessState`). The harness itself is the source of truth for
agent/session state; the TUI mirrors it via event subscription.

There are three categories of state:

| Category | Mechanism | Owner |
|----------|-----------|-------|
| Agent/session state (messages, phase, model, queue, tools) | `HarnessState` via `useHarnessState` | `App.tsx` passes down as props |
| Local UI state (notice, input buffer) | `useState` in the component | `App.tsx` / `InputBox.tsx` |
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
