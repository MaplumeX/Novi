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

class PermissionGate {
  onToolCall(event: ToolCallEvent): Promise<{ block: true; reason: string } | undefined>;
  setPermissions(next: ResolvedPermissions): void;
  setScopeGuard(next: WorkspaceScopeGuard): void;
}
```

Every harness construction or rebuild calls the same assembly function and
passes both `assembly.tools` and `assembly.activeToolNames` to `setTools`.

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
- Global rules may allow/ask/deny. Project rules may only add ask/deny.
- `externalWriteAllowlist` is global-only; project values are ignored with a
  diagnostic.
- Decision precedence is deny, ask, allow, then descriptor default. Only
  whole rules (no target/scope) affect descriptor availability.
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

`findPermissionError()` is the sole shared decoder for Headless/Gateway
projections. Initial codes: `PERMISSION_DENIED`,
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
  matching canonical subtree; Headless emits `errorCode`.
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
