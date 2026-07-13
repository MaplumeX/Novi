# Design: Enable external tool sources (MCP)

## Architecture

```
~/.novi/mcp.json          .mcp.json (project)
        \                    /
         v                  v
      McpConfigLoader  +  McpApprovalStore
                 \
                  v
           ResolvedMcpPlan
           (approved/pending/denied)
                  |
                  v
        McpSourceManager.connect()
        - stdio transport
        - streamable HTTP transport
                  |
                  v
     listTools → ToolDescriptor[] + AgentTool factories
                  |
                  v
 createToolAssembly = builtin registry + external MCP descriptors
                  |
                  v
 setTools(tools, activeToolNames)
 PermissionGate + ToolExecutionRuntime + ToolEventDecoder
```

## Boundaries

| Module | Responsibility | Non-goals |
|--------|----------------|-----------|
| `src/mcp/config.ts` | load/validate/merge user+project MCP config | settings.json 塞完整 server 定义 |
| `src/mcp/approval.ts` | user-local approval persistence + fingerprint | project trust |
| `src/mcp/client.ts` | transport connect, listTools, callTool, close | OAuth browser flow |
| `src/mcp/tools.ts` | MCP tool → descriptor/AgentTool adapter | 新 permission protocol |
| `src/tools/assembly.ts` (or extend index) | merge builtin + external sources | 平行 registry |
| `src/tui/commands` `/mcp` | list/approve/deny/reconnect + rebuild catalog | 完整 MCP 市场 UI |

## Config Model

Recommended files:

- User: `~/.novi/mcp.json`
- Project: `<cwd>/.mcp.json`（Claude 兼容优先；若需再兼容 `.novi/mcp.json`，作为次选只读路径）

Shape（概念）:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
      "env": { "FOO": "bar" }
    },
    "remote-docs": {
      "url": "https://example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${DOCS_MCP_TOKEN}"
      }
    }
  }
}
```

Rules:

- Server name: stable key, sanitized for source id `mcp:<name>` and tool prefix.
- Exactly one transport family per server: stdio (`command`) **or** HTTP (`url`)。
- Env/header values may use `${ENV_VAR}` substitution; missing required env → server unavailable diagnostic, not crash.
- User + project merge by server name: **same name 冲突时 project 覆盖声明，但 approval identity 以最终 transport fingerprint 为准**；fingerprint 变化使旧 approval 失效并回到 pending。
- Project servers always require approval before connect.
- User servers auto-approved for connection（仍受工具级 ask/permission 约束）。

## Approval Store

Path: `~/.novi/mcp-approvals.json`（user-local, gitignored by location）

```ts
type McpApprovalDecision = "approved" | "denied";

interface McpApprovalEntry {
  serverName: string;
  fingerprint: string; // hash(name + transport kind + command/args/url + normalized headers keys)
  decision: McpApprovalDecision;
  updatedAt: string;
  cwdKey?: string; // project-scoped entries keyed by project root
}
```

- Pending = no matching entry for current fingerprint.
- Denied = do not connect.
- Approved = may connect subject to tools.sources/enabled.
- Changing command/url/args invalidates approval.

## Client / Transport

Dependency: official MCP TypeScript client SDK（`@modelcontextprotocol/sdk` 或当前稳定 client 包）。

- stdio: spawn command with args/env/cwd=workspace; capture stderr diagnostics bounded.
- Streamable HTTP: url + headers; timeouts from shared/network or MCP-specific defaults.
- Session lifecycle:
  - connect → initialize → tools/list
  - callTool on demand
  - close on harness dispose / reconnect / process exit
- Fail-soft: one server error yields source unavailable + diagnostic; never aborts bootstrap of builtins.

## Descriptor Mapping

```ts
source: { kind: "external", id: `mcp:${serverName}` }
name: stable unique, e.g. `mcp_${serverSanitized}_${toolSanitized}`
label: original MCP tool title/name
defaultPermission: "ask"
optional: true
risk: coarse from heuristics / annotations (default "execute" or "network" if remote)
capabilities: coarse map; fallback conservative capability set that keeps ask/deny semantics meaningful
streaming: "none" initially (MCP progress optional follow-up)
```

Permission intents:

- Prefer mapping known patterns (path-like args → filesystem.*, url-like → network.fetch, command-like → shell.execute).
- Fallback intent: capability that preserves default ask without granting broad filesystem/network allow via rules accidentally.
- Candidate fallback: introduce **no new capability** first; use `shell.execute` only if that overstates risk in grants. Prefer a dedicated future capability only if necessary — **first try reuse + tool-scoped rules**. If reuse is unsafe, child 2 design may add one `external.invoke` capability after inspecting gate assumptions.

Decision for implementation child: inspect PermissionGate/policy tests; if closed capability set blocks a clean fallback, add `external.invoke` in the same child with policy/tests update.

## Assembly

Replace “builtin-only” assumption carefully:

1. Keep `createBuiltinToolAssembly` for builtin descriptors.
2. Add `createToolAssembly(...)` that:
   - builds builtin assembly
   - loads MCP plan
   - connects approved servers
   - registers external descriptors into the same `ToolRegistry` instance or merges assemblies deterministically
   - applies exposure policy (`tools.sources` / `tools.enabled` / whole-tool deny)
   - wraps all tools with the same `ToolExecutionRuntime`
3. All call sites (bootstrap preflight, createHarnessForSession, resume, TUI rebuild) switch to the unified entry.

Preflight may avoid spawning MCP processes if only validating builtin security contracts; or spawn with short timeout. Prefer: preflight validates config/approval surface without connecting; real connect happens when creating session tools. Document the choice in child 2/3 implement notes.

## Session Management

`/mcp` command (TUI):

- list: name, origin (user/project), transport summary, approval status, connection status, tool count, last error
- approve <name>
- deny <name>
- reconnect <name> | reconnect

After approve/deny/reconnect:

1. persist approval if needed
2. rebuild external sources
3. recompute active set
4. `setTools(tools, activeToolNames)`
5. refresh `toolCatalog` for `/tools` and Headless projector consumers

Gateway/headless:

- no interactive `/mcp`
- consume existing approvals + config only
- diagnostics surface pending project servers

## Error / Availability Codes

Reuse/extend availability:

- `SOURCE_DISABLED`
- `INITIALIZATION_FAILED`
- new diagnostic reasons: `MCP_PENDING_APPROVAL`, `MCP_DENIED`, `MCP_CONFIG_INVALID`, `MCP_TRANSPORT_ERROR`

Pending/denied servers should appear in `/mcp` and diagnostics, not as model-visible tools.

## Compatibility

- No parallel tool event protocol.
- Existing builtin tests remain green.
- `tools.sources.builtin` continues to work; external sources default enabled when approved/connected unless explicitly disabled.
- Breaking changes allowed only where no public external client contract exists yet.

## Rollout / Rollback

- Feature is config-driven: empty MCP configs → behavior identical to today.
- Rollback = remove MCP modules and restore `createBuiltinToolAssembly` call sites.
- No data migration beyond optional deletion of `~/.novi/mcp-approvals.json`.

## Trade-offs

| Choice | Benefit | Cost |
|--------|---------|------|
| Separate approval from project trust | safer defaults | two trust concepts to document |
| Streamable HTTP in v1 | remote SaaS MCP | auth/timeout complexity |
| Default ask | safer | more prompts |
| No OAuth v1 | smaller scope | some hosted MCP need manual token headers |
| No auto-reconnect | simpler | user must `/mcp reconnect` |
