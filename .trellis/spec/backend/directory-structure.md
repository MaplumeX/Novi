# Directory Structure

> How backend (non-TUI core) code is organized in Novi.

---

## Overview

Novi is a single-package TypeScript ESM agent harness + TUI. `src/` is the
entire source tree; there is no separate server/api directory. "Backend" here
means **non-TUI core logic**: CLI entry, bootstrap wiring, config, tools,
resource loading, compaction.

Build: `tsc` (`module: Node16`, `moduleResolution: Node16`, `strict`). Run:
`tsx src/cli.ts` (dev) or `node dist/cli.js` (built). Node >= 22.19.

---

## Directory Layout

```
src/
├── cli.ts                  # Entry: parseArgs → bootstrap → renderApp
├── bootstrap.ts            # Wires env / session / models / harness / tools / resources
├── config.ts               # Path resolution (~/.novi, sessions, system-prompt candidates)
├── default-system-prompt.ts# Fallback system prompt constant
├── resources.ts            # Loads skills + prompt templates (user → project layers)
├── compaction.ts           # AutoCompactor: turn debounce + threshold check
├── *.test.ts               # Co-located tests alongside their source
├── tools/                  # Built-in tool set, one file per tool
│   ├── index.ts            # createBuiltinTools(env) aggregator
│   ├── shared.ts           # Shared helpers (unwrap / textResult / sliceLines …)
│   ├── bash.ts             # Each tool: createXxxTool(env): AgentTool
│   ├── read-file.ts
│   ├── write-file.ts
│   ├── edit-file.ts
│   ├── ls.ts
│   ├── glob.ts
│   ├── grep.ts
│   ├── todo.ts             # Exception: no env dependency (in-memory singleton)
│   └── __tests__/          # Tool tests + helpers.ts (setupEnv / getTool / writeFixture)
└── tui/                    # Frontend layer (see frontend/directory-structure.md)
```

---

## Module Organization

- **One file = one module.** Each file exports its factory function / types /
  constants directly. Do not add a barrel `index.ts` unless a sub-directory
  needs a single public entry (the only existing one is `tools/index.ts` with
  `createBuiltinTools`).
- **Single entry point.** `cli.ts` is the process entry (`#!/usr/bin/env node`
  + `package.json` `bin`). Other modules must not call `process.exit` or write
  `process.stderr` directly, except for top-level startup error paths.
- **Tool files.** One file exports one `createXxxTool`, closing over
  `ExecutionEnv`, returning `AgentTool<typeof Parameters>`. The parameter
  schema is defined with typebox in the same file.
- **Co-located tests.** `foo.ts` → `foo.test.ts`; `tools/` tests live under
  `tools/__tests__/`. Tests are excluded from `dist` (tsconfig includes only
  `src` and `tsc` does not compile `.test.ts` — vitest covers them).

---

## Naming Conventions

- Files / directories: `kebab-case` (`edit-file.ts`, `render-token.tsx`).
- Factory functions: `createXxxTool` (tools) / `makeXxx` (internal wiring,
  e.g. `makeSystemPromptProvider`).
- Constants: `UPPER_SNAKE_CASE` (`DEFAULT_PROVIDER`,
  `CONTEXT_WINDOW_FALLBACK`).
- Types / interfaces: `PascalCase` (`BootstrapOptions`, `LoadedResources`).
- Test-only escape hatches: `__resetXxxForTests` (double-underscore prefix,
  see `todo.ts`).

---

## Examples

- Tool aggregator: `src/tools/index.ts`
- Bootstrap wiring in full: `src/bootstrap.ts`
- Pure path/config functions: `src/config.ts`
