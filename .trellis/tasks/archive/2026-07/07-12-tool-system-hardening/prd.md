# Tool system hardening: output truncation, grep correctness, multi-edit, bash streaming, todo persistence

## Goal

Parent task coordinating 5 independent tool-system improvements identified during a tool-system audit. Each child task is independently plannable, implementable, checkable, and archivable. The parent owns the cross-child acceptance criteria and final integration review.

## Background

Audit of `src/tools/` against pi-agent-core's built-in tool contracts (`truncate.d.ts` exports `truncateHead`/`truncateTail`/`truncateLine`, `DEFAULT_MAX_LINES=2000`, `DEFAULT_MAX_BYTES=50KB`, `GREP_MAX_LINE_LENGTH=500`) revealed 5 gaps. See child task PRDs for per-deliverable detail.

## Task Tree

| Child | Slug | Priority | Summary |
|-------|------|----------|---------|
| 1 | `tool-output-truncation` | P1 | Add line/byte truncation to bash/read_file/grep/glob/ls outputs |
| 2 | `grep-correctness` | P1 | Fix colon-in-path parsing, unify glob semantics, add ignoreCase/context/literal |
| 3 | `edit-file-multi-edit` | P1 | Support array of edits in one call |
| 4 | `bash-streaming-timeout` | P1 | Stream stdout/stderr via onStdout/onStderr + default timeout cap |
| 5 | `todo-persistence` | P2 | Persist todo list to session-scoped disk storage |

Children are independent; no cross-child ordering dependency. Each child's own `prd.md`/`design.md`/`implement.md` carries its detailed acceptance criteria.

## Cross-Child Acceptance Criteria

- [ ] All 5 child tasks archived with their own acceptance criteria met
- [ ] `npm test` passes at parent integration (no regressions across tools)
- [ ] `tsc --noEmit` passes
- [ ] `eslint` passes
- [ ] No tool violates the dependency rule: tools depend only on `ExecutionEnv` + node stdlib (+ pi-agent-core public exports), never on TUI/harness internals

## Out of Scope

- Permission system default coverage expansion (tracked separately)
- Binary file detection in read_file
- web_search provider expansion
- fetch_content markdown converter replacement
- Tool result error classification
- Tool result caching / frecency

## Constraints

- Reuse pi-agent-core's public `truncateHead`/`truncateTail`/`truncateLine` utilities where applicable rather than reimplementing truncation.
- Tool `execute` signature supports `onUpdate?: AgentToolUpdateCallback` for streaming partial results — bash streaming should use it.
- `executionMode?: "sequential" | "parallel"` is available per-tool on `AgentTool`.
- Todo persistence must not break the current `createTodoTool(sessionId)` factory signature contract used by `registry.ts` / `replayHarnessState`.