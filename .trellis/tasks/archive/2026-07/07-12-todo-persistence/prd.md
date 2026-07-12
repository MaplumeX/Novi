# todo tool persistence to session-scoped storage

## Goal

Persist the todo list to disk scoped by session ID, so `/resume` and process restarts retain the todo state. Currently the store is an in-memory `Map<sessionId, Todo[]>` lost when the process exits.

## Background

Current `src/tools/todo.ts`:
- Module-level singleton `const store = new Map<string, Todo[]>()`.
- `createTodoTool(sessionId)` closes over sessionId, reads/writes the in-memory map.
- `__resetTodoStoreForTests()` clears the map (test-only escape hatch).
- Factory wiring: `index.ts` registers `.add("todo", (_env, sessionId) => createTodoTool(sessionId))` — env is ignored.
- Constraint from parent PRD: must not break the `createTodoTool(sessionId)` factory signature used by `registry.ts` / `replayHarnessState`.

Confirmed decisions:
- **Storage location**: `~/.novi/todos/<sessionId>.json` — independent dedicated directory (matches Claude Code's `~/.claude/tasks/` approach). Not co-located with session JSONL files.
- **Format**: JSON array of `Todo` objects (`{id, content, status}`).
- **Orphan files**: session deletion does not clean up todo files. Accepted trade-off (data is small; cleanup can be added later).

## Requirements

- On any todo mutation (`add`, `update`), persist the session's todo list to `<noviDir>/todos/<sessionId>.json`.
- On `list` (or first access), load from disk if the in-memory cache is empty for that session. This covers `/resume` (new process, same session ID) and process restart.
- `getNoviDir()` is imported from `src/config.ts` directly (same as `fetch-content.ts`), not via `env` — this keeps `createTodoTool(sessionId)` signature unchanged.
- File I/O is best-effort: if the directory can't be created or the file can't be written, the tool still works in-memory and logs a warning to stderr (non-fatal, matching the project's "failure degrades gracefully" principle). The tool must not throw on persistence failure.
- On load, if the JSON file is corrupt or unreadable, start with an empty list and log a warning (don't throw).
- `__resetTodoStoreForTests()` must clear both the in-memory cache and the disk state for test isolation.
- The `Todo` interface is unchanged: `{ id: string; content: string; status: "pending" | "in_progress" | "done" }`.

## Acceptance Criteria

- [ ] After `add`, the todo file exists at `<noviDir>/todos/<sessionId>.json` with the correct JSON content
- [ ] After `update`, the file reflects the updated state
- [ ] In a fresh process (or after clearing in-memory cache), `list` reads from disk and returns the persisted todos
- [ ] `createTodoTool(sessionId)` signature is unchanged — no factory wiring changes in `index.ts` or `registry.ts`
- [ ] Persistence failure (e.g. read-only filesystem) does not throw — tool returns the result, logs a warning
- [ ] Corrupt JSON file → empty list, no throw, warning logged
- [ ] `__resetTodoStoreForTests()` clears in-memory cache and disk files
- [ ] `/resume` scenario: new harness with same session ID sees persisted todos on first `list`
- [ ] `npm test` passes with new tests using a mocked `getNoviDir` (same pattern as `fetch-content.test.ts`)
- [ ] `tsc --noEmit` passes
- [ ] `eslint` passes

## Out of Scope

- Orphan file cleanup (session deletion → todo file deletion)
- Multi-agent coordination / file locking (Claude Code's v2 feature)
- Todo dependency relationships (A blocks B)
- Migration of existing in-memory todos to disk (no existing data to migrate)

## Constraints

- `createTodoTool(sessionId: string)` signature must not change — `registry.ts` and `replayHarnessState` call it with just `sessionId`.
- Import `getNoviDir` from `../../config.js` (not `env`) for the storage path — same pattern as `fetch-content.ts`.
- Tests must mock `getNoviDir` to a temp directory (pattern: `vi.mock("../../config.js", ...)` in `fetch-content.test.ts`).
- Tools depend only on `ExecutionEnv` + node stdlib (+ project modules like `config.ts`) — `config.ts` is a pure path resolver, not a TUI/harness internal, so this doesn't violate the dependency rule.