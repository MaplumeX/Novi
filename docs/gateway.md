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
