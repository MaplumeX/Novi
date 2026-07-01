# Logging Guidelines

> How Novi surfaces diagnostic output to the developer.

---

## Overview

Novi has **no structured logging framework** (no winston / pino). Diagnostics
are minimal and go to **stderr** via `process.stderr.write`. The TUI
(`ink` render) owns stdout exclusively; backend modules must not write to
stdout.

Only one patterns exists today, used in two contexts:

1. Resource-load warnings during bootstrap.
2. Top-level startup failure (via `cli.ts` `fail()`).

---

## Where Logging Happens

| Context | Mechanism | Example |
|---------|-----------|---------|
| Bootstrap resource warnings | `process.stderr.write("warning: " + diagnostic + "\n")` | `bootstrap.ts` loops over `loaded.diagnostics` |
| Startup fatal error | `process.stderr.write(message + "\n"); process.exit(1)` | `cli.ts` `fail()` |
| In-session notices | `print()` → TUI state (not stderr) | `App.tsx` command/prompt error handlers |

In-session issues (command failures, prompt failures) go through the TUI's
`print()` (a `useState<string[]>` notice area), **not** `process.stderr`.
Only startup-time backend code touches stderr directly.

---

## Conventions

- Prefix warnings with `warning: `.
- Prefix fatal startup messages with the app name context, e.g.
  `Novi: <message>`.
- One message per line; always append `\n`.
- Keep messages actionable: include the env var / flag to fix the issue when
  applicable (e.g. "Set ANTHROPIC_API_KEY (or ANTHROPIC_OAUTH_TOKEN) in your
  environment.").

---

## Forbidden Patterns

- Do not `console.log` / `console.error` — the TUI owns the terminal; stray
  stdout writes corrupt the Ink render. Use `process.stderr.write`.
- Do not add a logging library without an explicit task.
- Do not emit in-turn diagnostics to stderr from tools or the harness; surface
  them via tool results / TUI notices instead.
- Do not log secrets (API keys). The auth-check path only reports presence,
  never the key value.
