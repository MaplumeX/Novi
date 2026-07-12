import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import path from "node:path";
import * as Type from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core/node";
import { getNoviDir } from "../config.js";

const Parameters = Type.Object({
  action: Type.Union([Type.Literal("add"), Type.Literal("update"), Type.Literal("list")]),
  content: Type.Optional(Type.String()),
  id: Type.Optional(Type.String()),
  status: Type.Optional(
    Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("done")]),
  ),
});

export interface Todo {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "done";
}

/**
 * In-memory cache of todo lists, bucketed by sessionId. Disk is the source of
 * truth on first access; this cache avoids re-reading disk on every operation
 * within a session.
 */
const store = new Map<string, Todo[]>();

interface TodoDetails {
  todos: Todo[];
}

function todoFilePath(sessionId: string): string {
  return path.join(getNoviDir(), "todos", `${sessionId}.json`);
}

function snapshot(sessionTodos: Todo[]): TodoDetails {
  return { todos: sessionTodos.map((t) => ({ ...t })) };
}

function formatList(sessionTodos: Todo[]): string {
  if (sessionTodos.length === 0) return "(no todos)";
  return sessionTodos
    .map(
      (t) =>
        `[${t.status === "in_progress" ? "x" : t.status === "done" ? "v" : " "}] ${t.id} ${t.content}`,
    )
    .join("\n");
}

/**
 * Load a session's todos from disk. Returns an empty list when the file is
 * missing (new session — expected) or corrupt/unreadable (logs a warning).
 * Never throws.
 */
async function loadFromDisk(sessionId: string): Promise<Todo[]> {
  try {
    const raw = await readFile(todoFilePath(sessionId), "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Todo[]) : [];
  } catch (e) {
    // ENOENT is expected for new sessions — no warning.
    if (e instanceof Error && "code" in e && (e as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    process.stderr.write(
      `warning: todo load failed for session ${sessionId}: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    return [];
  }
}

/** Persist a session's todos to disk. Best-effort: logs a warning on failure, never throws. */
async function persistToDisk(sessionId: string, todos: Todo[]): Promise<void> {
  try {
    const dir = path.join(getNoviDir(), "todos");
    await mkdir(dir, { recursive: true });
    await writeFile(todoFilePath(sessionId), JSON.stringify(todos, null, 2), "utf-8");
  } catch (e) {
    process.stderr.write(
      `warning: todo persistence failed for session ${sessionId}: ${e instanceof Error ? e.message : String(e)}\n`,
    );
  }
}

/** Get the todo list for a session, lazy-loading from disk on first access. */
async function getSessionTodos(sessionId: string): Promise<Todo[]> {
  if (store.has(sessionId)) return store.get(sessionId)!;
  const loaded = await loadFromDisk(sessionId);
  store.set(sessionId, loaded);
  return loaded;
}

/**
 * `todo`: lightweight task list scoped per session and persisted to disk at
 * `~/.novi/todos/<sessionId>.json`. `add` appends an item, `update` changes
 * status/content by id, `list` returns the current snapshot. Each session sees
 * only its own todos. On first access the list is loaded from disk (if a
 * persisted file exists), enabling `/resume` and process restarts to retain
 * todo state.
 */
export function createTodoTool(sessionId: string): AgentTool<typeof Parameters, TodoDetails> {
  return {
    name: "todo",
    label: "Todo",
    description: "Manage a task list (action: add|update|list).",
    parameters: Parameters,
    execute: async (_toolCallId, params) => {
      const sessionTodos = await getSessionTodos(sessionId);
      switch (params.action) {
        case "add": {
          if (!params.content) throw new Error("todo add requires `content`.");
          const todo: Todo = { id: randomUUID(), content: params.content, status: "pending" };
          sessionTodos.push(todo);
          store.set(sessionId, sessionTodos);
          await persistToDisk(sessionId, sessionTodos);
          return {
            content: [{ type: "text", text: formatList(sessionTodos) }],
            details: snapshot(sessionTodos),
          };
        }
        case "update": {
          if (!params.id) throw new Error("todo update requires `id`.");
          const todo = sessionTodos.find((t) => t.id === params.id);
          if (!todo) throw new Error(`todo "${params.id}" not found.`);
          if (params.status) todo.status = params.status;
          if (params.content !== undefined) todo.content = params.content;
          store.set(sessionId, sessionTodos);
          await persistToDisk(sessionId, sessionTodos);
          return {
            content: [{ type: "text", text: formatList(sessionTodos) }],
            details: snapshot(sessionTodos),
          };
        }
        case "list": {
          return {
            content: [{ type: "text", text: formatList(sessionTodos) }],
            details: snapshot(sessionTodos),
          };
        }
      }
    },
  };
}

/** Reset the in-memory cache and disk files. Test-only escape hatch. */
export function __resetTodoStoreForTests(): void {
  store.clear();
  try {
    rmSync(path.join(getNoviDir(), "todos"), { recursive: true, force: true });
  } catch {
    // dir doesn't exist — fine
  }
}
