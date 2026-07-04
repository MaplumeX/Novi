import { randomUUID } from "node:crypto";
import * as Type from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core/node";

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
 * Module-level singleton todo store, bucketed by sessionId.
 *
 * Scope: a single app process lifetime. Each session gets its own list; the
 * store is in-memory only and never persisted to disk.
 */
const store = new Map<string, Todo[]>();

interface TodoDetails {
  todos: Todo[];
}

function snapshot(sessionTodos: Todo[]): TodoDetails {
  return { todos: sessionTodos.map((t) => ({ ...t })) };
}

function formatList(sessionTodos: Todo[]): string {
  if (sessionTodos.length === 0) return "(no todos)";
  return sessionTodos.map((t) => `[${t.status === "in_progress" ? "x" : t.status === "done" ? "v" : " "}] ${t.id} ${t.content}`).join("\n");
}

/**
 * `todo`: lightweight in-memory task list scoped per session. `add` appends an
 * item, `update` changes status/content by id, `list` returns the current
 * snapshot. Each session sees only its own todos.
 */
export function createTodoTool(sessionId: string): AgentTool<typeof Parameters, TodoDetails> {
  return {
    name: "todo",
    label: "Todo",
    description: "Manage an in-memory task list (action: add|update|list).",
    parameters: Parameters,
    execute: async (_toolCallId, params) => {
      const sessionTodos = store.get(sessionId) ?? [];
      switch (params.action) {
        case "add": {
          if (!params.content) throw new Error("todo add requires `content`.");
          const todo: Todo = { id: randomUUID(), content: params.content, status: "pending" };
          sessionTodos.push(todo);
          store.set(sessionId, sessionTodos);
          return { content: [{ type: "text", text: formatList(sessionTodos) }], details: snapshot(sessionTodos) };
        }
        case "update": {
          if (!params.id) throw new Error("todo update requires `id`.");
          const todo = sessionTodos.find((t) => t.id === params.id);
          if (!todo) throw new Error(`todo "${params.id}" not found.`);
          if (params.status) todo.status = params.status;
          if (params.content !== undefined) todo.content = params.content;
          return { content: [{ type: "text", text: formatList(sessionTodos) }], details: snapshot(sessionTodos) };
        }
        case "list": {
          return { content: [{ type: "text", text: formatList(sessionTodos) }], details: snapshot(sessionTodos) };
        }
      }
    },
  };
}

/** Reset the singleton store. Test-only escape hatch. */
export function __resetTodoStoreForTests(): void {
  store.clear();
}