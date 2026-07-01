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
 * Module-level singleton todo list.
 *
 * Scope: a single app process lifetime. The tool `execute` API does not expose a
 * sessionId, and the acceptance bar is "state persists across turns within the
 * same session" — a process-wide single list satisfies that. It is NOT safe for
 * multi-session isolation.
 */
const store: Todo[] = [];

interface TodoDetails {
  todos: Todo[];
}

function snapshot(): TodoDetails {
  return { todos: store.map((t) => ({ ...t })) };
}

function formatList(): string {
  if (store.length === 0) return "(no todos)";
  return store.map((t) => `[${t.status === "in_progress" ? "x" : t.status === "done" ? "v" : " "}] ${t.id} ${t.content}`).join("\n");
}

/**
 * `todo`: lightweight in-memory task list. `add` appends an item, `update`
 * changes status/content by id, `list` returns the current snapshot.
 */
export function createTodoTool(): AgentTool<typeof Parameters, TodoDetails> {
  return {
    name: "todo",
    label: "Todo",
    description: "Manage an in-memory task list (action: add|update|list).",
    parameters: Parameters,
    execute: async (_toolCallId, params) => {
      switch (params.action) {
        case "add": {
          if (!params.content) throw new Error("todo add requires `content`.");
          const todo: Todo = { id: randomUUID(), content: params.content, status: "pending" };
          store.push(todo);
          return { content: [{ type: "text", text: formatList() }], details: snapshot() };
        }
        case "update": {
          if (!params.id) throw new Error("todo update requires `id`.");
          const todo = store.find((t) => t.id === params.id);
          if (!todo) throw new Error(`todo "${params.id}" not found.`);
          if (params.status) todo.status = params.status;
          if (params.content !== undefined) todo.content = params.content;
          return { content: [{ type: "text", text: formatList() }], details: snapshot() };
        }
        case "list": {
          return { content: [{ type: "text", text: formatList() }], details: snapshot() };
        }
      }
    },
  };
}

/** Reset the singleton store. Test-only escape hatch. */
export function __resetTodoStoreForTests(): void {
  store.length = 0;
}
