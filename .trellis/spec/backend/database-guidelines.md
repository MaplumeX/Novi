# Database Guidelines

> How Novi handles persistence (sessions, TODOs, resources).

---

## Overview

Novi has **no database**. All persistence is file-based via the
`@earendil-works/pi-agent-core` APIs:

- **Sessions** → JSONL files on disk, managed by `JsonlSessionRepo`.
- **Gateway session bindings** → strict versioned JSON at
  `~/.novi/gateway-sessions.json` (`NOVI_HOME` respected).
- **Gateway inbox/outbox** → strict versioned per-record JSON under
  `~/.novi/gateway-messages/`; see `durable-message-delivery.md`.
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
disk on cache miss). `createBuiltinToolAssembly(env, sessionId)` threads the session id
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

## Scenario: Durable Gateway Session Binding

### 1. Scope / Trigger

- Trigger: any change to Gateway routing, cache eviction, `/new`, JSONL resume,
  or cross-channel identity representation.
- The in-memory harness cache is disposable. Conversation continuity is owned
  by `GatewaySessionStore`, not by `NoviAgentAdapter.sessions`.

### 2. Signatures

```ts
interface GatewaySessionLocator {
  channel: string;
  account: string;
  chat: { type: ChatType; id: string };
  thread?: string;
}
interface GatewaySessionRoute { key: string; locator: GatewaySessionLocator }

GatewaySessionStore.open(filePath?): Promise<GatewaySessionStore>
store.getBinding(route): GatewaySessionBinding | undefined
store.bind(route, metadata): Promise<void>
store.rotate(route, metadata): Promise<void>

createHarnessForSession(env, { kind: "new" | "resume", ... }): Promise<CreatedSession>
```

`CreatedSession.metadata` is the canonical metadata returned by
`session.getMetadata()`. JSONL creation/open/deletion still goes only through
the public `JsonlSessionRepo` API.

### 3. Contracts

- File: `$NOVI_HOME/gateway-sessions.json`, otherwise
  `~/.novi/gateway-sessions.json`.
- V1 root: `{version:1, bindings: Record<routeKey, Binding>, archives: Archive[]}`.
- Binding: `{locator, session:{id,createdAt,cwd,path}, boundAt, updatedAt}`.
- Archive: `{locator, session, archivedAt, reason:"new"}`.
- Canonical route fields are URI-encoded and include channel type, account,
  chat type/id, and optional thread id. A stored key must recompute exactly
  from its locator.
- Writes serialize through one Promise chain, write a same-directory `0600`
  temporary file, then rename. Publish the new in-memory snapshot only after
  rename succeeds.
- Multiple locators may reference the same metadata at schema level. The
  current product does not expose linking or concurrent shared-session use.
- Idle/capacity eviction closes runtime/MCP resources only; it never removes
  the binding. `/new` aborts the old generation, discards its queued messages,
  suppresses late events, creates a new session, and rotates binding+archive
  in one store commit. Old JSONL/TODO files remain.

### 4. Validation & Error Matrix

| Condition                                            | Required behavior                                                                    |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Mapping file missing                                 | Start with an empty in-memory V1 store                                               |
| Invalid JSON / fields / route-key mismatch           | Fail Gateway startup; preserve file                                                  |
| Unsupported `version`                                | Fail Gateway startup; preserve file                                                  |
| Bound JSONL missing or metadata id/cwd/path mismatch | Fail the message visibly; preserve binding; require explicit `/new`                  |
| First bind write fails                               | Do not publish cache/binding; best-effort close and delete the unbound JSONL         |
| `/new` rotate write fails                            | Keep old durable binding; do not publish new cache; best-effort delete unbound JSONL |

### 5. Good/Base/Bad Cases

- Good: restart or eviction → look up binding → `repo.open(metadata)` → verify
  id/cwd/path → publish harness cache.
- Base: first message → `repo.create` → persist binding → publish cache.
- Bad: catch resume failure and silently call `repo.create`; this loses context
  while leaving the old JSONL/TODO bucket undiscoverable.

### 6. Tests Required

- Store: missing-file round trip, many locators/one metadata, rotate archive,
  corrupt/unsupported/mismatched input, write failure leaves snapshot unchanged.
- Adapter: first bind, cold resume after close, concurrent initialization
  dedupe, dangling target, metadata mismatch, rotate rollback, late-event guard.
- Manager/command: reset barrier, old queue cutoff, later-message wait, and
  success/failure channel acknowledgement.

### 7. Wrong vs Correct

```ts
// Wrong: cache eviction or restart silently starts a new conversation.
const session = await repo.create({ cwd, id: uuidv7() });
sessions.set(route.key, session);

// Correct: the durable binding chooses resume vs create; publish after commit.
const binding = store.getBinding(route);
const created = await createHarnessForSession(
  env,
  binding ? { kind: "resume", metadata: binding.session } : { kind: "new" },
);
if (!binding) await store.bind(route, created.metadata);
sessions.set(route.key, created);
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
- `tools.enabled` and `tools.sources` are tighten-only at project scope:
  project settings may disable, never enable.
- `permissions.rules` concatenate global rules with project `ask`/`deny`
  rules. Project `allow` rules are removed. Runtime parsing remains fail-closed.
- `permissions.externalWriteAllowlist` comes only from global settings;
  project values are ignored and diagnosed. See `tool-runtime-contracts.md`.

`ResolvedSettings` carries `_sources: Record<string, SettingSource>` so the
`/settings` form can display per-leaf provenance (`"global" | "project" |
"cli" | "default"`).

`writeSettings(env, targetPath, patch)` uses dot-path keys
(e.g. `"compaction.enabled"`) to shallow-merge into existing JSON. Creates
parent dirs if missing. A `null`/`undefined` value removes the key.

---

## MCP Config and Approval Store

MCP server declarations are **not** stored in `settings.json`. They use
independent files and an approval store separate from project trust
(`src/mcp/`).

```ts
import { resolveMcpPlan, setMcpApproval } from "./mcp/index.js";

const plan = await resolveMcpPlan(env, cwd);
// plan.entries[].status: "connectable" | "pending" | "denied" | "invalid"
await setMcpApproval(env, {
  serverName: "filesystem",
  fingerprint: plan.entries[0].fingerprint,
  decision: "approved",
  origin: "project",
  projectRoot: cwd,
});
```

- **User config**: `~/.novi/mcp.json` (`mcpServers` map). Always loadable.
- **Project config**: prefer `<cwd>/.mcp.json`; secondary `<cwd>/.novi/mcp.json`.
  If both exist, primary wins and the secondary path is ignored with a
  diagnostic.
- **Transports**: each server is either stdio (`command`/`args`/`env`/`cwd`)
  or Streamable HTTP (`url`/`headers`). Mixing both is invalid.
- **Merge**: project overlays user by server name; overlayed entries keep
  `origin: "project"`.
- **Fingerprint**: stable sha256 over canonical transport identity (sorted
  keys; env/header **values are hashed**, not stored raw in the fingerprint
  payload). Changing command/url/args/env values invalidates approval.
- **Approval store**: `~/.novi/mcp-approvals.json`, pretty-printed, best-effort
  `0600`. User servers are connectable without approval. Project servers
  default to `pending`; matching approved/denied entries are keyed by
  project root + name + fingerprint. Stale fingerprints return to `pending`.
- **Project trust is independent**: a trusted project does **not** auto-approve
  MCP servers.
- **Fail-soft**: missing/corrupt config or approval files degrade to empty +
  diagnostics; load paths do not throw. Approval writes may throw on hard IO
  failure (same style as trust/credentials).
- **Env placeholders**: `${VAR}` substitution is available via
  `resolveEnvPlaceholders` / `resolveServerConfigPlaceholders`. Connect-time
  missing-env enforcement belongs to the MCP client layer (not this store).
- Live MCP client lives beside this store (`transport.ts`, `client-manager.ts`,
  `tool-adapter.ts`) and consumes `resolveMcpPlan` connectable entries only.
  Unified tool merge is `src/tools/assembly.ts` (`createToolAssembly`,
  `assembleSessionTools`). Bootstrap / resume / reload / gateway and TUI
  `/mcp` use that helper; close MCP handles on harness replace, quit, and
  gateway session close.

---

## Credentials Store

API keys are **not** stored in `settings.json`. They live in a separate
file `~/.novi/credentials.json` (`src/credentials.ts`), physically isolated
from settings so accidental sharing/screenshots of `settings.json` never
leak secrets.

```ts
// Format: flat { "<ENV_VAR_NAME>": "<api_key>" } JSON object.
import { loadCredentials, writeCredentials, injectCredentialsIntoEnv } from "./credentials.js";

const creds = await loadCredentials(env); // missing/corrupt → {}
await writeCredentials(env, { ANTHROPIC_API_KEY: "sk-..." }); // shallow-merge + chmod 0600
injectCredentialsIntoEnv(creds, process.env); // only fills UNDEFINED vars
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
- Do not treat the Gateway harness `Map` as persistence, silently recover a
  dangling binding by creating a new session, or overwrite an invalid mapping.
- TODO files at `~/.novi/todos/<sessionId>.json` are write-through cached; do not bypass `persistToDisk` / `getSessionTodos`.
- Do not throw from resource loaders; collect diagnostics and continue.
