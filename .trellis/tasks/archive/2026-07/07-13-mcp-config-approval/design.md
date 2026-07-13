# Design: MCP config and approval store

## Boundary

Own pure config/approval domain modules under `src/mcp/`.

No process spawn, no HTTP connect, no ToolRegistry changes.

## Files

- `src/mcp/types.ts` — server config, plan, approval types
- `src/mcp/config.ts` — load/validate/merge
- `src/mcp/approval.ts` — store path, load/save, fingerprint match
- `src/mcp/plan.ts` — resolve connectable/pending/denied/invalid plan
- `src/mcp/index.ts` — public exports
- tests under `src/mcp/*.test.ts`

## Config paths

- User: `path.join(getNoviDir(), "mcp.json")` → `~/.novi/mcp.json`
- Project primary: `path.join(cwd, ".mcp.json")`
- Project secondary: `path.join(cwd, ".novi", "mcp.json")`
  - If both exist: primary wins; secondary ignored with diagnostic.

## Schema

```ts
type McpStdioServerConfig = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
};

type McpHttpServerConfig = {
  url: string;
  headers?: Record<string, string>;
};

type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;

interface McpConfigFile {
  mcpServers?: Record<string, McpServerConfig>;
}
```

Validation:

- name: non-empty, recommend `[A-Za-z0-9_-]+`; invalid names → invalid entry diagnostic
- stdio requires `command` string; rejects simultaneous `url`
- http requires absolute `http(s)://` url; rejects `command`
- args must be string[]; env/headers values must be strings
- unknown keys preserved only if harmless, or ignored with diagnostic (prefer strict known fields)

## Merge

```ts
interface ResolvedMcpServerDeclaration {
  name: string;
  origin: "user" | "project";
  config: McpServerConfig;
  fingerprint: string;
  diagnostics: string[];
}
```

- Start from user servers.
- Project servers overlay by name.
- Overlay records `origin: "project"` even if name existed in user (project wins declaration).
- Keep both origins discoverable in diagnostics when overlay happens.

## Fingerprint

Canonical JSON of:

```ts
{
  name,
  kind: "stdio" | "http",
  command?, args?, cwd?, // stdio
  url?, headerKeys?,     // http: header keys sorted; values excluded from fingerprint? 
}
```

Security note:

- Include header **keys** and whether Authorization present, but hash secret values so approval binds to auth shape without storing secrets in approval file plaintext beyond what's needed.
- Safer approach: fingerprint includes normalized header key set + value hashes (sha256), not raw secrets.

Stdio fingerprint includes command/args/cwd/env key set + env value hashes.

## Approval store

Path: `~/.novi/mcp-approvals.json`

```ts
interface McpApprovalFile {
  entries: Array<{
    serverName: string;
    fingerprint: string;
    decision: "approved" | "denied";
    origin: "user" | "project";
    projectRoot?: string; // absolute normalized, for project entries
    updatedAt: string; // ISO
  }>;
}
```

Lookup key: `(projectRoot|global) + serverName + fingerprint`.

User servers:

- No approval required for connection; plan marks `approval: "not_required"`.

Project servers:

- no entry → pending
- approved + matching fingerprint → connectable
- denied → denied
- entry fingerprint mismatch → pending (stale)

API:

```ts
loadMcpDeclarations(env, cwd): Promise<{ servers: ResolvedMcpServerDeclaration[]; diagnostics: string[] }>
loadMcpApprovals(env): Promise<McpApprovalFile>
setMcpApproval(env, input): Promise<void>
resolveMcpPlan(env, cwd): Promise<McpPlan>
```

```ts
type McpPlanEntryStatus = "connectable" | "pending" | "denied" | "invalid";

interface McpPlanEntry {
  name: string;
  origin: "user" | "project";
  status: McpPlanEntryStatus;
  config?: McpServerConfig;
  fingerprint: string;
  reason?: string;
}

interface McpPlan {
  entries: McpPlanEntry[];
  diagnostics: string[];
}
```

## Env placeholders

- Syntax: `${VAR}` only (no defaults in v1)
- Resolution function pure: `(value, envMap) => { ok, value, missing[] }`
- Plan may keep unresolved config; mark invalid/unavailable later if required vars missing at connect time.
- This child provides resolver utility; connect-time enforcement owned by child 2.

## Error handling

- Missing files → empty
- Corrupt JSON → empty layer + diagnostic
- Never throw for ordinary load paths; write approval may throw/return error for IO hard failures (mirror trust.ts style: prefer non-fatal where possible)

## Tests

- load user/project/both/none
- primary vs secondary project path
- invalid transport combinations
- merge overlay
- fingerprint stability + sensitivity to command/url/args
- approval pending/approved/denied/stale
- env placeholder missing/found
