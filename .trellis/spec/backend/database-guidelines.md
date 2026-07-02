# Database Guidelines

> How Novi handles persistence (sessions, TODOs, resources).

---

## Overview

Novi has **no database**. All persistence is file-based via the
`@earendil-works/pi-agent-core` APIs:

- **Sessions** → JSONL files on disk, managed by `JsonlSessionRepo`.
- **TODOs** → in-memory process singleton (`tools/todo.ts`).
- **Skills / prompt templates** → YAML / markdown files loaded from disk at
  startup (`resources.ts`).

No ORM, no migrations, no SQL. This file documents the actual persistence
patterns so sub-agents don't invent database abstractions that don't exist.

---

## Session Persistence

Use the public `JsonlSessionRepo` API (NOT `JsonlSessionStorage`, which is
internal-only). See `backend/pi-agent-core-api.md` for the verified contract.

```ts
import { JsonlSessionRepo, uuidv7 } from "@earendil-works/pi-agent-core/node";

const repo = new JsonlSessionRepo({ fs: env, sessionsRoot });
// Create: repo computes path <sessionsRoot>/<encodeCwd(cwd)>/<timestamp>_<id>.jsonl
const session = await repo.create({ cwd, id: uuidv7() });
// Resume: repo.open reads metadata.path only
const session = await repo.open({ path } as JsonlSessionMetadata);
```

- `NodeExecutionEnv` implements `FileSystem` and is passed as `fs`.
- Session files land in `<sessionsRoot>/<encoded-cwd>/...jsonl`, not
  directly under `<sessionsRoot>/<id>.jsonl`.
- Never reach into storage internals; always go through `repo` / `session`
  public methods.

---

## TODO Store

`tools/todo.ts` keeps a module-level singleton array (`const store: Todo[]`).
Scope: a single process lifetime. The tool `execute` API exposes no sessionId,
so a process-wide list is the accepted design — it is **not** safe for
multi-session isolation.

```ts
export function createTodoTool(): AgentTool<typeof Parameters, TodoDetails> { … }
/** Reset the singleton store. Test-only escape hatch. */
export function __resetTodoStoreForTests(): void { store.length = 0; }
```

---

## Resource Loading

`resources.ts` loads skills + prompt templates from two layers:

1. User-level: `~/.novi/skills`, `~/.novi/prompts`
2. Project-level: `<cwd>/.novi/skills`, `<cwd>/.novi/prompts`

Skills are deduplicated by name with **project overriding user** (project is
scanned after user). Prompt templates are not deduplicated. Loaders skip
invalid files and collect `diagnostics` instead of throwing — load failures are
non-fatal warnings.

---

## Settings Files

Novi loads settings from `~/.novi/settings.json` (global) and
`<cwd>/.novi/settings.json` (project) via `src/settings.ts`. The merge rule:

- **Shallow one-level merge**: top-level keys are combined; nested objects are
  merged one level deep (spread), with project overriding global.
- Nested objects at depth > 1 are **replaced wholesale** by the project layer,
  not deep-merged.
- Unknown keys are preserved (forward-compat).
- Precedence: CLI flag > project settings > global settings > built-in default.
- Parse failures degrade to an empty layer + `stderr` warning; startup is
  never blocked.

`ResolvedSettings` carries `_sources: Record<string, SettingSource>` so the
`/settings` form can display per-leaf provenance (`"global" | "project" |
"cli" | "default"`).

`writeSettings(env, targetPath, patch)` uses dot-path keys
(e.g. `"compaction.enabled"`) to shallow-merge into existing JSON. Creates
parent dirs if missing. A `null`/`undefined` value removes the key.

---

## Credentials Store

API keys are **not** stored in `settings.json`. They live in a separate
file `~/.novi/credentials.json` (`src/credentials.ts`), physically isolated
from settings so accidental sharing/screenshots of `settings.json` never
leak secrets.

```ts
// Format: flat { "<ENV_VAR_NAME>": "<api_key>" } JSON object.
import { loadCredentials, writeCredentials, injectCredentialsIntoEnv } from "./credentials.js";

const creds = await loadCredentials(env);             // missing/corrupt → {}
await writeCredentials(env, { ANTHROPIC_API_KEY: "sk-..." }); // shallow-merge + chmod 0600
injectCredentialsIntoEnv(creds, process.env);          // only fills UNDEFINED vars
```

- **File**: `~/.novi/credentials.json`, JSON object `{ "ENV_VAR": "value" }`,
  pretty-printed, permission `0600` (set via `fs.chmod` after write; chmod
  failure is ignored, not fatal).
- **Injection at startup**: `bootstrap()` calls `loadCredentials` +
  `injectCredentialsIntoEnv` before `resolveModel`, so pi-ai's `getAuth` sees
  stored keys transparently. **Only `undefined` env vars are filled** — a user
  who explicitly exports a var always wins. Empty string is treated as set
  (the user explicitly cleared it).
- **Read-only display**: `/settings` shows credential key names + masked
  values (first 3 / last 4 chars) — never the full secret. Editing requires
  manual file edits or a future `/setup`.
- Key names come from pi-ai's provider→env mapping; see
  `backend/pi-agent-core-api.md` for the `findEnvKeys` enumeration trick.

---

## Forbidden Patterns

- Do not introduce a database (SQLite, Prisma, etc.) without an explicit task.
- Do not read/write session JSONL files directly; use `JsonlSessionRepo` /
  `Session` public APIs.
- Do not persist TODOs to disk — they are intentionally in-memory.
- Do not throw from resource loaders; collect diagnostics and continue.
