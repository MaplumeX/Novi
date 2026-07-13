# Scoped Permission and Workspace Boundary Design

## Dependencies

Implementation starts after `07-13-platformize-tool-registry`. It consumes the
validated descriptor, capability, permission-intent, availability, and active
set contracts. It must not infer these properties from raw tool names.

## Decision Pipeline

For every `tool_call`:

```text
descriptor intent resolution
  → canonical capability/target/scope
  → current static rules
      whole/scoped deny → deny
      allow             → allow
      ask               → matching session grant? → allow : approver
  → user hook (only after built-in permission allows)
```

Static deny is evaluated before grants. `/reload` replaces resolved rules while
keeping only grants that remain meaningful; no grant can override the new
policy.

## Rule Model

Rules match `tool`, `capability`, and optional canonical target pattern. The
resolver uses descriptor defaults when no rule matches. Precedence is:

1. deny;
2. ask;
3. allow;
4. descriptor default.

Global rules may set any effect. Trusted project rules may add deny/ask or
remove availability, but cannot add a broader allow. Unknown/invalid rules are
diagnosed and ignored only when they cannot loosen policy; ambiguous loosening
fails closed.

## Workspace File Policy

- Canonical workspace root is captured from the trusted startup cwd.
- Native file tools normalize the lexical absolute path and an effective
  canonical path. Existing targets use their real path. For a missing target,
  resolution realpaths the deepest existing ancestor and appends the remaining
  path segments, so a symlinked parent cannot redirect a new file unnoticed.
- Access is workspace-internal only when both lexical and effective canonical
  paths are contained by the workspace root; then it proceeds to the tool's
  normal policy.
- External reads/searches resolve to `ask` unless a stricter rule applies.
- External writes/edits resolve to `deny` unless both lexical and effective
  canonical paths are covered by either the workspace root or a global write
  allowlist. This permits a deliberately allowlisted symlink target without
  treating an unlisted external spelling as internal.
- Project settings cannot extend the external-write allowlist.
- `bash` is explicitly outside this file boundary and remains `ask` by its own
  shell intent; UI/docs disclose that this is not an OS sandbox.

The gate and native file implementation call the same scope guard, with a
second boundary resolution immediately before I/O. This closes stale approval
and ordinary symlink-redirection gaps while staying within the public
`ExecutionEnv` contract. It is not an OS-level defense against an adversarial
process racing filesystem entries.

## Session Grants

Replace `Set<toolName>` with typed grant keys:

- exact canonical file (`read_file`);
- exact directory (`ls`);
- canonical subtree (`glob`, `grep`);
- exact normalized hostname (`fetch_content`);
- search capability (`web_search`);
- exact normalized command (`bash`).

Command grant normalization is deliberately non-semantic: validate the full
string, reject NUL/control forms the Bash tool cannot execute safely, and key
the remaining exact UTF-8 command. It never collapses whitespace, rewrites
quotes, reparses shell syntax, or grants based on a prefix. The approval UI may
render a redacted display summary, but matching uses the full exact key.

Grants are process-memory only and are shared across a TUI harness rebuild for
the same interactive run. Gateway sessions receive separate stores; one chat
must not authorize another. Resume in a new process does not restore grants.

## Approval Surface

The approver receives capability, tool, redacted summary, canonical target,
scope kind, and reason. Choices remain once/session/deny, but session now means
the displayed minimal scope. Non-interactive modes reject ask with a stable
`PERMISSION_INTERACTION_REQUIRED` code.

Stable gate failures use the public before-tool reason channel with a bounded
`NOVI_ERROR:<code>:<message>` representation. The shared event decoder restores
the structured code without importing pi-agent-core internals. Initial codes
are `PERMISSION_DENIED`, `PERMISSION_INTERACTION_REQUIRED`,
`WORKSPACE_EXTERNAL_WRITE_DENIED`, `TOOL_DISABLED`, and
`PERMISSION_INTENT_INVALID`; permission-denial payloads are never sent to the
artifact sink.

## Availability Interaction

A whole-tool deny removes the tool from active names through the registry
assembly. Scoped deny leaves it active. The runtime gate remains authoritative
for both to protect against stale tool calls.
