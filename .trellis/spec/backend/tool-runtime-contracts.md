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
    "sources": { "builtin": true }
  },
  "permissions": {
    "rules": [
      {
        "tool": "bash",
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

- A rule requires `effect` and at least one of `tool` or `capability`.
- `target` and `scope` must appear together. File targets are normalized
  against the startup workspace; domain targets are lowercase.
- Capability vocabulary includes builtin domains plus `external.invoke`, the
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
- Session grants use capability + scope + canonical target. File grants also
  retain lexical/effective paths; subtree grants match descendants only when
  both paths remain contained.
- TUI rebuilds retain one in-memory store. Each Gateway chat gets a new store.
  No grants are persisted across processes.
- `bash` is an exact command grant and is not an OS/filesystem sandbox.

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
  changed target/command must not inherit authorization.
- Cross-layer: TUI prompt fields, reload store identity/active set, Gateway
  store isolation, Headless/Gateway structured error projection.
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
