# Design — Interactive /model picker overlay

## Architecture & Boundaries

Three touch points, all in the existing TUI layer (`src/tui/`):

1. **`commands.ts`** — extend the `Overlay` union; change the `/model`
   no-args branch from "print text list" to "build configured-provider model
   list → `setOverlay({ kind: "modelPicker", ... })`".
2. **`ModelPicker.tsx`** (new) — presentational + input component, modeled on
   `SessionPicker.tsx`.
3. **`App.tsx`** — add a render branch for the `modelPicker` overlay kind.

No backend / harness changes. `harness.setModel` / `harness.getModel` already
exist and are used by the current direct-switch path.

## Data flow

```
/model (no args)
  └─ in command run():
       current = harness.getModel()                 // { provider, id }
       providers = models.getProviders()            // all registered
       configuredModels: ModelInfo[] = []
       for provider of providers:
         models = models.getModels(provider.id)
         if models.length === 0: continue
         auth = await models.getAuth(models[0])     // local, no network
         if !auth: continue                          // unconfigured → skip
         for m of models:
           configuredModels.push({ provider: provider.id, id: m.id })
       // current-model index for initial cursor
       currentIndex = configuredModels.findIndex(
         m => m.provider === current.provider && m.id === current.id)
       setOverlay({
         kind: "modelPicker",
         models: configuredModels,
         currentIndex: currentIndex >= 0 ? currentIndex : 0,
       })
```

`getAuth` calls are awaited; the `/model` command `run` is already `async`.
Falling back to index 0 when the current model isn't in the list (e.g. the
current model's provider lost its key) keeps the picker usable.

### Why check the provider's *first* model for auth

Auth is provider-scoped (`Provider.auth` is a single field on the provider,
not per-model). `Models.getAuth(model)` resolves through the owning provider's
auth, so any model from the same provider yields the same result. Picking the
first model avoids per-model `getAuth` calls and is documented in the PRD as
the filtering strategy.

## Contracts

### `Overlay` variant (commands.ts)

```ts
| { kind: "modelPicker"; models: ModelEntry[]; currentIndex: number }
```

```ts
export interface ModelEntry {
  provider: string;
  id: string;
}
```

`ModelEntry` is exported from `commands.ts` (co-located with the `Overlay`
type, same as `SessionInfo` lives in `SessionPicker.tsx`). `currentIndex` is
passed rather than re-derived in the component so the "current model" logic
stays in the command (where `harness.getModel()` is available) and the
component stays dumb.

### `ModelPicker.tsx` props

```ts
interface ModelPickerProps {
  models: ModelEntry[];
  currentIndex: number;
  onPick: (entry: ModelEntry) => void;
  onCancel: () => void;
}
```

### Keyboard behavior

Identical to `SessionPicker.tsx`:
- `↑` → cursor = (cursor - 1 + len) % max(len, 1)
- `↓` → cursor = (cursor + 1) % max(len, 1)
- `Enter` → `onPick(models[cursor])` (or `onCancel` if empty)
- `Esc` → `onCancel`

### `App.tsx` onPick handler

```tsx
onPick={(entry) => {
  void (async () => {
    try {
      const model = models.getModel(entry.provider, entry.id)!;
      await handle.harness.setModel(model);
      setOverlay(null);
      print(`Switched to ${entry.provider}/${entry.id}.`);
    } catch (e) {
      setOverlay(null);
      print(`Switch failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  })();
}}
```

Mirrors the `sessionPicker` resume handler structure. `models` is in scope in
`App` (passed as prop). The `!` is safe because the entry came from
`models.getModels()`.

## Compatibility & Trade-offs

- **Backward compat**: the `/<id>` and `/<provider>/<id>` direct-switch paths
  are untouched, so existing scripts / habits keep working.
- **Existing test impact**: `commands.test.ts` has a test asserting the
  *current* no-args behavior (prints "Current model: ..." / "Models for ...").
  That test must be rewritten to assert `setOverlay` is called with the
  `modelPicker` kind. The mock `models` object in `makeModelCtx` must gain
  `getProviders` and `getAuth` stubs.
- **Empty list edge case**: if no provider is configured at all (shouldn't
  happen — the running harness already has a configured provider), the picker
  renders "No models available." and Enter/Esc both cancel. Reuses the
  `SessionPicker` empty-list pattern.
- **No search/filter**: intentionally omitted (PRD out-of-scope). Pure
  arrow-key browsing keeps the component trivial and consistent with
  `SessionPicker`.
- **No `Models.refresh()`**: only last-known static lists are used; dynamic
  providers show whatever models were registered at boot. Acceptable for an
  interactive switcher; dynamic discovery is a separate concern.

## Rollback

Pure frontend change, no data migration. Reverting the 3-file change (plus the
test update) restores prior behavior. No session-format or settings-file
impact.
