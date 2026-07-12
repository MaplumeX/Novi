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
