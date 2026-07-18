# Tool Runtime Contracts

> Executable contracts for descriptor registration, active-set assembly,
> scoped permission decisions, and native workspace boundaries.

## Scenario: Add or change a tool/security policy

### 1. Scope / Trigger

Use this spec whenever adding a tool, changing a descriptor, exposing a tool in
another runtime mode, editing `permissions` settings, changing tool-call hooks,
or touching native file I/O. The registry, gate, TUI, Headless JSON, Gateway,
and file tools share one security contract; tool-name switches must not define
policy independently.

### 2. Signatures

```ts
interface ToolDescriptor {
  name: string;
  label: string;
  source: { kind: "builtin" | "external"; id: string };
  capabilities: readonly ToolCapability[];
  risk: "read" | "write" | "execute" | "network";
  defaultPermission: "allow" | "ask" | "deny";
  defaultEnabled: boolean;
  streaming: "none" | "delta";
  modes: readonly ("tui" | "print" | "json" | "gateway")[];
  optional?: boolean;
  factory(context: ToolFactoryContext): AgentTool;
  resolvePermissionIntents(input: unknown): readonly ToolPermissionIntent[];
  resolvePermissionSubject?(input: unknown): {
    descriptor: Readonly<ToolDescriptor>;
    input: unknown;
    identity?: { sourceId: string; toolName: string; revision: string };
  };
}

function createBuiltinToolAssembly(
  env: ExecutionEnv,
  sessionId: string,
  options?: CreateBuiltinToolAssemblyOptions,
): ToolAssembly;

async function createToolAssembly(
  env: ExecutionEnv,
  sessionId: string,
  options?: CreateToolAssemblyOptions,
): Promise<ToolAssembly & { mcp?: McpRuntimeHandle }>;

class PermissionGate {
  onToolCall(event: ToolCallEvent): Promise<{ block: true; reason: string } | undefined>;
  setPermissions(next: ResolvedPermissions): void;
  setScopeGuard(next: WorkspaceScopeGuard): void;
  setResolveDescriptor(next: (name: string) => Readonly<ToolDescriptor> | undefined): void;
}
```

Every harness construction or rebuild must pass both `assembly.tools` and
`assembly.activeToolNames` to `setTools`. Builtin-only callers may keep using
the sync `createBuiltinToolAssembly`. Sessions that load MCP must use async
`createToolAssembly` (or equivalent merge helpers) so external descriptors share
the same registry, `ToolExecutionRuntime`, and `WorkspaceScopeGuard` as builtins.

### 3. Contracts

Settings schema:

```json
{
  "tools": {
    "enabled": { "grep": false },
    "sources": { "builtin": true },
    "mcpExposure": "auto",
    "mcpDirectSchemaBytes": 32768,
    "mcpPinned": ["mcp_github_get_issue"]
  },
  "permissions": {
    "rules": [
      {
        "source": "mcp:github",
        "capability": "shell.execute",
        "effect": "ask"
      },
      {
        "capability": "filesystem.read",
        "scope": "subtree",
        "target": "/absolute/tree",
        "effect": "deny"
      }
    ],
    "externalWriteAllowlist": ["/absolute/output-root"]
  }
}
```

- A rule requires `effect` and at least one of `tool`, `source`, or
  `capability`. Multiple selectors are ANDed; `source` is an exact descriptor
  source-id match such as `mcp:github`.
- `target` and `scope` must appear together. File targets are normalized
  against the startup workspace; domain targets are lowercase.
- Capability vocabulary includes builtin domains plus `state.tools` and
  `external.invoke`. `state.tools` reads the host-owned catalog without
  invoking a server; `external.invoke` is the
  conservative fallback for MCP/external tools without a tighter map.
  `WorkspaceScopeGuard.canonicalize` accepts `external.invoke` (session-scoped
  target) so PermissionGate can evaluate default-`ask` MCP tools instead of
  failing closed as `PERMISSION_INTENT_INVALID`.
- Global rules may allow/ask/deny. Project rules may only add ask/deny.
- `externalWriteAllowlist` is global-only; project values are ignored with a
  diagnostic.
- Decision precedence is deny, ask, allow, then descriptor default. Only
  whole rules (no target/scope) affect descriptor availability.
- MCP/external tools use `source.kind="external"`, `source.id="mcp:<server>"`,
  stable unique names (`mcp_<server>_<tool>`, collision suffix `_2`…),
  `defaultPermission="ask"`, and `optional=true`. Server connect failures are
  fail-soft (source unavailable diagnostics) and must not remove builtins.
- Session grants use capability + scope + canonical target. External grants
  additionally bind `{sourceId, toolName, revision}`. File grants also retain
  lexical/effective paths; subtree grants match descendants only when both
  paths and the optional external identity remain contained/equal.
- TUI rebuilds retain one in-memory store. Each Gateway chat gets a new store.
  No grants are persisted across processes.
- `bash` is an exact command grant and is not an OS/filesystem sandbox.

Cache-aware tool ordering:

- Builtin descriptors are sorted alphabetically by `name` at the assembly
  boundary (`index.ts`) before registration. External (MCP) descriptors are
  sorted alphabetically by `name` at the merge boundary (`assembly.ts`).
- Builtins always form a contiguous prefix; externals always form a
  contiguous suffix. The two groups never interleave.
- `ToolRegistry.build()` iterates in insertion order; the sort happens before
  insertion, not inside `build()`.
- Connecting/disconnecting an MCP server does not change builtin order in the
  assembled catalog or the model-visible tool list.
- `bootstrap.ts` sets `cacheRetention: "short"` in `streamOptions` so the
  provider applies prompt-cache breakpoints (including on the last tool
  definition for Anthropic-compatible providers via `cacheControlFormat`).

Native file boundary:

- A path is internal only when both its lexical absolute spelling and its
  effective canonical target are contained by the lexical/canonical workspace
  roots.
- Missing targets canonicalize the deepest existing ancestor, then append the
  missing suffix.
- External native reads/searches require approval. External writes/edits are
  denied unless both path views are covered by the workspace/global allowlist.
- The gate and native tool share one `WorkspaceScopeGuard`. Native tools
  re-resolve immediately before I/O; `edit_file` checks before its read and
  again before its write.

Hook denials use only the public reason string:

```text
NOVI_ERROR:<code>:<single-line bounded message>
```

`ToolEventDecoder` is the sole cross-surface decoder for these failures; it
maps the stable text into `ToolResultEnvelope.error`. Initial codes are
`PERMISSION_DENIED`,
`PERMISSION_INTERACTION_REQUIRED`, `WORKSPACE_EXTERNAL_WRITE_DENIED`,
`TOOL_DISABLED`, and `PERMISSION_INTENT_INVALID`.

### 4. Validation & Error Matrix

| Condition                                                               | Behavior / code                                        |
| ----------------------------------------------------------------------- | ------------------------------------------------------ |
| duplicate descriptor name, invalid metadata/schema, built-name mismatch | fail startup                                           |
| optional factory dependency/credential failure                          | mark `unavailable`; exclude active set; diagnostic     |
| source/tool/mode disabled                                               | exclude active set with stable availability reason     |
| whole permission deny                                                   | exclude active set; stale calls return `TOOL_DISABLED` |
| scoped deny match                                                       | keep tool active; call returns `PERMISSION_DENIED`     |
| unknown tool or undeclared/invalid intent                               | `PERMISSION_INTENT_INVALID`                            |
| non-interactive ask                                                     | `PERMISSION_INTERACTION_REQUIRED`                      |
| external native write outside global allowlist                          | `WORKSPACE_EXTERNAL_WRITE_DENIED`                      |
| valid project allow rule                                                | ignore with diagnostic; never broaden policy           |
| malformed/ambiguous permission rule                                     | add deny-all fail-closed rule + diagnostic             |
| symlink target changes after approval                                   | `PERMISSION_INTENT_INVALID` before I/O                 |
| builtin/external descriptor order not alphabetical                      | sort at assembly boundary; never interleave groups     |
| MCP server connect/disconnect changes builtin order                     | impossible by construction (separate sorted groups)    |
| malformed proxy subject or ref                                          | `PERMISSION_INTENT_INVALID`                            |
| valid ref no longer matches current MCP contract/projection             | retryable `MCP_TOOL_STALE`                             |

### 5. Good / Base / Bad Cases

- Good: a global subtree deny leaves `read_file` active but blocks only the
  matching canonical subtree; Headless emits `tool.end.result.error.code`.
- Base: workspace-internal `read_file`/`write_file` follow descriptor/rule
  policy and require no boundary exception.
- Bad: an internal lexical path traverses a symlink to an unlisted external
  write target; the gate and native tool both deny it.

### 6. Tests Required

- Registry: duplicate/metadata/schema/name validation, fail-soft optional
  tools, disabled/denied/unavailable/active states, runtime modes.
- Policy/gate: descriptor defaults, deny-after-grant, project tighten-only,
  unknown tool fail-closed, whole vs scoped deny, `--yes`, non-interactive code.
- Scope: lexical/effective containment, missing target under symlink parent,
  allowlisted external target, symlink redirection between approval and I/O.
- Grants: exact file, directory, domain, search, command; descendant subtree;
  changed target/command must not inherit authorization; external grants must
  not cross source/tool/revision and must be revoked on changed/removed tools.
- Cross-layer: TUI prompt fields, reload store identity/active set, Gateway
  store isolation, Headless/Gateway structured error projection.
- Cache-aware ordering: builtin descriptors alphabetical by name, external
  descriptors alphabetical by name, builtin prefix contiguous, external suffix
  contiguous, MCP connect/disconnect does not reshuffle builtins.
- Run `npm run typecheck`, `npm run lint`, `npm run test`, `npm run build`, and
  `git diff --check`.

### 7. Wrong vs Correct

#### Wrong

```ts
if (sessionStore.has(toolName)) return undefined;
const level = settings.permissions?.tools?.[toolName] ?? "allow";
```

This lets an old grant bypass a new deny, grants every argument of a tool, and
implicitly allows unknown tools.

#### Correct

```ts
const intents = await canonicalize(descriptor.resolvePermissionIntents(input));
const decision = resolveCurrentRules(descriptor, intents);
if (decision.level === "deny") return block("PERMISSION_DENIED");
if (decision.level === "ask" && !store.has(minimalGrant(intents))) {
  return approveOrBlock(intents);
}
```

Current static deny/boundary checks always precede minimal-scope grants.

#### Wrong

```ts
// Hardcoded insertion order — not alphabetical, not cache-stable.
const descriptors = [readFile, writeFile, editFile, bash, ls, ...];
for (const d of descriptors) registry.add(d);
```

Tool list sent to the model changes unpredictably when new tools are added,
breaking prompt-cache prefix stability.

#### Correct

```ts
function sortByName<T extends { name: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
const sorted = sortByName(descriptors);
for (const d of sorted) registry.add(d);
```

## Scenario: Expose and authorize a large MCP tool catalog

### 1. Scope / Trigger

Use this contract when changing MCP tool discovery, provider-facing tool
schemas, `mcp_tool_search` / `mcp_tool_invoke`, exposure settings, proxy
authorization, live registry rebuilds, or catalog projections consumed by TUI,
Headless, Gateway, and child agents. The goal is same-turn discovery without
injecting every external schema into every model request.

### 2. Signatures

```ts
type McpExposureMode = "direct" | "auto" | "deferred";

interface McpToolSearchQuery {
  query: string;
  source?: string;
  capability?: ToolCapability;
  risk?: ToolRisk;
  limit?: number; // 1..5
}

interface McpToolSearchResponse {
  catalogRevision: string;
  results: McpToolSearchResult[];
  resultsTruncated: boolean;
}

interface McpToolRefPayload {
  v: 1;
  sourceId: `mcp:${string}`;
  protocolName: string;
  catalogRevision: string;
  toolRevision: string;
}

class SessionToolController {
  getAssembly(): ToolAssembly;
  getSnapshot(): ToolCatalogSnapshot;
  resolveDescriptor(name: string): Readonly<ToolDescriptor> | undefined;
  bindHarness(harness: AgentHarness, activeAllowlist?: readonly string[]): () => void;
  subscribe(listener: (snapshot: ToolCatalogSnapshot) => void): () => void;
  settled(): Promise<void>;
  close(): void;
}
```

### 3. Contracts

- `mcp_tool_search` and `mcp_tool_invoke` are fixed builtin-source descriptors.
  Search declares `state.tools`, defaults to allow, and never calls an MCP
  server. Invoke is only a transport: before whole-tool or intent evaluation,
  `PermissionGate` resolves it to the current real MCP descriptor, real input,
  and `{sourceId, protocolName, toolRevision}` identity.
- Every real MCP descriptor declares an `external.invoke` capability and intent,
  even when conservative filesystem/network/shell capabilities are inferred.
  A rule allowing only `filesystem.read` therefore cannot silently authorize an
  external call.
- Search normalization is Unicode NFKC + lowercase + letter/number tokens.
  Ranking is exact, name/title prefix, full name-token coverage, body-token
  coverage, then bounded edit distance. Ties sort by `sourceId` and protocol
  name. The index is immutable per committed projection revision.
- Search and invoke use the same visibility predicate: source-disabled,
  tool-disabled, whole-denied, and child-source-filtered entries cannot be
  searched or invoked through a hand-built ref.
- Search input ceilings are 2 KiB UTF-8 for query and 512 bytes for source.
  Results are at most 5; each schema preview is at most 6 KiB, title/description
  fields are at most 512 bytes, and the complete canonical response is at most
  44 KiB so the default 50 KiB runtime budget retains valid JSON. Truncation
  affects only the model preview; invocation validates against the complete
  host-owned schema.
- Tool refs use strict canonical `mcp:v1:<base64url-json>` encoding, are at most
  4 KiB, and are non-authoritative. Resolution must match the current source,
  protocol name, source catalog revision, tool revision, visibility, and input
  validator before a server call.
- `tools.mcpExposure` defaults to `auto`; `tools.mcpDirectSchemaBytes` defaults
  to 32 KiB. `auto` keeps all eligible tools direct only within the canonical
  provider-schema budget; otherwise only global pinned tools remain direct and
  proxies become active. `deferred` exposes no real schema; `direct` exposes all
  eligible real tools. Project settings may move only
  `direct -> auto -> deferred`, lower the byte budget, and never add pins.
- `SessionToolController` owns one live registry, stable descriptor resolver,
  cached search index, active names, grant revocation, harness bindings, and
  serializable snapshot. On a catalog diff it serially revokes changed/removed
  grants, swaps projection truth, calls `setTools`, then publishes the snapshot.
  A `setTools` failure marks `projectionHealth="degraded"`, keeps committed
  catalog truth, records a bounded diagnostic, and retries.
- Builtins/internal proxies remain one sorted contiguous prefix; real MCP
  descriptors remain a sorted suffix. `ToolEventDecoder.setCatalog()` affects
  future calls only; an in-flight call retains the descriptor captured at start.

### 4. Validation & Error Matrix

| Condition                                               | Behavior / code                                         |
| ------------------------------------------------------- | ------------------------------------------------------- |
| malformed, non-canonical, oversized, or unsupported ref | `PERMISSION_INTENT_INVALID`                             |
| removed/changed tool or mismatched source/tool revision | retryable `MCP_TOOL_STALE`; no server call              |
| ref resolves to a currently hidden tool                 | retryable `MCP_TOOL_STALE`; no server call              |
| proxy arguments fail current full input schema          | `MCP_INPUT_SCHEMA_INVALID`; no server call              |
| search query/source exceeds bound or contains controls  | `PERMISSION_INTENT_INVALID`                             |
| search schema/response exceeds preview ceiling          | visible truncation; valid bounded response              |
| project broadens mode/budget or supplies pins           | ignore value + diagnostic                               |
| real descriptor whole/source/capability deny            | deny before grants and execution                        |
| catalog changes a granted tool                          | revoke matching source/tool grant revision              |
| live harness `setTools` fails                           | committed catalog retained; projection degraded + retry |
| stale direct tool captured by an earlier turn           | `MCP_TOOL_STALE`; new contract is not executed          |

### 5. Good / Base / Bad Cases

- Good: a 10,000-tool catalog activates only the two compact proxies, exact
  search returns a bounded current ref/schema, and invoke authorizes the real
  source/tool before calling the server.
- Base: a small catalog below 32 KiB remains direct with the previous external
  naming, ordering, default-ask, and execution behavior.
- Bad: search filters a disabled tool but invoke accepts a manually assembled
  matching ref; or five schema previews exceed the runtime budget and leave the
  model an invalid half-JSON response.

### 6. Tests Required

- Tool-ref codec: canonical round trip, malformed/oversized/unknown version,
  forged revision, stale source/tool/schema, and no-call assertions.
- Search: normalization/ranking/tie golden tests, every filter, limit 1..5,
  input bounds, per-schema truncation, complete response byte ceiling, and
  deterministic output for the same revision.
- Exposure/settings: direct/auto/deferred, exact canonical byte accounting,
  pins, project tightening/provenance/diagnostics, disabled/whole-denied empty
  search, and 10,000-tool provider-schema bound.
- Permission: true proxy subject, unconditional `external.invoke`, source/tool/
  capability deny-first combinations, real approval source/input, revision-bound
  grants, and changed/removed revocation.
- Live integration: list-changed registry/active/resolver/snapshot atomicity,
  stale direct call, in-flight metadata capture, degraded/retry recovery, stable
  builtin prefix, TUI/Headless/Gateway updates, and child source/active allowlists.

### 7. Wrong vs Correct

#### Wrong

```ts
const entry = decodeRef(input.toolRef);
return manager.callTool(entry.serverName, entry.name, input.arguments);
```

This treats a model-provided ref as authority and bypasses current visibility,
schema, descriptor policy, and revision-bound grants.

#### Correct

```ts
resolvePermissionSubject: (input) => {
  const entry = resolveAndValidate(getSnapshot(), input.toolRef, input.arguments, isVisible);
  return {
    descriptor: entry.descriptor,
    input: input.arguments,
    identity: {
      sourceId: entry.sourceId,
      toolName: entry.protocolTool.name,
      revision: entry.toolRevision,
    },
  };
};
```

The ref selects a candidate only; current host truth and PermissionGate remain
the authority.

## Scenario: Maintain a dynamic MCP tool catalog

### 1. Scope / Trigger

Use this contract when changing MCP `tools/list`, server connection/reconnect,
tool schema validation, `notifications/tools/list_changed`, or any consumer that
needs live MCP tool metadata. The committed catalog snapshot is the only
dynamic MCP tool truth; consumers must not read dependency-owned list caches.

### 2. Signatures

```ts
interface McpServerCatalogSnapshot {
  serverName: string;
  sourceId: `mcp:${string}`;
  serverFingerprint: string;
  revision: string; // SHA-256 of canonical execution metadata
  health: "connected" | "degraded";
  tools: readonly McpCatalogToolEntry[];
  schemaBytes: number;
  committedAt: number;
  diagnostic?: string;
}

class McpClientManager {
  getCatalogSnapshot(): McpCatalogSnapshot;
  getCatalogSnapshot(serverName: string): McpServerCatalogSnapshot | undefined;
  resolveCatalogTool(sourceId: string, protocolName: string): McpCatalogToolEntry | undefined;
  subscribeCatalog(listener: (change: McpCatalogChange) => void): () => void;
  refresh(serverName: string, reason?: "connect" | "list_changed" | "reconnect"): Promise<void>;
}
```

### 3. Contracts

- Fetch every `tools/list` page through public `client.request(...,
ListToolsResultSchema)`. The SDK's automatic list-changed fetcher calls one
  `listTools()` page only, so Novi must not use it as the catalog owner.
- A refresh builds a temporary complete snapshot, sorts by protocol identity,
  validates unique/bounded names, compiles schemas, and commits once. Cursor
  order and page splits must not affect public names or revision.
- Fixed ceilings are 100 pages, 10,000 tools, 16 MiB canonical metadata, and
  512 UTF-8 bytes per tool name. A ceiling failure rejects the complete refresh;
  it never commits a truncated catalog.
- JSON Schema defaults to draft 2020-12 when `$schema` is absent. Explicit
  draft-07 uses a separate AJV dialect. Inject those AJV instances through the
  public `AjvJsonSchemaValidator`; the SDK default AJV accepts 2020-12 metadata
  but interprets `prefixItems/items` with draft-07 behavior.
- Validator providers are new per atomic snapshot. Reusing an AJV provider
  across snapshots can make a repeated `$id` return a validator compiled from
  the previous revision. Duplicate `$id` values inside one snapshot fail the
  refresh.
- Install `ToolListChangedNotificationSchema` manually only when the server
  declares `tools.listChanged: true`. Per server, use trailing debounce plus
  one serialized dirty loop; notifications during a refresh request at most
  one successor refresh.
- A failed refresh with a previous snapshot retains tools, validators, and
  revision, then marks health `degraded`. Initial failure remains unavailable.
  Reconnect uses a connection generation and aborts old refreshes so late work
  cannot overwrite or resurrect a closed catalog.
- Identical successful content keeps the revision and emits no content-change
  event. Recovery from degraded health may emit a health-only change with
  empty added/changed/removed lists.

### 4. Validation & Error Matrix

| Condition                                       | Behavior / code                                 |
| ----------------------------------------------- | ----------------------------------------------- |
| repeated cursor or duplicate protocol tool name | reject refresh / `MCP_CATALOG_REFRESH_FAILED`   |
| page, tool, metadata, or name ceiling exceeded  | reject refresh / `MCP_CATALOG_LIMIT`            |
| unsupported schema dialect or compile failure   | reject refresh / `MCP_CATALOG_REFRESH_FAILED`   |
| first catalog fetch fails                       | server `unavailable`; no partial snapshot       |
| later catalog fetch fails                       | keep LKG revision/tools; health `degraded`      |
| identical successful refresh                    | no content event; revision unchanged            |
| changed/added/removed tool contract             | atomic new revision + exact diff                |
| close/reconnect races with refresh              | generation mismatch/abort drops late result     |
| one server fails                                | other MCP servers and builtins remain available |

### 5. Good / Base / Bad Cases

- Good: a 3-page list is fully validated, sorted, compiled, and committed once;
  a later notification storm coalesces into one current refresh and at most one
  successor.
- Base: a one-page static server produces the same direct descriptors and call
  behavior as before catalog versioning.
- Bad: a consumer calls `client.listTools()` directly, commits each page, uses
  SDK output-validator cache as full-catalog state, or clears LKG after a
  transient list error.

### 6. Tests Required

- Page split/order invariance, cursor loop, duplicate names, every fixed
  ceiling, invalid schemas, explicit draft-07, default 2020-12, and repeated
  `$id` across atomic revisions.
- Exact added/changed/removed diff, identical no-op, LKG degraded/recovery,
  listChanged debounce/dirty-loop, listener isolation, and bounded diagnostics.
- Close during refresh, failed/successful reconnect, call abort/timeout, one
  failed server beside one healthy server, and empty-MCP assembly regression.
- Run MCP/assembly focused tests plus typecheck, lint, full test, and build.

### 7. Wrong vs Correct

#### Wrong

```ts
const listed = await client.listTools();
connection.tools = listed.tools; // first page + dependency-owned validator cache
```

#### Correct

```ts
const tools = await fetchEveryToolsListPage(client, limits, signal);
const next = buildMcpServerCatalogSnapshot(tools); // compile before commit
if (connection.generation === generation) commit(next);
```

## Scenario: Authenticate a remote HTTP MCP server

### 1. Scope / Trigger

Use this contract when changing HTTP MCP config, OAuth discovery/provider,
credential persistence, auth retries, loopback login, `/mcp` commands, or any
TUI/Headless/Gateway/child-agent projection of an auth failure. OAuth is a
transport identity boundary; it never replaces project MCP approval or the
normal `PermissionGate` for a discovered tool.

### 2. Signatures

```ts
interface McpOAuthConfig {
  grantType?: "authorization_code" | "client_credentials";
  clientId?: string;
  clientSecret?: string; // persisted config: exact ${ENV_VAR} only
  clientMetadataUrl?: string;
  scopes?: string[];
  tokenEndpointAuthMethod?: "client_secret_basic" | "client_secret_post" | "none";
}

interface McpHttpServerConfig {
  url: string;
  headers?: Record<string, string>;
  oauth?: false | McpOAuthConfig;
}

interface McpOAuthRuntimeController {
  status(serverName: string): Promise<McpOAuthPublicStatus>;
  login(serverName: string, options: McpOAuthLoginOptions): Promise<void>;
  logout(serverName: string): Promise<McpOAuthLogoutResult>;
  resetAuth(serverName: string): Promise<McpOAuthLogoutResult>;
}

async function runMcpCli(options: RunMcpCliOptions): Promise<void>;
```

Operator signatures are:

```text
novi mcp status [server] [--json]
novi mcp login|reauthorize <server> [--no-open]
novi mcp logout|reset-auth <server>
/mcp status|login|reauthorize|cancel|logout|reset-auth <server>
```

### 3. Contracts

- OAuth applies only to Streamable HTTP. `oauth: undefined` enables
  challenge-driven OAuth; `oauth: false` makes a Bearer challenge terminal.
  Static headers remain config-owned; runtime Bearer tokens are injected into
  a fresh transport snapshot and are never written back to config.
- `resolveMcpOAuthTarget` must resolve the current plan and environment before
  discovery, callback creation, browser launch, or store mutation. Unknown,
  invalid, stdio, pending, or denied entries fail first. A declaration binding
  contains origin, project root (for project entries), server name, and
  fingerprint; fingerprint changes never reuse authorization.
- Authorization code uses SDK `auth()` with PKCE S256, random state, one exact
  `127.0.0.1` random-port callback, and a stable fingerprint-derived callback
  path. Only TUI and standalone CLI call `login`; model calls, print/JSON,
  Gateway, and child agents only refresh existing tokens or execute configured
  `client_credentials`.
- SDK compatibility fallbacks are narrower than Novi's contract: PRM must be
  present with at least one authorization server, authorization-server metadata
  must be present, and interactive login must see advertised S256 support.
  Missing PRM or a missing `code_challenge_methods_supported` is a discovery
  failure, not a legacy fallback.
- Registration priority is pre-registered `clientId`, then HTTPS non-root
  `clientMetadataUrl` when CIMD is supported, then DCR. Supported client auth
  methods are basic, post, and public `none`. Device flow, pasted code, remote
  callback relay, JWT/private-key grants, and single-declaration multi-account
  state are unsupported.
- `McpOAuthStore` is a separate strict V1 user-local file. Directories/files
  are `0700/0600`; writes use same-directory temp + sync + rename. Corrupt or
  unknown versions fail closed without overwrite. Mutations require a
  per-binding lease; file publication additionally takes the global write lock
  in that order. Refresh/token exchange holds the binding lease, re-reads
  generation, and commits rotation atomically.
- Records retain the validated resource and issuer. Discovery cannot overwrite
  either for an existing binding; the operator must `reset-auth`. OAuth network
  requests are HTTPS-only, bounded, redirect-limited, DNS-pinned, and use the
  same public/private trust class as the MCP resource. The loopback callback is
  the only HTTP exception.
- A connect or tool operation may consume one Bearer challenge, perform at
  most one recovery, rebuild once, and retry the original operation once. 401
  may refresh/fetch a token. 403 only unions pending scopes and returns
  `MCP_AUTH_SCOPE_REQUIRED`; it never starts step-up authorization.
- `McpRuntimeHandle.oauth` is the surface boundary. `McpOAuthPublicStatus`
  contains only state, grant/registration mode, issuer origin, resource path,
  scopes, generation, and optional expiry. TUI must not read manager/store
  records or token fields.
- Logout best-effort revokes refresh then access token when metadata advertises
  a revocation endpoint, then always clears local tokens/timestamps/pending
  scopes while retaining discovery/client information. `reset-auth` also
  deletes discovery, issuer/resource, and stored registration. Revocation
  failure returns a warning outcome, never token/raw response text.
- `connectMcp: false` may resolve config/plan diagnostics and construct an idle
  manager, but it must not inspect the OAuth store, perform DNS/network I/O,
  refresh, create a listener, or open a browser.

### 4. Validation & Error Matrix

| Condition                                               | Stable behavior / code                           |
| ------------------------------------------------------- | ------------------------------------------------ |
| plaintext secret, invalid grant/method/scope/CIMD URL   | invalid plan before network                      |
| OAuth disabled + Bearer challenge                       | `MCP_AUTH_DISABLED`                              |
| authorization-code token absent/refresh invalid         | `MCP_AUTH_REQUIRED` + standalone CLI guidance    |
| 403 insufficient scope                                  | `MCP_AUTH_SCOPE_REQUIRED`; pending union only    |
| concurrent login for one binding                        | `MCP_AUTH_IN_PROGRESS`                           |
| corrupt/version-mismatched store                        | `MCP_AUTH_STORE_INVALID`; preserve file          |
| unsafe URL, redirect, DNS class, issuer/resource change | `MCP_AUTH_ENDPOINT_UNSAFE`                       |
| discovery/metadata failure                              | `MCP_AUTH_DISCOVERY_FAILED`                      |
| no usable pre-register/CIMD/DCR mode                    | `MCP_AUTH_REGISTRATION_UNAVAILABLE`              |
| bad state/path/code or duplicate callback               | `MCP_AUTH_CALLBACK_INVALID`                      |
| five-minute callback deadline                           | `MCP_AUTH_TIMEOUT`                               |
| operator cancellation/SIGINT                            | `MCP_AUTH_CANCELLED`                             |
| revocation endpoint fails                               | local success + `revocationFailed: true` warning |

Every `MCP_AUTH_*` failure is terminal/non-retryable for the current model
operation. SDK/raw OAuth response bodies are classified into fixed public
messages; do not concatenate dependency error text into events or diagnostics.

### 5. Good / Base / Bad Cases

- Good: an approved project HTTP server returns Bearer 401; an existing refresh
  token rotates under the binding lease, the transport rebuilds once, and the
  original connect succeeds without browser activity.
- Base: an anonymous HTTP or static-header server connects successfully and no
  discovery or interactive side effect occurs; stdio credential behavior is
  unchanged.
- Bad: Gateway receives 401 and opens a callback; two processes overwrite a
  rotated refresh token; a changed fingerprint reuses old tokens; or TUI
  prints a raw store record containing `access_token`.

### 6. Tests Required

- Config: default/false/grants, clientId/CIMD/DCR combinations, three client
  auth methods, exact secret placeholders, fingerprint/redaction, stdio/header
  regressions, and approval-before-side-effect assertions.
- Protocol: WWW-Authenticate and well-known discovery, RFC 8414/OIDC metadata,
  issuer/resource mismatch, unsafe endpoint/redirect/DNS, bounded response,
  PKCE/state/resource parameters, pre-register/CIMD/DCR, refresh rotation, and
  registration failure mapping.
- Callback: exact 127.0.0.1/path/state/code, random port, success, mismatch,
  duplicate, timeout, cancellation, cleanup, browser failure, and `--no-open`.
  PKCE verifier assertions must accept the RFC unreserved character set
  `[A-Za-z0-9._~-]`; a verifier is not necessarily base64url, even though the
  S256 challenge is.
- Store/locks: modes, atomic V1, corrupt preservation, same-binding
  serialization/generation re-read, different-binding merge, active-owner wait,
  conservative stale recovery, and no secret in public errors.
- Manager/surfaces: one recovery + one original retry, exhausted budget, 403
  pending scope, public status only, logout/reset/revocation outcomes, TUI/CLI
  commands, and zero browser/listener side effects in Headless/Gateway/child.
- Regression and gates: MCP/assembly/permission/events/TUI/CLI/Headless/Gateway/
  child tests, typecheck, lint, full test, build, and `git diff --check`.

### 7. Wrong vs Correct

#### Wrong

```ts
if (response.status === 401) {
  openBrowser(await discover(response));
  return callToolAgain(); // unbounded and model-triggered interaction
}
```

#### Correct

```ts
const challenge = recorder.take();
await coordinator.recover(target, challenge, observedGeneration);
await reconnect(serverName);
return invokeOnce(reconnected); // one recovery budget, no interactive login
```

Interactive authorization is an explicit operator command; passive recovery
cannot expand scope or create a callback.

## Scenario: Preserve the MCP tool-result lifecycle

### 1. Scope / Trigger

Use this contract when changing MCP `tools/call`, result content mapping,
progress/cancellation, binary artifact storage, stable tool errors, or any
TUI/Headless/Gateway/replay projection of an MCP call. Raw MCP result objects
must stop at `src/mcp/result-mapper.ts`; consumers use the normal Novi runtime
and event contracts.

### 2. Signatures

```ts
interface McpCallToolOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  onProgress?: (progress: Progress) => void;
}

function executeMappedMcpTool(
  options: ExecuteMappedMcpToolOptions,
): Promise<AgentToolResult<Record<string, unknown>>>;

function mapMcpToolResult(
  options: MapMcpToolResultOptions,
): Promise<AgentToolResult<Record<string, unknown>>>;

class McpProgressReporter {
  update(progress: Progress): void;
  finish(): void;
  getDiagnostics(): readonly string[];
}

class ArtifactStore {
  persistBinary(
    toolCallId: string,
    tool: string,
    index: number,
    bytes: Uint8Array,
    mimeType: string,
  ): Promise<{ path: string; metadata: ArtifactMetadata } | undefined>;
}
```

### 3. Contracts

- `McpClientManager.callTool` passes the runtime signal and fixed timeout to
  the SDK with `resetTimeoutOnProgress: false` and
  `maxTotalTimeout: timeout`. Progress cannot extend the total call deadline.
- `executeMappedMcpTool` is the shared direct/proxy path. It closes progress
  immediately at result/error, checks abort before mapping, and produces one
  terminal `AgentToolResult` through `mapMcpToolResult`.
- Text blocks remain text, supported bounded images remain native image
  content, resource links preserve bounded name/URI/MIME/annotations without
  fetching, and embedded text resources include their URI/MIME header.
- The current committed catalog entry owns input and output validators. When
  `outputSchema` exists, a non-error result must contain valid
  `structuredContent`. Canonical key-sorted JSON is model-facing once; if an
  identical text block already exists it is not duplicated. Envelope data
  keeps either the bounded structure or a `{ truncated, bytes, reason }`
  summary, never the raw MCP content array.
- Image/audio/blob base64 is strictly decoded under `memoryBytes`. Audio,
  embedded blobs, and non-native/oversized images use `persistBinary`; quota,
  active-writer, mode (`0700` directory / `0600` file), cleanup, and disabled
  behavior remain owned by `ArtifactStore`. Base64 never enters public
  details/events. Disabled or invalid binary content yields an explicit
  bounded degradation.
- Progress accepts only finite, strictly increasing `progress`; invalid totals
  are omitted and diagnosed. Messages are sanitized, bounded, rate-limited,
  and emitted as true deltas with continuous runtime sequences. Pending
  rate-limited progress is dropped at the terminal boundary so it cannot delay
  completion; late progress and duplicate terminal events are ignored.
- MCP metadata is bounded under `envelope.data.mcp`; binary paths appear in
  normal `envelope.artifacts` as `document`. TUI, print/JSON, Gateway, and
  persisted replay use `ToolResultEnvelope`/`NoviToolEvent` unchanged. No MCP
  event variant is permitted.
- Client initialization capabilities remain `{}`. Resources/Prompts,
  Sampling, Elicitation, and Tasks are not advertised. OAuth is transport
  authentication and does not add a server-initiated MCP capability.

### 4. Validation & Error Matrix

| Condition                                    | Stable behavior / code                              | Retryable            |
| -------------------------------------------- | --------------------------------------------------- | -------------------- |
| MCP result has `isError: true`               | `MCP_TOOL_ERROR` with bounded/redacted text         | no                   |
| current input validator rejects arguments    | `MCP_INPUT_SCHEMA_INVALID`                          | no, change input     |
| required structured output is absent/invalid | `MCP_OUTPUT_SCHEMA_INVALID`                         | no                   |
| malformed JSON-RPC/result envelope           | `MCP_PROTOCOL_ERROR`                                | no                   |
| disconnect/send/connection failure           | `MCP_TRANSPORT_ERROR`                               | yes                  |
| catalog/tool revision changed                | `MCP_TOOL_STALE`; search again                      | yes                  |
| SDK/runtime deadline expires                 | `TOOL_TIMEOUT`                                      | yes                  |
| caller abort wins the race                   | `TOOL_ABORTED`, cancelled envelope                  | no                   |
| invalid MIME/base64 or binary over memory    | successful explicit degradation, no payload         | no                   |
| binary artifact disabled                     | successful explicit degradation, no path            | no                   |
| binary quota/write failure                   | `ARTIFACT_QUOTA_EXCEEDED` / `ARTIFACT_WRITE_FAILED` | quota no / write yes |
| regressive/invalid/late progress             | drop and add bounded diagnostic                     | n/a                  |

### 5. Good / Base / Bad Cases

- Good: a tool returns text, a small PNG, structured output, a resource link,
  and audio. The model receives bounded native text/image plus canonical JSON;
  audio becomes one private artifact; every surface sees the same JSON-safe
  final envelope without base64.
- Base: a one-line text result produces the same success envelope as a builtin
  non-streaming tool, with MCP source/tool/revision only in bounded data.
- Bad: an adapter copies `result.content` into details, trusts the SDK's
  dependency-owned output-validator cache, resets timeouts on progress,
  publishes base64, fetches a resource link implicitly, or defines an
  `mcp.tool.end` event.

### 6. Tests Required

- Golden mapper tests: multiple text, native image, structured de-duplication,
  resource link, embedded text, audio, and embedded blob; assert model content,
  `data.mcp`, artifacts, and absence of base64.
- Validation/error tests: missing/invalid output schema, tool error,
  protocol/transport/stale/timeout/abort codes, redaction, and retryability.
- Binary tests: invalid MIME/base64, memory overflow, disabled store,
  session/global quota, write failure, file/directory modes, active
  reservations, age cleanup, output-file symlink non-following.
- Progress/race tests: continuous sequences, non-cumulative deltas,
  rate/size bounds, regressive/invalid totals, progress that does not extend
  SDK timeout, late update, and duplicate terminal drop.
- Surface tests: direct and deferred invoke, TUI reducer, Headless JSON,
  Gateway callback, and persisted replay reuse an equivalent envelope.
- Run MCP/runtime/event/surface focused tests plus typecheck, lint, full test,
  build, and `git diff --check`.

### 7. Wrong vs Correct

#### Wrong

```ts
const result = await client.callTool(params, undefined, {
  signal,
  resetTimeoutOnProgress: true,
});
return { content: [{ type: "text", text: preview(result) }], details: result };
```

#### Correct

```ts
return executeMappedMcpTool({
  manager,
  entry: currentCatalogEntry,
  toolCallId,
  publicToolName,
  arguments: input,
  runtime,
  signal,
  onUpdate,
});
```

## Scenario: Govern tool resources and overflow

### 1. Scope / Trigger

Use this contract when changing tool execution, output streaming, traversal,
artifact persistence, cache retention, tool settings, CLI parsing, or any
harness construction/rebuild path. Domain tools must not invent independent
timeouts, cumulative partial snapshots, or unbounded result details.

### 2. Signatures

```ts
interface ToolExecutionBudget {
  modelBytes: number; // default 50 KiB
  modelLines: number; // default 2,000
  memoryBytes: number; // default 256 KiB
  partialBytes: number; // default 16 KiB
  partialUpdatesPerSecond: number; // default 10
  timeoutMs: number; // default 120,000
  maxConcurrentCalls: number; // default 4 per session runtime
  traversalFiles: number; // default 50,000
  traversalDepth: number; // default 64
  resultCount: number; // default 10,000
  artifactSessionBytes: number; // default 256 MiB
  artifactGlobalBytes: number; // default 1 GiB
  artifactMaxAgeMs: number; // default 7 days
  webCacheBytes: number; // default 512 MiB
  webCacheMaxAgeMs: number; // default 30 days
}

function parseToolBudgetOverrides(values: readonly string[]): ToolBudgetOverrides;
function resolveToolExecutionBudget(
  layers: SettingsLayers,
  cli?: ToolBudgetOverrides,
): ResolvedToolExecutionBudget;

class ToolExecutionRuntime {
  wrap(tool: AgentTool): AgentTool;
  createCapture(callId: string, tool: string, direction?: "head" | "tail"): BoundedTextCapture;
  readonly readCache: ReadResultCache;
}

class ReadResultCache {
  get(
    key: { absPath: string; offset: number; limit: number | undefined },
    stat: { mtimeMs: number; size: number },
  ): { mtimeMs: number; size: number } | undefined;
  set(
    key: { absPath: string; offset: number; limit: number | undefined },
    stat: { mtimeMs: number; size: number },
  ): void;
  invalidateByPath(absPath: string): void;
  clear(): void;
}
```

CLI values are repeatable: `--tool-budget <field>=<positive-safe-integer>`.

### 3. Contracts

- Resolution order is defaults, global (loosen/tighten), trusted project
  (tighten only), CLI (explicit loosen/tighten). Unknown/invalid settings add
  diagnostics; unknown/invalid/conflicting CLI values fail startup.
- `artifacts.enabled` defaults true. Global may choose either value; project
  may only set false. The resolved values and provenance appear in settings.
- `GatewayEnv` and `BootstrapResult` carry one resolved budget. Fresh, resume,
  print/JSON, Gateway, `/new`, and `/reload` pass it to the same assembly path;
  reload re-resolves with the original CLI overrides.
- `ToolExecutionRuntime` owns the per-session semaphore, hard timeout, final
  bounding, details bounding, artifact store, and stable runtime error prefix.
- Streaming tools emit true text deltas with monotonically increasing
  `details.sequence`; each delta is at most `partialBytes`, pending delta memory
  is bounded, and delivery is at most `partialUpdatesPerSecond`.
- Internal captures first produce resource metrics. The runtime then replaces
  final public details with `{ envelope: ToolResultEnvelope }`; domain details
  move into bounded `envelope.data`, and resource metrics move into
  `metrics`/`truncation`/`artifacts`. Complete stdout/stderr/content must not be
  duplicated in details or errors.
- Overflow persistence is incremental under
  `~/.novi/artifacts/<session>/<call>/{output.log,metadata.json}`. Directories
  are `0700`; files are `0600`. Active temp files are never cleanup candidates.
  Age/session/global quotas include concurrent active writers; oldest completed
  artifacts are removed first. Permission denials occur before `execute` and
  therefore never enter the artifact pipeline.
- `bash` uses direct child-process pipes because `ExecutionEnv.exec` retains
  complete stdout/stderr internally. It intentionally remains an unsandboxed
  shell with normal OS filesystem reach. Its input timeout may only tighten the
  resolved timeout.
- `read_file`, `glob`, and `grep` stream through captures. Traversal skips
  symlinks and heavy directories, reads root `.gitignore`, sorts entries, checks
  AbortSignal between operations, and reports file/depth/result termination.
  Grep prefers direct-argv Ripgrep batches over the already bounded file set;
  when `rg` is unavailable it uses the same streaming Node scanner and limits.
- Web TTL controls freshness; retention independently limits cache bytes/age.
  Cleanup is opportunistic single-flight and never follows symlinks.
- `ToolExecutionRuntime.readCache` is a per-session, in-memory
  `ReadResultCache` that deduplicates repeated `read_file` calls. Key:
  `(absPath, offset, limit)`. Value: stat snapshot `{ mtimeMs, size }` only
  — no file content is stored. On a cache hit (stat matches), `read_file`
  returns a hint text without opening a file stream. `edit_file` and
  `write_file` call `invalidateByPath(abs)` after a successful write.
  `session_before_compact` hook clears the entire cache so the model can
  re-read files whose previous tool results were summarized away.

### 4. Validation & Error Matrix

| Condition                                                    | Behavior / code                                                     |
| ------------------------------------------------------------ | ------------------------------------------------------------------- |
| unknown/malformed/conflicting CLI budget                     | fatal CLI argument error                                            |
| invalid global/project budget                                | ignore value + startup diagnostic                                   |
| project raises a ceiling or enables artifacts                | ignore + diagnostic                                                 |
| model byte/line, traversal, result, delta backpressure limit | successful bounded result + structured truncation                   |
| tool exceeds `timeoutMs` (including concurrency wait)        | `NOVI_ERROR:TOOL_TIMEOUT`                                           |
| caller abort                                                 | `NOVI_ERROR:TOOL_ABORTED`                                           |
| edit input/result exceeds hard memory ceiling                | `NOVI_ERROR:TOOL_MEMORY_LIMIT`                                      |
| enabled overflow cannot fit artifact quotas                  | `NOVI_ERROR:ARTIFACT_QUOTA_EXCEEDED`                                |
| enabled overflow cannot be written/finalized                 | `NOVI_ERROR:ARTIFACT_WRITE_FAILED`                                  |
| Bash non-zero exit                                           | `NOVI_ERROR:TOOL_EXIT_NONZERO` with bounded tail only               |
| other thrown tool failure                                    | `NOVI_ERROR:TOOL_EXECUTION_FAILED` with bounded single-line message |
| artifacts explicitly disabled                                | successful truncation without artifact path                         |
| `read_file` cache hit (stat matches)                         | hint text returned, no file stream opened, `details.cache: "hit"`   |
| `read_file` cache miss (no entry or stat mismatch)           | normal streaming read, stat stored, `details.cache: "miss"`         |
| `edit_file`/`write_file` modifies a file                     | `readCache.invalidateByPath(abs)` clears all entries for that path  |
| compaction fires (`session_before_compact`)                  | `readCache.clear()` resets all entries                              |

### 5. Good / Base / Bad Cases

- Good: a 2 MiB Bash result keeps only bounded capture/delta state, streams a
  private exact artifact, and returns metrics plus a <= model-budget preview.
- Base: a small read/search returns normal text with `truncated: false` and no
  artifact file.
- Bad: a tool sends cumulative stdout on every update, includes full output in
  `details`, recursively collects an entire tree, or lets a project raise a
  global/default ceiling.

### 6. Tests Required

- Resolver: every precedence layer, project tightening, artifact enable policy,
  invalid settings diagnostics, strict repeatable CLI parsing, provenance.
- Runtime: UTF-8 byte/line bounds, timeout, concurrency semaphore, oversized
  details, ordered/rate-limited/delta-sized updates, final flush.
- Bash/read: multi-megabyte output, exact artifact, non-zero bounded error,
  hard timeout, no stdout/stderr details, streamed large file.
- Artifact: file modes, disabled mode, session/global quota, oldest eviction,
  concurrent active reservations, age cleanup, write/quota codes.
- Traversal: deterministic file/depth/result stop, default and `.gitignore`,
  symlink non-following, abort, bounded structured matches.
- Cache: TTL, age and size retention, corrupt files, concurrent cleanup,
  active read safety, symlink non-following, no credential persistence.
- Read dedup cache: hit/miss on stat match, stale entry deletion, batch
  invalidation by path after edit/write, clear on compaction, independent
  offset/limit entries, no file content stored.
- Cross-mode: fresh/resume/rebuild/Gateway receive the same resolved values.

### 7. Wrong vs Correct

#### Wrong

```ts
stdout += chunk;
onUpdate({ content: [{ type: "text", text: stdout }], details: { stdout } });
const files = await recursiveCollectEverything(root);
```

#### Correct

```ts
await capture.append(chunk); // bounded tail + incremental artifact
deltas.push(chunk, "stdout"); // bounded true delta + sequence
await visitFiles(env, root, budget, onFile, signal); // deterministic early stop
```

## Scenario: Emit and consume unified tool events

### 1. Scope / Trigger

Use this contract when changing tool execution results, harness tool events,
Headless JSONL, Gateway tool callbacks, TUI tool state, or persisted tool
replay. `src/tools/events.ts` is the contract owner; consumers must not parse
dependency-owned tool payloads independently.

### 2. Signatures

```ts
interface ToolResultEnvelope {
  version: 1;
  status: "success" | "error" | "cancelled";
  data?: JsonValue;
  preview: string;
  error?: { code: string; message: string; retryable: boolean };
  metrics: {
    startedAt: number;
    durationMs: number;
    inputItems?: number;
    outputBytes: number;
    outputLines: number;
  };
  truncation: {
    truncated: boolean;
    reasons: string[];
    shownBytes: number;
    shownLines: number;
  };
  artifacts: Array<{
    kind: "full-output" | "document";
    path: string;
    bytes: number;
  }>;
}

type NoviToolEvent =
  | { type: "tool.start"; toolCallId: string; tool: ToolRef; input: JsonValue; at: number }
  | { type: "tool.delta"; toolCallId: string; sequence: number; delta: string; at: number }
  | { type: "tool.end"; toolCallId: string; result: ToolResultEnvelope; at: number };

class ToolEventDecoder {
  decode(event: AgentHarnessEvent, at?: number): NoviToolEvent | undefined;
}

function reduceToolCallState(calls: ToolCallView[], event: NoviToolEvent): ToolCallView[];
```

### 3. Contracts

- Runtime partial updates always carry a positive monotonic `details.sequence`.
  `tool.delta` contains a bounded true delta, never a cumulative snapshot.
- Successful wrapped tools persist exactly one validated final envelope at
  `result.details.envelope`. Error results thrown by tools are reconstructed
  from bounded `NOVI_ERROR:<code>:<message>` content.
- The decoder reuses a valid persisted envelope verbatim. A malformed or
  missing envelope is rebuilt from bounded content/details; a malformed result
  shape fails closed with `TOOL_RESULT_INVALID`.
- `assertJsonSafe` rejects functions, symbols, non-finite numbers, cycles,
  excessive depth/size, and secret-bearing public fields. Decoder inputs are
  bounded and omit Authorization/API-key/token/password/cookie/environment/
  stack fields.
- Headless suppresses hook-level `tool_call`/`tool_result` duplicates and emits
  only `tool.start`, `tool.delta`, and `tool.end`. This is a breaking protocol;
  no legacy field aliases or dual writes exist.
- TUI live state and persisted resume both use the shared reducer/envelope.
  Gateway forwards the same `NoviToolEvent`; channel rendering may ignore
  deltas but may not define another payload decoder.
- `edit_file` accepts only `{ path, edits: [{ oldText, newText }] }`. TUI diff
  summaries aggregate every canonical edit; top-level legacy replacements and
  JSON-string `edits` are invalid.

### 4. Validation & Error Matrix

| Condition                       | Result                                                       |
| ------------------------------- | ------------------------------------------------------------ |
| ordered delta                   | append and advance `lastSequence`                            |
| duplicate or out-of-order delta | do not append; add reducer diagnostic                        |
| sequence gap                    | append newest delta; record missing range diagnostic         |
| update/end before start         | create a minimal unknown-tool view; do not drop              |
| valid persisted envelope        | reuse it exactly                                             |
| malformed final result          | error envelope with `TOOL_RESULT_INVALID`                    |
| `TOOL_ABORTED` stable error     | `status: "cancelled"`                                        |
| other stable/generic failure    | `status: "error"` with machine-readable error                |
| output exceeds model budget     | bounded preview + truncation + optional artifact             |
| secret/cyclic/unsupported input | redact or bounded placeholder; emitted event stays JSON-safe |

### 5. Good / Base / Bad Cases

- Good: `tool.start` → sequences 1 and 2 → `tool.end`; replay reconstructs
  the same single row and exact persisted envelope.
- Base: a small non-streaming tool emits start/end with no artifact and
  `truncated: false`.
- Bad: Headless emits raw `tool_execution_end`, a component casts
  `partialResult`, Gateway converts errors separately, or runtime preserves a
  second full output copy next to the envelope.

### 6. Tests Required

- Decoder/reducer: ordered reconstruction, duplicate/gap/out-of-order,
  end-before-start, unknown tool fallback.
- Envelope: success/error/cancelled, retryability, malformed result,
  truncation/artifacts, strict JSON safety, secret exclusion.
- Runtime: every partial has monotonic sequence; successful final details own
  one valid envelope.
- Headless: exact breaking schema, `toolCallId` on every event, no legacy
  fields or hook duplicates.
- TUI: live/persisted deduplication, exact envelope resume, single/multi-edit
  summary and detail hunks.
- Gateway: same decoded event union without changing final assistant delivery.

### 7. Wrong vs Correct

#### Wrong

```ts
case "tool_execution_end":
  callbacks.onToolCall(event.toolName, event.isError ? "error" : "done");
```

#### Correct

```ts
const toolEvent = decoder.decode(event);
if (toolEvent) {
  state = reduceToolCallState(state, toolEvent);
  callbacks.onToolEvent?.(toolEvent);
}
```
