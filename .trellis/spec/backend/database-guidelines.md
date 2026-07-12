# Database Guidelines

> How Novi handles persistence (sessions, TODOs, resources).

---

## Overview

Novi has **no database**. All persistence is file-based via the
`@earendil-works/pi-agent-core` APIs:

- **Sessions** → JSONL files on disk, managed by `JsonlSessionRepo`.
- **TODOs** → file-based persistence at `~/.novi/todos/<sessionId>.json` with an in-memory cache (`tools/todo.ts`).
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

`tools/todo.ts` persists todos to `~/.novi/todos/<sessionId>.json` with an
in-memory `Map<string, Todo[]>` as a write-through cache. Each session gets
its own list; `createTodoTool(sessionId)` closes over the sessionId and scopes
all operations to `getSessionTodos(sessionId)` (cache-first, lazy-loads from
disk on cache miss). `createBuiltinTools(env, sessionId)` threads the session id
through to the tool factory.

Persistence is best-effort: if the directory cannot be created or the file
written, the tool still works in-memory and logs a warning to stderr (no
throw). Corrupt JSON files degrade to an empty list. `/resume` (new process,
same session ID) reads from disk on first access; `/new` starts a new session
with an empty list. Session deletion does not clean up todo files (orphan
files accepted; data is small).

```ts
export function createTodoTool(sessionId: string): AgentTool<typeof Parameters, TodoDetails> { … }
/** Reset the store (in-memory cache + disk files). Test-only escape hatch. */
export function __resetTodoStoreForTests(): void { store.clear(); rmSync(…, { recursive: true, force: true }); }
```

---

## Resource Loading

`resources.ts` loads skills + prompt templates.

**Skill sources** (later wins on name collision; see D4):

1. User: `~/.agents/skills` (never trust-gated)
2. User: `~/.novi/skills` (never trust-gated)
3. Project: each `dir/.agents/skills` from git root → cwd (trust-gated;
   non-git trees scan only `<cwd>/.agents/skills`)
4. Project: `<cwd>/.novi/skills` (trust-gated)

**Prompt templates** remain two-layer only:
`~/.novi/prompts` + (when trusted) `<cwd>/.novi/prompts`.

Skills are deduplicated by name with **later sources overriding earlier**.
Prompt templates are not deduplicated. Loaders skip invalid files and collect
`diagnostics` instead of throwing — load failures are non-fatal warnings.
`hasGatedResources` treats project `.agents/skills` (git-root→cwd) as gated,
alongside `<cwd>/.novi/{settings,models,skills,prompts}`.

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
- TODO files at `~/.novi/todos/<sessionId>.json` are write-through cached; do not bypass `persistToDisk` / `getSessionTodos`.
- Do not throw from resource loaders; collect diagnostics and continue.
