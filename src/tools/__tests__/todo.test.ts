import { beforeEach, describe, expect, it } from "vitest";
import { getTool, resetSharedState, setupEnv } from "./helpers.js";

describe("todo tool", () => {
  beforeEach(() => resetSharedState());

  it("adds items and lists them", async () => {
    const { env, cleanup } = await setupEnv();
    try {
      const tool = getTool(env, "todo");
      const add1 = await tool.execute("t", { action: "add", content: "first" });
      expect((add1.details as { todos: { content: string; status: string }[] }).todos).toHaveLength(1);
      await tool.execute("t", { action: "add", content: "second" });
      const list = await tool.execute("t", { action: "list" });
      const todos = (list.details as { todos: { content: string }[] }).todos;
      expect(todos.map((t) => t.content)).toEqual(["first", "second"]);
    } finally {
      await cleanup();
    }
  });

  it("updates status by id", async () => {
    const { env, cleanup } = await setupEnv();
    try {
      const tool = getTool(env, "todo");
      const added = await tool.execute("t", { action: "add", content: "task" });
      const id = (added.details as { todos: { id: string }[] }).todos[0].id;
      const updated = await tool.execute("t", { action: "update", id, status: "done" });
      const todo = (updated.details as { todos: { status: string }[] }).todos[0];
      expect(todo.status).toBe("done");
    } finally {
      await cleanup();
    }
  });

  it("throws when add lacks content", async () => {
    const { env, cleanup } = await setupEnv();
    try {
      const tool = getTool(env, "todo");
      await expect(tool.execute("t", { action: "add" })).rejects.toThrow(/content/);
    } finally {
      await cleanup();
    }
  });

  it("throws when updating an unknown id", async () => {
    const { env, cleanup } = await setupEnv();
    try {
      const tool = getTool(env, "todo");
      await expect(
        tool.execute("t", { action: "update", id: "nope", status: "done" }),
      ).rejects.toThrow(/not found/);
    } finally {
      await cleanup();
    }
  });
});
