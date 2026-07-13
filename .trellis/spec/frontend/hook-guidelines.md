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
  compactionSettings?: CompactionSettings,
): HarnessState {
  const [state, setState] = useState<HarnessState>(() => ({ … }));
  // …
  useEffect(() => {
    let cancelled = false;
    if (compactionSettings) compactor.setSettings(compactionSettings);
    const unsubscribe = harness.subscribe((event) => {
      switch (event.type) {
        case "turn_start": setState(…); break;
        // …
      }
    });
    return () => { cancelled = true; unsubscribe(); };
  }, [harness, session, compactionSettings]);

  return state;
}
```

Key conventions enforced here:

- **Single subscriber.** Only this hook calls `harness.subscribe`. Display
  components consume `HarnessState`, never raw events.
- **Cleanup on unmount.** The `useEffect` returns an unsubscribe + `cancelled`
  flag so async reloads after unmount are ignored.
- **Dependencies.** `[harness, session, compactionSettings]` — re-subscribes if
  any identity changes. In practice these come from `handle.harness` /
  `handle.session` / `App`'s `useMemo(resolveCompactionSettings(settings))`,
  so `handle.replace()` (which sets a new handle with a new harness) triggers
  re-subscription automatically. `/reload` updating `settings` recomputes
  `compactionSettings`, which also re-runs the effect and syncs
  `compactor.setSettings()`.
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

When a helper class must survive re-subscribes, store it with `useState`.
The `AutoCompactor` is seeded with initial compaction settings and updated
via `setSettings` on every effect run:
```ts
const [compactor] = useState(() => new AutoCompactor(compactionSettings));
// in the subscribe effect:
if (compactionSettings) compactor.setSettings(compactionSettings);
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

## Scenario: Stable live tool transcript projection

### 1. Scope / Trigger

Apply this contract when changing `tool_execution_start`,
`tool_execution_update`, or `tool_execution_end` handling for the TUI. The
dependency exposes generic tool payloads as `any`; components must never inherit
that untyped boundary.

### 2. Signatures

```ts
interface ToolCallView {
  id: string;
  name: string;
  args: Record<string, unknown>;
  status: "running" | "done" | "error";
  partialText?: string;
  resultText?: string;
}

normalizeToolArgs(value: unknown): Record<string, unknown>
normalizeToolResultText(value: unknown): string
```

### 3. Contracts

- `tool_execution_start` upserts one view by `toolCallId`, with normalized
  arguments and `running` status.
- `tool_execution_update` updates the same id and projects text content into
  `partialText`; non-text/image-only parts are ignored for terminal summaries.
- `tool_execution_end` preserves args/partial output, freezes `resultText`, and
  sets `done` or `error` from `isError`.
- `MessageList` joins this view to the persisted assistant tool call by `id`.
  The later `ToolResultMessage` is authoritative for resumed history.

### 4. Validation & Error Matrix

| Input | Projection |
|---|---|
| args is a plain object | shallow `Record<string, unknown>` copy |
| args is null/array/primitive | `{}` |
| result has text content | text parts joined with newlines |
| result is string | string retained |
| result has no text | empty string; status still updates |
| update/end arrives before start | resilient upsert; do not drop the event |

### 5. Good/Base/Bad Cases

- Good: start → multiple updates → end keeps one row and the latest text.
- Base: start → end with no printable result still becomes `done`.
- Bad: malformed args or image-only output never causes a component cast or
  crashes the transcript.

### 6. Tests Required

- Pure projection tests assert one stable id across start/update/end.
- Assert out-of-order update/end still produces a view with the correct status.
- Transcript tests assert a live id already present in assistant history is not
  rendered a second time.
- Ink rendering tests assert compact mode hides raw args and detail mode reveals
  complete output.

### 7. Wrong vs Correct

```tsx
// Wrong: a second live-only renderer leaks the event contract and duplicates rows.
streamingToolCalls.map((call) => <Text>{call.name} running</Text>)

// Correct: attach the typed projection to the persisted toolCall by id.
<ToolCallBlock call={part} live={liveById.get(part.id)} result={result} />
```
