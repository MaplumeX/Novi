# Error Handling

> How errors are caught, thrown, and surfaced across the backend layer.

---

## Overview

Novi follows a **throw-on-failure, catch-at-boundary** model:

- Internal modules `throw new Error(...)` with descriptive messages.
- Boundaries (`cli.ts` top-level, TUI event handlers, tool `execute`)
  catch and surface errors to the user / model.
- The `ExecutionEnv` API returns `Result<T, Error>` objects (`{ ok: true |
false }`); helper `unwrap` converts failed results into thrown errors.

There are no custom error classes. All errors are `Error` instances with a
clear message string.

---

## Result Wrapping: `unwrap`

`ExecutionEnv` methods return discriminated-union results. Use the shared
`unwrap` helper to convert failures into throws:

```ts
// src/tools/shared.ts
export function unwrap<T>(
  result: { ok: true; value: T } | { ok: false; error: Error },
  context: string,
): T {
  if (!result.ok) {
    throw new Error(`${context}: ${result.error.message}`);
  }
  return result.value;
}
```

Usage pattern — every env call is unwrapped with a context prefix:

```ts
const res = await env.readTextFile(abs, signal);
const text = unwrap(res, `read_file failed for "${params.path}"`);
```

---

## Tool Error → Model Visibility

Tools indicate failure to the model by **throwing**. The harness translates a
thrown error into a tool result with `isError: true`. Do not return a
`textResult("error: …")` for genuine failures — throw instead.

Tool/runtime boundary failures use a stable, bounded single-line envelope:

```text
NOVI_ERROR:<code>:<message up to 500 characters>
```

For example, Bash non-zero failures use `TOOL_EXIT_NONZERO` and include only a
bounded tail; complete stdout/stderr belongs in the governed artifact, never in
the thrown error or result details. Timeouts, cancellation, memory limits, and
artifact failures use `TOOL_TIMEOUT`, `TOOL_ABORTED`, `TOOL_MEMORY_LIMIT`,
`ARTIFACT_QUOTA_EXCEEDED`, and `ARTIFACT_WRITE_FAILED` respectively.

For `edit_file`, an ambiguous match (0 or >1) throws rather than silently
no-ops:

```ts
if (count === 0) throw new Error(`edit_file: oldText not found in "${params.path}".`);
if (count > 1) throw new Error(`edit_file: oldText matches ${count} times, must be unique.`);
```

---

## Boundary Handling

| Boundary                       | Handler                                                                      |
| ------------------------------ | ---------------------------------------------------------------------------- |
| `cli.ts` top-level `try/catch` | Formats `error.message` → `fail()` (writes stderr + `process.exit(1)`)       |
| `App.tsx` `handlePrompt`       | `.catch` → `print("Prompt failed: …")`                                       |
| `App.tsx` `handleCommand`      | `try/catch` → `print("Command failed: …")`                                   |
| `bootstrap.ts` `resolveModel`  | Throws clear config errors (no models, not found, no API key)                |
| `resources.ts` loader          | Never throws — collects `diagnostics[]`, caller writes to stderr as warnings |

---

## Startup vs Runtime Errors

- **Startup errors** (bootstrap): fatal. `cli.ts` catches and exits with a
  human-readable message. Example: provider not configured → "Set
  ANTHROPIC_API_KEY …".
- **Runtime errors** (turn / command): non-fatal. Caught at the TUI boundary
  and surfaced as a notice line. The harness always returns to `idle` phase
  (`agent_end` is emitted even on run failure via `emitRunFailure`).

---

## Forbidden Patterns

- Do not swallow errors silently (no empty `catch {}`). If a failure is
  intentional and non-fatal, log a diagnostic or warning.
- Do not create custom error subclasses. Use `Error` with a clear message
  prefixed by context.
- Do not return error text as a successful tool result when the operation
  genuinely failed — throw so the harness marks `isError`.
- Do not let resource loaders throw. Invalid skill/template files must produce
  diagnostics, not crash startup.
