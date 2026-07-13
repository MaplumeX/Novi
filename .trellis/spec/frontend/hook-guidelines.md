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
  toolCatalog?: ToolCatalogSnapshot,
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
  }, [harness, session, compactionSettings, toolCatalog]);

  return state;
}
```

Key conventions enforced here:

- **Single subscriber.** Only this hook calls `harness.subscribe`. Display
  components consume `HarnessState`, never raw events.
- **Cleanup on unmount.** The `useEffect` returns an unsubscribe + `cancelled`
  flag so async reloads after unmount are ignored.
- **Dependencies.** `[harness, session, compactionSettings, toolCatalog]` —
  re-subscribes if any identity changes. In practice these come from
  `handle.harness` / `handle.session` / `handle.toolCatalog` / `App`'s
  `useMemo(resolveCompactionSettings(settings))`,
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

Apply this contract when changing tool execution handling, replay, or tool
transcript presentation. The dependency exposes generic payloads; only the
shared `ToolEventDecoder` may interpret them.

### 2. Signatures

```ts
interface ToolCallView {
  id: string;
  tool: ToolRef;
  name: string;
  args: Record<string, JsonValue>;
  status: "running" | "done" | "error" | "cancelled";
  partialText?: string;
  resultText?: string;
  result?: ToolResultEnvelope;
  lastSequence: number;
  diagnostics: string[];
}

const toolEvent = decoder.decode(event);
reduceToolCallState(calls, toolEvent): ToolCallView[];
persistedToolCallView(call, result, catalog): ToolCallView;
```

### 3. Contracts

- `useHarnessState` remains the sole TUI harness subscriber, but delegates all
  tool events to `ToolEventDecoder` and `reduceToolCallState`.
- Ordered deltas append to bounded `partialText`. Duplicate/out-of-order deltas
  do not append; gaps and invalid order remain visible in diagnostics.
- Final status and `resultText` come from the envelope, not raw `isError` or a
  component-owned content parser.
- `MessageList` uses `persistedToolCallView` for assistant/result history, then
  joins live state by id. A persisted envelope is authoritative and reused
  exactly on resume.
- `ToolCallBlock` receives one `view` prop for both live and persisted rows.
  Descriptor labels handle unknown/external tools; built-in presentation may
  specialize already-normalized inputs.
- `edit_file` presentation reads only canonical `edits[]` and aggregates all
  hunks.

### 4. Validation & Error Matrix

| Input                           | Projection                                            |
| ------------------------------- | ----------------------------------------------------- |
| descriptor exists               | preserve label/source/capabilities/risk in `ToolRef`  |
| descriptor is unknown           | bounded generic `ToolRef`; transcript remains safe    |
| ordered sequence                | append bounded delta and advance cursor               |
| duplicate/out-of-order sequence | retain prior text and add diagnostic                  |
| update/end arrives before start | resilient minimal view; do not drop the event         |
| persisted valid envelope        | exact final view, including cancellation/error        |
| canonical multiple edits        | aggregate summary and render each hunk in detail mode |

### 5. Good/Base/Bad Cases

- Good: start → sequences 1/2 → end keeps one row, accumulated output, and the
  same envelope after resume.
- Base: start → end with no printable result still freezes the envelope status.
- Bad: a component reads `partialResult`, casts `ToolResultMessage.details`, or
  renders a second live-only row.

### 6. Tests Required

- Shared reducer tests assert one stable id across ordered deltas and end.
- Assert duplicate/gap/out-of-order and update/end-before-start behavior.
- Assert persisted envelope replay equals the live final envelope.
- Transcript tests assert a live id already present in assistant history is not
  rendered a second time.
- Presentation tests cover single/multiple canonical edit diffs and descriptor
  fallback labels.

### 7. Wrong vs Correct

```tsx
// Wrong: component-owned decoding creates another event contract.
const resultText = rawResult.content.map((part) => part.text).join("\n");

// Correct: live and replay both produce the same typed view.
const view = persistedToolCallView(part, result, toolCatalog);
<ToolCallBlock view={liveById.get(part.id) ?? view} />;
```
