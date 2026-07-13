# Novi

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
`~/.novi/artifacts/<sessionId>/<toolCallId>/`; per-session/global quotas and
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
