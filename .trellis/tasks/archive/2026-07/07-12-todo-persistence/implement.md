# todo persistence — execution plan

## Ordered Checklist

1. [ ] Add imports to `src/tools/todo.ts`:
   - `import { mkdir, readFile, writeFile, readdir, remove } from "node:fs/promises";`
   - `import path from "node:path";`
   - `import { getNoviDir } from "../config.js";`

2. [ ] Add storage helpers:
   - `todoFilePath(sessionId)`: `<noviDir>/todos/<sessionId>.json`
   - `loadFromDisk(sessionId)`: read + JSON.parse; on error return `[]`
   - `persistToDisk(sessionId, todos)`: mkdir -p + writeFile; on error `process.stderr.write` warning, no throw

3. [ ] Add `getSessionTodos(sessionId)`: async, cache-first, lazy-load from disk on cache miss

4. [ ] Update `execute`:
   - `const sessionTodos = await getSessionTodos(sessionId);` (was `store.get(sessionId) ?? []`)
   - After `add`/`update` mutations: `await persistToDisk(sessionId, sessionTodos)` (best-effort)
   - `list` unchanged (already has `sessionTodos` from `getSessionTodos`)

5. [ ] Update `__resetTodoStoreForTests`:
   - **Keep sync signature** to avoid rippling async changes through `resetSharedState()` in `helpers.ts` (called sync in `beforeEach(() => resetSharedState())` across many test files)
   - Sync version: `store.clear()` + best-effort sync dir removal using `fs.rmSync`/`fs.readdirSync` from `node:fs` (not promises)
   - Import: `import { rmSync, readdirSync } from "node:fs";`
   - Wrap in try/catch, ignore errors (dir doesn't exist is fine)
   - This keeps `resetSharedState()` in `helpers.ts` synchronous — no test file changes needed

6. [ ] Add tests in `src/tools/__tests__/todo.test.ts`:
   - Mock `getNoviDir` to a temp directory (pattern from `fetch-content.test.ts`: `vi.mock("../../config.js", ...)`)
   - Test `add` → file exists at `<mockedNoviDir>/todos/<sessionId>.json` with correct content
   - Test `update` → file reflects updated state
   - Test `list` after clearing in-memory cache (call `__resetTodoStoreForTests` then `list`) → reads from disk, returns persisted todos
   - Test corrupt JSON file → empty list, no throw
   - Test `/resume` scenario: create todos with sessionA, reset in-memory cache, create new tool with same sessionId, `list` returns persisted todos
   - Update `beforeEach` to also reset the mocked `getNoviDir` temp dir (or use `afterEach` cleanup)

7. [ ] Verify `resetSharedState` in `helpers.ts` still works (sync `__resetTodoStoreForTests` — no changes needed if step 5 keeps it sync)

8. [ ] Run full validation:
   ```bash
   npm run typecheck && npm run lint && npm test
   ```

## Validation Commands

- `npx tsc --noEmit`
- `npx eslint src/tools/todo.ts`
- `npx vitest run src/tools/__tests__/todo.test.ts`

## Review Gates

- After step 4: verify `getSessionTodos` is awaited in `execute` (TS will flag if not)
- After step 5: verify `__resetTodoStoreForTests` stays sync (no `Promise<void>` return) — this is the key constraint to avoid test helper ripple
- After step 6: verify the `/resume` test actually clears the in-memory cache before re-reading (the core scenario)
- After step 8: full suite green

## Rollback Points

- Revert `todo.ts` — all changes in one file
- Tests in `todo.test.ts` are additive; mock setup may need removal on revert