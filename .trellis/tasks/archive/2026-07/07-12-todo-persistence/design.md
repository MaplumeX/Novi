# todo persistence — technical design

## Architecture

`src/tools/todo.ts` gains a persistence layer using `node:fs/promises` and `getNoviDir()` from `src/config.ts`. The in-memory `Map<string, Todo[]>` becomes a cache with disk as the source of truth on first access.

## Changes

### 1. Imports

```ts
import { mkdir, readFile, writeFile, readdir, remove } from "node:fs/promises";
import path from "node:path";
import { getNoviDir } from "../config.js";
```

### 2. Storage path helper

```ts
function todoFilePath(sessionId: string): string {
  return path.join(getNoviDir(), "todos", `${sessionId}.json`);
}

async function todoDir(): Promise<string> {
  return path.join(getNoviDir(), "todos");
}
```

### 3. Load from disk

```ts
async function loadFromDisk(sessionId: string): Promise<Todo[]> {
  try {
    const filePath = todoFilePath(sessionId);
    const raw = await readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as Todo[];
    return [];
  } catch {
    // File doesn't exist or is corrupt → empty list
    return [];
  }
}
```

### 4. Persist to disk

```ts
async function persistToDisk(sessionId: string, todos: Todo[]): Promise<void> {
  try {
    const dir = await todoDir();
    await mkdir(dir, { recursive: true });
    await writeFile(todoFilePath(sessionId), JSON.stringify(todos, null, 2), "utf-8");
  } catch (e) {
    // Best-effort: log to stderr, don't throw
    process.stderr.write(`warning: todo persistence failed for session ${sessionId}: ${e instanceof Error ? e.message : String(e)}\n`);
  }
}
```

Note: `process.stderr.write` is acceptable here — `fetch-content.ts` and resource loaders use the same pattern for non-fatal warnings. It's not a stdout write (which is TUI-owned).

### 5. Modified store access

```ts
// In-memory cache (still a Map for fast access within a session)
const store = new Map<string, Todo[]>();

async function getSessionTodos(sessionId: string): Promise<Todo[]> {
  if (store.has(sessionId)) return store.get(sessionId)!;
  const loaded = await loadFromDisk(sessionId);
  store.set(sessionId, loaded);
  return loaded;
}
```

### 6. Updated execute

```ts
execute: async (_toolCallId, params) => {
  const sessionTodos = await getSessionTodos(sessionId);
  switch (params.action) {
    case "add": {
      // ... create todo, push to sessionTodos ...
      store.set(sessionId, sessionTodos);
      await persistToDisk(sessionId, sessionTodos);
      return { content: [...], details: snapshot(sessionTodos) };
    }
    case "update": {
      // ... find and update todo ...
      store.set(sessionId, sessionTodos);
      await persistToDisk(sessionId, sessionTodos);
      return { content: [...], details: snapshot(sessionTodos) };
    }
    case "list": {
      return { content: [...], details: snapshot(sessionTodos) };
    }
  }
}
```

Key: `getSessionTodos` is `async` now, so `execute` was already `async` — no signature change to `execute`, just `await` the load.

### 7. Updated __resetTodoStoreForTests

```ts
export async function __resetTodoStoreForTests(): Promise<void> {
  store.clear();
  try {
    const dir = await todoDir();
    const files = await readdir(dir);
    await Promise.all(files.map((f) => remove(path.join(dir, f))));
  } catch {
    // dir doesn't exist — fine
  }
}
```

Note: this changes the signature from sync `void` to async `Promise<void>`. Tests calling it must `await`. Check existing test usage and update.

## Data Flow

```
execute (add/update)
  → getSessionTodos(sessionId)
    → cache hit? return cached
    → cache miss? loadFromDisk → cache.set → return
  → mutate sessionTodos
  → store.set(sessionId, sessionTodos)
  → persistToDisk(sessionId, sessionTodos)
    → mkdir -p ~/.novi/todos
    → writeFile ~/.novi/todos/<sessionId>.json
    → on failure: stderr warning, no throw
  → return result

execute (list)
  → getSessionTodos(sessionId)
  → return snapshot
```

## Compatibility

- **Factory signature**: `createTodoTool(sessionId: string)` — unchanged. `index.ts` wiring `(_env, sessionId) => createTodoTool(sessionId)` — unchanged.
- **`replayHarnessState`**: calls `createBuiltinTools(env, sessionId)` → `createTodoTool(sessionId)` — unchanged. On `/resume`, the new harness's todo tool will lazy-load from disk on first access.
- **`Todo` interface**: unchanged.
- **`__resetTodoStoreForTests`**: becomes async. Existing test calls `__resetTodoStoreForTests()` without `await` — must update to `await __resetTodoStoreForTests()`. Check `src/tools/__tests__/todo.test.ts`.

## Trade-offs

- **Lazy load on first access** (not on factory creation): avoids reading disk if `list` is never called. Simpler than eager loading and handles the `/resume` case correctly (new process, first `list` or `add` triggers load).
- **In-memory cache stays**: avoids re-reading disk on every `list` within a session. The cache is the single in-process truth; disk is the persistence mirror.
- **`process.stderr.write` for warnings**: matches `resources.ts` and `fetch-content.ts` patterns. Not ideal (the spec says "backend modules don't write to stdout") but stderr warnings are the established pattern for non-fatal degradation.
- **No file locking**: concurrent processes with the same session ID could race. This is an edge case (same session in two processes) and out of scope. Claude Code's v2 uses file locking; we don't need it for single-process Novi.

## Rollback

Revert `todo.ts` to the in-memory-only version. Remove the `getNoviDir` import and disk functions. The factory signature was never changed, so no wiring revert needed.