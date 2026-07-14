# Gateway configuration

Pairing must name at least one Telegram administrator. `security.allowlist`
continues to control legacy DM access; it does not grant pairing approval.

```json
{
  "security": {
    "dmPolicy": "pairing",
    "adminAllowlist": ["123456789"],
    "pairing": { "ttlMs": 3600000, "maxPending": 3 }
  }
}
```

An administrator sends `/pair approve CODE` from their own direct chat with
the same bot. Pairing authorizations are scoped to that bot instance.

`SIGHUP` reloads access and group-routing policy atomically. Changes to bot
tokens, enabled channels, queue/session settings, and stream edit interval
require a gateway restart; the running configuration is retained on rejection.

## Session continuity

Gateway conversation bindings are stored in
`~/.novi/gateway-sessions.json` (or `$NOVI_HOME/gateway-sessions.json`). A
binding identifies the channel type, configured account, chat kind, chat id,
and optional thread id, then points to the canonical JSONL session metadata.
The mapping survives gateway restarts and in-memory idle/capacity eviction, so
the next message resumes the same JSONL session and its session-scoped TODOs.

`/new` is an explicit force reset. It aborts the active turn, discards messages
queued before the reset, suppresses late output from the old turn, creates a
new JSONL session, and atomically switches the binding. The previous JSONL and
TODO bucket are retained. A lightweight archive entry is appended to the same
mapping file so the old association remains auditable.

The mapping file is committed with a same-directory temporary file and atomic
rename. Invalid JSON, an unsupported schema version, or an invalid binding
prevents gateway startup and leaves the file untouched. If a binding points to
a missing or mismatched JSONL file, ordinary messages report the error instead
of silently losing context; use `/new` to explicitly replace that binding.

The schema can represent multiple locators pointing to one session, but Novi
does not yet expose cross-channel identity linking or concurrent shared-session
execution. Editing the mapping file by hand is not supported.

## Scheduled jobs and reminders

The running Gateway owns a durable scheduler. Definitions live in
`$NOVI_HOME/jobs/store.json` (default `~/.novi/jobs/store.json`) and bounded
run records live in `jobs/runs/<jobId>/<runId>.json`. Only one Gateway may own
a Novi home; a second scheduler fails startup instead of executing duplicate
occurrences.

Ordinary Gateway conversations expose a `jobs` tool for natural-language job
creation and management. Deterministic management remains available without a
model:

```text
/jobs list
/jobs show <jobId>
/jobs pause|resume|cancel|run <jobId>
/jobs retry-delivery <runId>
```

The current `channel/account/chat/thread` route owns every job it creates.
Knowing an id does not grant another route access. A non-origin Telegram target
must already have a durable authorized Gateway binding.

One-shot reminders use absolute UTC instants. Cron jobs accept five fields,
pin an IANA timezone, and default to a five-minute minimum interval. After a
restart, an overdue reminder is delivered once with its original time; Cron
does not replay offline occurrences. DST gaps are skipped and overlaps run
once.

Execution and delivery are separate durable states. Once an Agent result is
stored, delivery retries reuse that bounded result and never call the model
again. Telegram has no client idempotency key, so delivery is at-least-once:
the narrow crash window after Telegram accepts a message but before Novi saves
the receipt can produce a duplicate. Messages carry stable short job/run ids,
and ambiguous recovery is visible through `/jobs`.

Successful origin delivery appends a system-generated custom message through
the origin session lane. It does not enter the inbound pipeline, trigger a new
turn, or grant permissions. Automation sessions do not contain the `jobs`
tool, MCP servers, project hooks, Skills, write tools, or shell by default.

```json
{
  "automation": {
    "timezone": "Asia/Shanghai",
    "allowedTools": ["read_file", "ls", "glob", "grep", "web_search", "fetch_content"],
    "minCronIntervalMs": 300000,
    "runTimeoutMs": 120000,
    "maxExecutionRetries": 1,
    "maxDeliveryRetries": 3,
    "maxConcurrentLlmRuns": 2,
    "dailyTokenLimit": 200000,
    "dailyCostUsd": 1,
    "retentionDays": 30,
    "maxRunsPerJob": 100,
    "maxResultBytes": 65536
  }
}
```

Trusted project configuration may only tighten automation limits and tool
allowlists. Automation and Heartbeat changes require a Gateway restart.

## Heartbeat

Heartbeat is disabled by default. It requires an explicit pinned model and
Telegram target:

```json
{
  "heartbeat": {
    "enabled": true,
    "everyMs": 1800000,
    "model": "anthropic/claude-sonnet-4-5",
    "activeHours": { "start": "09:00", "end": "22:00", "timezone": "Asia/Shanghai" },
    "target": {
      "channel": "telegram",
      "account": "telegram-main",
      "chat": { "type": "direct", "id": "123" }
    }
  }
}
```

Instructions come from `~/.novi/HEARTBEAT.md`; a trusted project may override
them with `<cwd>/.novi/HEARTBEAT.md`. Empty files and non-due tasks make zero
model calls. YAML frontmatter may define named `tasks` with `every` values such
as `30m`, `2h`, or `1d`. `HEARTBEAT_OK`, `SILENT`, `[SILENT]`, `NO_REPLY`, and
`NO REPLY` suppress delivery.
