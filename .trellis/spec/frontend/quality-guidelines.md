# Quality Guidelines

> Code standards, linting, and testing for the Novi frontend (TUI) layer.

---

## Toolchain

Same as backend — the whole package shares one config:

- **TypeScript** `strict: true`, `target: ES2023`, `module: Node16`.
- **ESLint** flat config (`@eslint/js` + `typescript-eslint` recommended).
  `.pi/`, `.claude/`, `.trellis/`, `dist/`, `node_modules/` are ignored.
- **Prettier**: semi on, double quotes, trailing comma all, print width 100,
  tab width 2.
- **Tests**: `vitest run`. Co-located `*.test.ts(x)` files.
- **Typecheck**: `tsc --noEmit`.

Before finishing frontend work: `npm run typecheck && npm run lint &&
npm run test && npm run build`.

---

## Code Standards

### Imports

Node built-ins → external packages → local modules. Separate value and type
imports. `.js` extensions on all relative imports (Node16 resolution).

```tsx
import { useState } from "react";
import { Text, useApp, useInput, render } from "ink";
import type { AgentHarness } from "@earendil-works/pi-agent-core/node";
import { useHarnessState } from "./useHarnessState.js";
```

### JSDoc on non-obvious components / hooks

Public components and hooks carry a JSDoc block explaining their role and
constraints:

```tsx
/**
 * Single-line-aware input with optional multi-line (Shift+Enter). Enter submits.
 * Lines starting with `/` are routed to `onCommand`; everything else to
 * `onPrompt`.
 */
export function InputBox(…): React.ReactElement { … }
```

### Inline comments capture the "why"

When a rendering decision is non-obvious (e.g. avoiding `marked.lexer` during
streaming), document it:

```tsx
// Performance: `marked.lexer` runs over the full text per call. Callers must
// NOT feed streaming deltas here — during streaming, render `<Text>` directly.
```

---

## Testing

- Co-locate tests: `commands.ts` → `commands.test.ts`.
- Pure functions are unit-tested in isolation without Ink / React:
  `parseCommand` tests in `commands.test.ts`.
- Mock harness with `vi.fn()` + `as unknown as AgentHarness` for hook-level
  tests.
- Component rendering tests (Ink `render` + assertions) are acceptable but
  currently the codebase tests logic over rendered output — match existing
  style unless a visual regression needs verifying.

---

## Forbidden Patterns

- No `console.log` / `console.error` in the TUI — stray stdout writes corrupt
  the Ink render.
- No `process.stdout`/`process.stderr` writes from components (startup paths
  in `cli.ts` / `bootstrap.ts` are the exception).
- No direct `harness.subscribe()` outside `useHarnessState`.
- No passing `AgentHarness` / `Session` instances into display components
  (`MessageList`, `StatusBar`, `InputBox`) — pass already-projected state.
- No streaming deltas fed into `Markdown` — it expects finalized text.
- No default import of typebox (`import Type from …`); use
  `import * as Type`.
- When spawning external processes that take over the terminal (e.g.
  `openExternalEditor`), **always** disable stdin raw mode before spawning and
  restore it in a `finally` block. Forgetting the `finally` on a spawn failure
  leaves the terminal stuck in raw mode (no visible input, Ink can't render).
