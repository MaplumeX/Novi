# Research: API deviations from design.md (child 1)

Verified against installed `@earendil-works/pi-agent-core@0.80.3` and
`@earendil-works/pi-ai@0.80.3` (2026-07-01). No source clone; read `.d.ts`/`.js`
in `node_modules`.

## Deviation 1 — `JsonlSessionStorage` is NOT a public export

`design.md` / `implement.md` specify:

```
JsonlSessionStorage.create(env, filePath, { cwd, sessionId })
JsonlSessionStorage.open(env, filePath)
toSession(storage)
```

The class `JsonlSessionStorage` exists internally at
`dist/harness/session/jsonl-storage.js` but is **not** re-exported from the
package entry (`dist/index.d.ts`). Confirmed at runtime:

```js
import * as core from "@earendil-works/pi-agent-core";
"JsonlSessionStorage" in core; // false
```

The public session API is `JsonlSessionRepo` (re-exported from
`dist/harness/session/jsonl-repo.ts`):

```ts
new JsonlSessionRepo({ fs, sessionsRoot })
repo.create({ cwd, id?, parentSessionPath? }): Promise<Session<JsonlSessionMetadata>>
repo.open(metadata: JsonlSessionMetadata): Promise<Session<...>>
```

`repo.create` internally calls `JsonlSessionStorage.create(fs, filePath, ...)`
and computes the file path itself as
`<sessionsRoot>/<encodeCwd(cwd)>/<timestamp>_<id>.jsonl` — so sessions land
under `~/.novi/sessions/<encoded-cwd>/...jsonl` (a cwd-encoded subdir), not
directly `~/.novi/sessions/<id>.jsonl` as design literally drew. This still
satisfies the acceptance criterion ("`~/.novi/sessions/*.jsonl` 文件生成").

`repo.open(metadata)` reads only `metadata.path`; it calls
`JsonlSessionStorage.open(fs, metadata.path)`, which recovers full metadata from
the file header. So `--resume <path>` works by passing `{ path } as JsonlSessionMetadata`.

**Decision**: use `JsonlSessionRepo` + `toSession` (both public). `toSession` is
only needed internally by the repo; `repo.create/open` already return a `Session`
ready for the harness.

## Deviation 2 — `createModels()` returns an empty provider collection

`createModels()` from pi-ai returns a `MutableModels` with **no providers
registered**. provider env-key auto-reading (`envApiKeyAuth`) is wired into each
*provider factory* (e.g. `anthropicProvider()`), not into `createModels()`.
So calling `createModels()` alone yields no models and no auth.

The built-in collection is `builtinModels()` from
`@earendil-works/pi-ai/providers/all` (subpath export per `exports` map), which
calls `createModels()` and registers every built-in provider via
`models.setProvider(...)`. The anthropic provider reads
`ANTHROPIC_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` through `envApiKeyAuth` +
`defaultAuthContext` (which reads `process.env`).

**Decision**: use `builtinModels()` instead of `createModels()`. This matches
the design intent ("provider key 从环境变量经 pi-ai env-api-keys 自动读取") while
using the actual public API.

## Deviation 3 — `getEnvApiKey` / `findEnvKeys` not exported

`env-api-keys.ts` is not re-exported from pi-ai's main index. For the "clear
error when no provider key" requirement, use the public `models.getAuth(model)`
which resolves `undefined` when the provider is unconfigured (no network for
env-key providers). Throw a clear message in `bootstrap.ts`.

## Minor notes (no deviation)

- `AgentHarnessOptions.systemPrompt` accepts `string | (ctx) => string | Promise<string>`.
  The ctx provides `{ env, session, model, thinkingLevel, activeTools, resources }`
  — design's `({ env }) => resolveSystemPrompt(env)` is valid.
- `AgentEvent` union confirmed: `agent_start`, `agent_end` (messages),
  `turn_start`, `turn_end`, `message_start` (message), `message_update`
  (message, assistantMessageEvent), `message_end` (message).
  `assistantMessageEvent.type === "text_delta"` carries `.delta: string`. ✅
- `AgentHarness.prompt(text, { images? })`, `abort()`, `subscribe(listener)`
  returning an unsubscribe fn. ✅
- `NodeExecutionEnv({ cwd, shellEnv })` implements `FileSystem`; does **not**
  expand `~`. `config.ts` must expand home via `os.homedir()` itself.
- No `ink-text-input` in prd deps → build a minimal input with Ink `useInput`
  (accumulate chars, Backspace, Enter) instead of adding an unlisted dep.
