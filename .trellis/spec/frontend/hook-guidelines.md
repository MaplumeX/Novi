# Hook Guidelines

> Custom hook patterns in the Novi TUI.

---

## Overview

Novi has one central custom hook today: `useHarnessState`. It is the sole
bridge between the `AgentHarness` event stream and React state. The frontend
intentionally keeps hook usage minimal — components stay props-driven.

---

## The Event Boundary Hook

`useHarnessState` subscribes to `harness.subscribe()` and projects every
relevant `AgentHarnessEvent` into a single `HarnessState` object:

```ts
export function useHarnessState(
  harness: AgentHarness,
  session?: Session<JsonlSessionMetadata>,
): HarnessState {
  const [state, setState] = useState<HarnessState>(() => ({ … }));
  // …
  useEffect(() => {
    let cancelled = false;
    const unsubscribe = harness.subscribe((event) => {
      switch (event.type) {
        case "turn_start": setState(…); break;
        // …
      }
    });
    return () => { cancelled = true; unsubscribe(); };
  }, [harness, session]);

  return state;
}
```

Key conventions enforced here:

- **Single subscriber.** Only this hook calls `harness.subscribe`. Display
  components consume `HarnessState`, never raw events.
- **Cleanup on unmount.** The `useEffect` returns an unsubscribe + `cancelled`
  flag so async reloads after unmount are ignored.
- **Dependencies.** `[harness, session]` — re-subscribes if either identity
  changes. In practice these come from `handle.harness` / `handle.session`,
  so `handle.replace()` (which sets a new handle with a new harness) triggers
  re-subscription automatically.
- **Synchronous ref mirror.** A `useRef<AgentMessage[]>` mirrors
  `messages` so post-turn handlers (`settled`) can read the latest history
  outside React's render cycle.

---

## Patterns

### Initialize state lazily from the harness

Seed the initial `useState` from harness getters (synchronous):

```ts
const [state, setState] = useState<HarnessState>(() => ({
  phase: "idle",
  model: harness.getModel(),
  thinkingLevel: harness.getThinkingLevel(),
  activeToolNames: harness.getActiveTools().map((t) => t.name),
  // …
}));
```

### Persistent instance via `useState` factory

When a helper class must survive re-subscribes, store it with `useState`:
```ts
const [compactor] = useState(() => new AutoCompactor());
```

### Fire-and-forget with optimistic phase

When an async operation (compaction) won't emit an immediate event, flip the
phase optimistically and reset on the eventual event:
```ts
void compactor.maybeCompact(harness, …, () => setState((prev) => ({ …prev, phase: "compaction" })))
  .catch(() => setState((prev) => prev.phase === "compaction" ? { …prev, phase: "idle" } : prev));
```

---

## Forbidden Patterns

- Do not create additional `useEffect` subscriptions to the harness. Route all
  events through `useHarnessState`.
- Do not read `messages` from React state inside async callbacks — use the ref
  mirror instead (stale closure).
- Do not call structural harness methods (`prompt`, `compact`,
  `navigateTree`) from the hook. Those require idle and belong in `App.tsx`
  handlers or commands.
