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
│   ├── index.ts            # createBuiltinTools(env, sessionId) — thin wrapper over registry
│   ├── registry.ts         # BuiltinToolRegistry: add/buildAll/names
│   ├── shared.ts           # Shared helpers (unwrap / textResult / sliceLines …)
│   ├── bash.ts             # Each tool: createXxxTool(env): AgentTool
│   ├── read-file.ts
│   ├── write-file.ts
│   ├── edit-file.ts
│   ├── ls.ts
│   ├── glob.ts
│   ├── grep.ts
│   ├── todo.ts             # In-memory per-session todo store (Map<string, Todo[]>)
│   ├── web-search.ts        # web_search tool (createWebSearchTool)
│   ├── fetch-content.ts     # fetch_content tool (createFetchContentTool)
│   ├── web-search/          # Search provider abstraction + SSRF guard
│   │   ├── provider.ts      # SearchProvider interface + resolveProvider()
│   │   ├── duckduckgo.ts    # DuckDuckGo provider (zero-config)
│   │   ├── ssrf.ts          # isPrivateUrl() — private/loopback URL guard
│   │   └── __tests__/
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
  schema is defined with typebox in the same file. Tools are registered
  centrally via `BuiltinToolRegistry.add()` in `tools/index.ts` (see
  `tools/registry.ts`); to add a new built-in tool, add one `.add()` call
  there — there is no array literal to edit. The `web-search/` sub-directory
  hosts the search-provider abstraction (`SearchProvider` interface +
  `resolveProvider()` resolver) and the SSRF guard (`isPrivateUrl()`); adding
  a new search provider requires one new file exporting a `SearchProvider`
  instance and one line in the `PROVIDERS` array.
- **Co-located tests.** `foo.ts` → `foo.test.ts`; `tools/` tests live under
  `tools/__tests__/`. Tests are excluded from `dist` (tsconfig includes only
  `src` and `tsc` does not compile `.test.ts` — vitest covers them).

### Reusable tool patterns

Two patterns established by the web tools (`web-search/`, `fetch-content.ts`)
that future tools returning large/batched content may reuse:

- **Truncate + store + footer** (`fetch-content.ts:truncateWithFooter`):
  when content exceeds a char budget, send head 75% + tail 25% (line-aligned)
  to the model, store the full text under `~/.novi/cache/<scope>/`, and append
  a footer pointing to `read_file path="..." offset=N limit=200` for the
  omitted middle. Pairs with the existing `read_file` 1-based pagination.
- **Provider array + resolver** (`web-search/provider.ts`): a `SearchProvider`
  interface + a `PROVIDERS` array + a `resolveProvider(configured?)` function.
  Adding a provider = one file exporting an instance + one line in the array.
  `isAvailable()` must stay cheap (env-only, no network) so tool registration
  never blocks.

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
