# Novi

## Child agents and immediate background runs

Novi can delegate independent work to durable child-agent runs on TUI,
Headless JSON, and Gateway surfaces. The `agents` tool returns immediately;
the child runs in its own JSONL session, and a persisted completion event wakes
the parent when the result is ready. `agents_yield` lets the parent end its
current loop without polling.

Built-in profiles are `explorer` and `reviewer` (read-only) plus `worker`
(write-capable only where the parent was already allowed). Child profiles can
never gain the `agents`, `jobs`, or channel messaging tools. Defaults allow 8
global and 5 per-parent active children, so three parallel delegates are a
supported baseline rather than a fixed ceiling.

```json
{
  "subagents": {
    "enabled": true,
    "maxConcurrent": 8,
    "maxChildrenPerParent": 5,
    "maxSpawnDepth": 1,
    "runTimeoutMs": 900000,
    "maxResultBytes": 65536,
    "retentionDays": 30,
    "allowedModels": ["anthropic/claude-sonnet-4-5"]
  }
}
```

Trusted project settings may only tighten these limits and profile
capabilities. Every child has a run-scoped permission store; TUI approval shows
the run/profile source, while Headless and Gateway remain fail-closed for
residual `ask` decisions.

Operator commands:

```text
/agents list
/agents info <run-id>
/agents log <run-id>
/agents cancel <run-id>
/agents retry <run-id>
/agents stop-all

novi --gateway agents list [--json]
novi --gateway agents get|cancel|retry <run-id> [--json]
```

Run ledgers live under
`~/.novi/agent-runs/runs/<parentSessionId>/<runId>.json`. Queued work survives
restart; an in-flight read-only run may safely retry once, but a write-capable
worker is recorded as interrupted and is never automatically replayed. These
immediate runs are separate from durable scheduled jobs: they share bounded
execution and provider concurrency primitives, not scheduling semantics.

## Gateway as a systemd user service

On Linux with systemd 240+, build/install Novi and migrate legacy Gateway state before installing the user service:

```bash
novi --gateway migrate --dry-run
novi --gateway migrate
novi --gateway service install
novi --gateway service status
novi --gateway service logs --lines 200
```

Installation defaults to `enable --now`. This starts automatically with the user manager after login. Pass `--linger` only when you explicitly want boot-time operation without a login; uninstall never disables linger. Use `--no-enable` or `--no-start` for staged installation.

An optional `--environment-file /absolute/path` must be a current-user regular file with mode `0600` or stricter. Its contents are never copied into the unit or install manifest. Novi does not use sudo, write `/etc`, install Node, or auto-upgrade itself. After changing the Novi binary path, cwd, config, or environment-file path, review and apply the deterministic unit update with `service install --replace`.

## MCP external tools

Novi can load Model Context Protocol (MCP) servers and expose their tools
alongside the built-in catalog.

Config files:

- User (always loadable): `~/.novi/mcp.json`
- Project (requires MCP approval before connect): `<cwd>/.mcp.json`
  (secondary: `<cwd>/.novi/mcp.json`)

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
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

Approvals are **not** project trust:

- `/trust` controls whether project settings/skills/prompts/models load.
- `/mcp approve|deny` controls whether a **project** MCP server may connect.
  Approvals live in user-local `~/.novi/mcp-approvals.json` and are keyed by
  server name + transport fingerprint (command/args/url change → re-approve).
- User-origin MCP servers connect without approval; every MCP tool still uses
  the normal tool permission gate (default `ask`).

TUI management:

```text
/mcp                 # list servers, status, tool counts
/mcp approve <name>  # approve project server + hot-refresh tools
/mcp deny <name>     # deny and drop tools (persists across restarts)
/mcp reconnect       # explicit reconnect (no background auto-reconnect)
/tools               # shows builtin + external source labels
```

Headless/Gateway paths never prompt for MCP approval; pending project servers
appear only as diagnostics. Operators approve via TUI (preferred) or by writing
the approval store.

Novi uses a Tools-first MCP profile. Small catalogs are exposed directly;
larger catalogs use the bounded `mcp_tool_search` → opaque `toolRef` →
`mcp_tool_invoke` flow. `tools/list` pagination and `notifications/tools/list_changed`
refresh a versioned catalog atomically. A failed refresh keeps the last-known-good
revision and reports the source as `degraded`; stale references fail with
`MCP_TOOL_STALE` and should be searched again.

| MCP capability                                                          | Status      | Novi behavior                                                                                                                |
| ----------------------------------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Initialize, stdio/Streamable HTTP, paginated `tools/list`, list-changed | Supported   | Client capabilities remain `{}`; catalog refresh is bounded and atomic.                                                      |
| `tools/call` text, supported image MIME, `structuredContent`            | Supported   | Native model content; current catalog `outputSchema` is validated again at the result boundary.                              |
| Resource links and embedded text resources                              | Supported   | URI/MIME/annotations are preserved; Novi does not implicitly issue `resources/read`.                                         |
| Progress and cancellation                                               | Supported   | Strictly increasing bounded true deltas; progress never extends the hard total timeout.                                      |
| Audio, embedded binary, oversized/unsupported images                    | Degraded    | Stored as private quota-bound artifacts when enabled, otherwise returned as an explicit degradation; base64 is never public. |
| Resources/Prompts APIs, Sampling, Elicitation, Tasks, OAuth discovery   | Unsupported | Not advertised and no server-initiated handler is installed. Static configured HTTP headers are supported.                   |

MCP failures use distinct stable codes: `MCP_TOOL_ERROR`,
`MCP_INPUT_SCHEMA_INVALID`, `MCP_OUTPUT_SCHEMA_INVALID`,
`MCP_PROTOCOL_ERROR`, `MCP_TRANSPORT_ERROR`, `MCP_TOOL_STALE`, plus the
shared `TOOL_TIMEOUT` and `TOOL_ABORTED`. Transport, timeout, and stale-reference
failures are retryable; protocol/output failures are not retried with the same
payload.

## Tool permissions and workspace boundary

Known tools use their validated descriptor default, then apply permission
rules by precedence (`deny` > `ask` > `allow`). Rules may target a whole tool
or a canonical capability scope:

```json
{
  "permissions": {
    "rules": [
      { "tool": "bash", "effect": "ask" },
      {
        "capability": "filesystem.read",
        "scope": "subtree",
        "target": "/absolute/private/tree",
        "effect": "deny"
      }
    ],
    "externalWriteAllowlist": ["/absolute/explicit-output-root"]
  }
}
```

`externalWriteAllowlist` is accepted only from global
`~/.novi/settings.json`; project settings cannot broaden it or add `allow`
rules. Native file reads/searches outside the startup workspace require a
bounded path approval. Native writes/edits outside it are denied unless both
the lexical path and resolved symlink target are covered by the workspace or
the global allowlist. Session grants are process-memory only and are scoped to
the exact file/directory/domain/command or the approved subtree.

This boundary is not an OS sandbox. `bash` is authorized as an exact command,
and an approved shell command or child process can access paths outside the
workspace. Headless and Gateway modes cannot show approval UI, so `ask`
decisions fail closed unless `--yes` is explicitly used.

## Tool resource budgets

Every runtime surface resolves one `ToolExecutionBudget` and reuses it for
fresh sessions, resume, TUI rebuilds, print/JSON, and Gateway sessions. The
precedence is built-in defaults → global settings (loosen or tighten) → trusted
project settings (tighten only) → repeatable CLI overrides:

```bash
novi --tool-budget modelBytes=65536 --tool-budget timeoutMs=300000
```

```json
{
  "toolBudgets": {
    "modelBytes": 51200,
    "modelLines": 2000,
    "memoryBytes": 262144,
    "partialBytes": 16384,
    "partialUpdatesPerSecond": 10,
    "timeoutMs": 120000,
    "maxConcurrentCalls": 4,
    "traversalFiles": 50000,
    "traversalDepth": 64,
    "resultCount": 10000,
    "artifactSessionBytes": 268435456,
    "artifactGlobalBytes": 1073741824,
    "artifactMaxAgeMs": 604800000,
    "webCacheBytes": 536870912,
    "webCacheMaxAgeMs": 2592000000
  },
  "artifacts": { "enabled": true }
}
```

Large output is represented by a bounded model-visible preview and structured
resource metrics. When artifacts are enabled, overflow is written
incrementally with mode `0600` under
`~/.novi/artifacts/<sessionId>/<toolCallId>*/`; directories use `0700`, and
text or binary files use `0600`. Per-session/global quotas and
age cleanup apply. Global settings may disable artifacts and project settings
may additionally disable or tighten them, but a project cannot force-enable
or raise a ceiling. Permission denials are resolved before tool execution and
are never persisted as artifacts.

`bash` streams ordered bounded deltas instead of cumulative snapshots, uses a
hard timeout, and never copies complete stdout/stderr into result details.
`glob` and `grep` skip symlinks and heavy default directories, honor the root
`.gitignore`, and stop deterministically at file/depth/result ceilings.

## Tool event protocol

`novi --mode json` exposes one breaking, JSON-safe tool lifecycle. Raw harness
and hook tool events are not emitted, so each call has one start, zero or more
ordered deltas, and one final envelope:

```jsonl
{"type":"tool.start","toolCallId":"call-1","tool":{"name":"bash","label":"Bash","source":{"kind":"builtin","id":"native"},"capabilities":["shell.execute"],"risk":"execute"},"input":{"command":"pwd"},"at":1770000000000}
{"type":"tool.delta","toolCallId":"call-1","sequence":1,"delta":"/workspace\n","at":1770000000010}
{"type":"tool.end","toolCallId":"call-1","result":{"version":1,"status":"success","preview":"/workspace\n","metrics":{"startedAt":1770000000000,"durationMs":20,"outputBytes":11,"outputLines":1},"truncation":{"truncated":false,"reasons":[],"shownBytes":11,"shownLines":1},"artifacts":[]},"at":1770000000020}
```

Final status is `success`, `error`, or `cancelled`. Errors include a stable
`code`, bounded message, and `retryable` flag. Truncated output reports its
original metrics and optional `full-output` artifact without embedding a
second full copy. Inputs and structured data are bounded and omit credential,
environment, cookie, and stack fields. `edit_file` accepts only the canonical
`{"path":"...","edits":[{"oldText":"...","newText":"..."}]}` shape.
MCP calls use this same event union and envelope in TUI, print/JSON, Gateway,
and persisted replay; there is no MCP-specific public event payload.

## Web tools

Novi exposes two batch-only web tools:

```json
{ "queries": [{ "query": "TypeScript ESM", "limit": 5 }], "force_refresh": false }
```

```json
{ "urls": ["https://example.com/article"], "format": "markdown", "max_chars_per_item": 20000 }
```

`web_search` uses key-free DuckDuckGo HTML search by default. Set an explicit
provider in `~/.novi/settings.json` (or a trusted project settings file) to use
Brave or Tavily; exporting a key alone never changes the provider:

```json
{
  "webSearch": {
    "provider": "brave",
    "cacheTtlMinutes": 15,
    "timeoutSeconds": 15,
    "concurrency": 3
  },
  "fetchContent": {
    "fallbackProvider": "tavily",
    "cacheTtlMinutes": 15,
    "timeoutSeconds": 20,
    "concurrency": 4,
    "maxRedirects": 3
  }
}
```

Brave requires `BRAVE_API_KEY`; Tavily search and the explicitly enabled
Tavily Extract fallback require `TAVILY_API_KEY`. Credentials are never
persisted in settings or web caches.

Web requests inherit `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY` (including
their lowercase variants) from the Novi process environment.

| Filter                  | DuckDuckGo | Brave | Tavily |
| ----------------------- | ---------- | ----- | ------ |
| include/exclude domains | no         | yes   | yes    |
| complete date range     | no         | yes   | yes    |
| language                | no         | yes   | no     |
| country                 | no         | yes   | yes    |

Unsupported filters produce an explicit per-query `UNSUPPORTED_FILTER`; they
are never silently discarded. `fetch_content` supports public HTML, text,
JSON, and text-layer PDF documents. It performs local extraction first and
never invokes an LLM. Scanned PDFs return `OCR_UNSUPPORTED`; browser automation
and authenticated-page access remain separate capabilities.

Both tools use a 15-minute freshness TTL under `~/.novi/cache/web/` by
default. Cache retention is additionally capped at 512 MiB and 30 days.
Oversized documents remain available at the returned continuation
path for exact reading with `read_file`. Fetching validates DNS and every
redirect, rejects private/internal targets, pins validated DNS answers, and
applies time, redirect, and response-size limits.
