# Interactive /model slash command with model picker overlay

## Goal

Make the `/model` slash command interactive: instead of printing a text list
and requiring the user to re-type the model id, `/model` (no args) opens an
overlay picker that lets the user browse and select a model with the keyboard.

The picker lists **only models belonging to providers that currently have a
usable API key / credential configured**, so the user never sees providers they
cannot actually switch to.

## Background / Confirmed Facts

- `/model` today (`src/tui/commands.ts`) has two modes:
  - No args → prints a text list of the current provider's models (current
    model marked with `›`) plus usage hints.
  - `/<provider>/<modelId>` or `<modelId>` → direct switch via
    `harness.setModel`.
- An `Overlay` union already exists in `src/tui/commands.ts` with variants
  `settings | filePicker | sessionPicker | null`, rendered in `src/tui/App.tsx`.
- `SessionPicker.tsx` is the template for an overlay picker: `useState` cursor,
  `useInput` for ↑/↓/Enter/Esc, `↑/↓` move, `Enter` picks, `Esc` cancels.
  `InputBox` is unmounted while an overlay is open.
- `Models` interface (`@earendil-works/pi-ai`) exposes:
  - `getProviders(): readonly Provider[]` — all registered providers.
  - `getModels(provider?)` — last-known model list for one or all providers.
  - `getAuth(model): Promise<AuthResult | undefined>` — **local** check (no
    network call; confirmed by `src/onboarding.ts` comment "no network call")
    returning `undefined` when the provider is unconfigured.
- Auth is provider-scoped (a provider's auth result is the same regardless of
  which of its models is passed to `getAuth`), so checking the first model of
  each provider is sufficient to know whether the provider is configured.
- `CommandContext` already carries `models: Models`, `harness` (with
  `getModel()` / `setModel()`), and `setOverlay`.

## Requirements

### R1 — `/model` (no args) opens an interactive picker overlay

- When invoked with no args, `/model` must build a flat list of models grouped
  by provider, restricted to **providers whose credential is currently usable**
  (`Models.getAuth(firstModel) !== undefined`), and open the `modelPicker`
  overlay with that list.
- The current active model (from `harness.getModel()`, compared by
  `provider + id`) must be marked/highlighted as the initial cursor position.

### R2 — ModelPicker overlay component

- New component `src/tui/ModelPicker.tsx`, modeled on `SessionPicker.tsx`.
- Keyboard behavior:
  - `↑` / `↓` move the selection (wraps around).
  - `Enter` switches the harness to the selected model and closes the overlay.
  - `Esc` cancels (no model change) and closes the overlay.
- Display: models grouped by provider; each entry shows `provider/modelId`;
  the current model is visually marked (e.g. `›` prefix) and is the initial
  cursor.
- Error handling: on `setModel` failure, print the error via `ctx.print` and
  keep the overlay closed (consistent with `sessionPicker` resume flow).

### R3 — `/model <args>` keeps the direct-switch fast path

- `/model <modelId>` (no slash) and `/model <provider>/<modelId>` must behave
  exactly as today (resolve via `models.getModel`, switch via
  `harness.setModel`, print success/failure) without opening the picker.

### R4 — Overlay wiring

- Extend the `Overlay` union in `src/tui/commands.ts` with a `modelPicker`
  variant carrying the model list + the current model id (for initial cursor).
- Render `ModelPicker` in `src/tui/App.tsx` for the `modelPicker` overlay kind,
  calling `harness.setModel` on pick and `setOverlay(null)` on cancel/pick.

## Acceptance Criteria

- [ ] Running `/model` with no args opens a keyboard-navigable overlay listing
      models from every provider with a configured API key; unconfigured
      providers do not appear.
- [ ] The current model is highlighted and is the initial cursor position.
- [ ] `↑`/`↓` move the selection with wrap-around; `Enter` switches and closes;
      `Esc` cancels and closes with no model change.
- [ ] `/model <id>` and `/model <provider>/<id>` still switch directly without
      opening the overlay.
- [ ] Invalid arg (model not found) still prints an error and does not open
      the overlay.
- [ ] `npm run lint` and `npm run typecheck` (or the project's equivalent)
      pass.

## Out of Scope

- No search/filter text input inside the picker (pure arrow-key browsing).
- No dynamic `Models.refresh()` / remote model discovery — only the
  last-known static model lists are used.
- No persistence of the last-selected model beyond what `harness.setModel`
  already does.
- No changes to `/thinking`, status bar, or other commands.

## Open Questions

None — scope and provider-filtering approach are confirmed.
