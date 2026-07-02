# Implement — Interactive /model picker overlay

## Ordered checklist

1. **`src/tui/commands.ts`**
   - Add `ModelEntry` interface (exported).
   - Extend `Overlay` union with
     `{ kind: "modelPicker"; models: ModelEntry[]; currentIndex: number }`.
   - Rewrite the `/model` command no-args branch:
     - Build `configuredModels` by iterating `ctx.models.getProviders()`,
       skipping providers with no models, calling `ctx.models.getAuth(first)`
       (await; skip if `undefined`).
     - Compute `currentIndex` against `ctx.harness.getModel()`.
     - Call `ctx.setOverlay({ kind: "modelPicker", models, currentIndex })`.
   - Leave the `/<id>` and `/<provider>/<id>` branches unchanged.

2. **`src/tui/ModelPicker.tsx`** (new)
   - Component modeled on `SessionPicker.tsx`: `useState(cursor)` seeded from
     `currentIndex`; `useInput` for ↑/↓/Enter/Esc.
   - Render provider-grouped list with `provider/id`; current model marked with
     `›`.
   - Empty list → dim "No models available.".

3. **`src/tui/App.tsx`**
   - Import `ModelPicker`.
   - Add render branch for `overlay.kind === "modelPicker"`:
     `onPick` → `handle.harness.setModel` + `print` + `setOverlay(null)`;
     `onCancel` → `setOverlay(null)`.

4. **`src/tui/commands.test.ts`**
   - Update `makeModelCtx` mock: add `getProviders` (returns provider list)
     and `getAuth` (returns a truthy auth for "configured" providers).
   - Rewrite the "lists current provider models … when no args" test to assert
     `setOverlay` is called with `{ kind: "modelPicker", ... }`.
   - Keep the direct-switch tests (`claude-y`, `openai/gpt-5`, unknown model)
     unchanged.

5. **Validate**
   - `npm run typecheck`
   - `npm run lint`
   - `npm test` (vitest)

## Validation commands

```bash
npm run typecheck   # tsc --noEmit
npm run lint        # eslint .
npm test            # vitest run
```

## Risky files / rollback points

- `src/tui/commands.test.ts` — the no-args `/model` test is the one behavioral
  assertion that must change; the three direct-switch tests must stay green.
- `src/tui/App.tsx` — overlay render branch; a mistyped variant in the
  `overlay === null ? ... : ... : ...` chain breaks all overlays. Check the
  chain compiles with `tsc`.
- Rollback: revert the 4 file changes; no data/settings impact.
