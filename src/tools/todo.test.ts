import { mkdir, writeFile, mkdtemp, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTodoTool, __resetTodoStoreForTests } from "./todo.js";

let mockedNoviDir = "";
vi.mock("../config.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return { ...actual, getNoviDir: () => mockedNoviDir };
});

function todoFile(sessionId: string): string {
  return path.join(mockedNoviDir, "todos", `${sessionId}.json`);
}

describe("todo tool", () => {
  beforeEach(async () => {
    mockedNoviDir = await mkdtemp(path.join(tmpdir(), "novi-todo-"));
  });

  afterEach(() => {
    __resetTodoStoreForTests();
    mockedNoviDir = "";
  });

  it("adds items and lists them", async () => {
    const tool = createTodoTool("test-session");
    const add1 = await tool.execute("t", { action: "add", content: "first" });
    expect((add1.details as { todos: { content: string; status: string }[] }).todos).toHaveLength(
      1,
    );
    await tool.execute("t", { action: "add", content: "second" });
    const list = await tool.execute("t", { action: "list" });
    const todos = (list.details as { todos: { content: string }[] }).todos;
    expect(todos.map((t) => t.content)).toEqual(["first", "second"]);
  });

  it("updates status by id", async () => {
    const tool = createTodoTool("test-session");
    const added = await tool.execute("t", { action: "add", content: "task" });
    const id = (added.details as { todos: { id: string }[] }).todos[0].id;
    const updated = await tool.execute("t", { action: "update", id, status: "done" });
    const todo = (updated.details as { todos: { status: string }[] }).todos[0];
    expect(todo.status).toBe("done");
  });

  it("throws when add lacks content", async () => {
    const tool = createTodoTool("test-session");
    await expect(tool.execute("t", { action: "add" })).rejects.toThrow(/content/);
  });

  it("throws when updating an unknown id", async () => {
    const tool = createTodoTool("test-session");
    await expect(
      tool.execute("t", { action: "update", id: "nope", status: "done" }),
    ).rejects.toThrow(/not found/);
  });

  it("isolates todos per sessionId", async () => {
    const toolA = createTodoTool("session-a");
    const toolB = createTodoTool("session-b");

    await toolA.execute("t", { action: "add", content: "task A" });

    const listB = await toolB.execute("t", { action: "list" });
    const todosB = (listB.details as { todos: { content: string }[] }).todos;
    expect(todosB).toEqual([]);

    const listA = await toolA.execute("t", { action: "list" });
    const todosA = (listA.details as { todos: { content: string }[] }).todos;
    expect(todosA.map((t) => t.content)).toEqual(["task A"]);

    await toolB.execute("t", { action: "add", content: "task B" });
    const listA2 = await toolA.execute("t", { action: "list" });
    const todosA2 = (listA2.details as { todos: { content: string }[] }).todos;
    expect(todosA2.map((t) => t.content)).toEqual(["task A"]);
  });

  describe("persistence", () => {
    it("writes a file to disk after add", async () => {
      const tool = createTodoTool("persist-session");
      await tool.execute("t", { action: "add", content: "persisted task" });

      const file = todoFile("persist-session");
      expect(existsSync(file)).toBe(true);
      const raw = await readFile(file, "utf-8");
      const parsed = JSON.parse(raw) as { content: string; status: string }[];
      expect(parsed).toHaveLength(1);
      expect(parsed[0].content).toBe("persisted task");
      expect(parsed[0].status).toBe("pending");
    });

    it("updates the file after update", async () => {
      const tool = createTodoTool("persist-session");
      const added = await tool.execute("t", { action: "add", content: "task" });
      const id = (added.details as { todos: { id: string }[] }).todos[0].id;

      await tool.execute("t", { action: "update", id, status: "done" });

      const raw = await readFile(todoFile("persist-session"), "utf-8");
      const parsed = JSON.parse(raw) as { id: string; status: string }[];
      expect(parsed[0].status).toBe("done");
    });

    it("corrupt JSON file yields empty list, no throw, and logs a warning", async () => {
      const sessionId = "corrupt-session";
      const dir = path.join(mockedNoviDir, "todos");
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, `${sessionId}.json`), "{ not valid json");

      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        const tool = createTodoTool(sessionId);
        const list = await tool.execute("t", { action: "list" });
        const todos = (list.details as { todos: unknown[] }).todos;
        expect(todos).toEqual([]);
        expect(stderrSpy).toHaveBeenCalledWith(
          expect.stringContaining(`warning: todo load failed for session ${sessionId}`),
        );
      } finally {
        stderrSpy.mockRestore();
      }
    });

    it("new session (no file) loads empty list without warning", async () => {
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        const tool = createTodoTool("brand-new-session");
        const list = await tool.execute("t", { action: "list" });
        const todos = (list.details as { todos: unknown[] }).todos;
        expect(todos).toEqual([]);
        expect(stderrSpy).not.toHaveBeenCalledWith(expect.stringContaining("todo load failed"));
      } finally {
        stderrSpy.mockRestore();
      }
    });

    it("/resume: new process with same sessionId sees persisted todos", async () => {
      const sessionId = "resume-session";
      const tool1 = createTodoTool(sessionId);
      await tool1.execute("t", { action: "add", content: "resume task 1" });
      await tool1.execute("t", { action: "add", content: "resume task 2" });

      // Verify the file was written.
      expect(existsSync(todoFile(sessionId))).toBe(true);

      // Simulate a new process: reset modules to clear the in-memory store,
      // re-register the config mock, then re-import the todo module.
      vi.resetModules();
      vi.doMock("../config.js", () => ({ getNoviDir: () => mockedNoviDir }));
      const { createTodoTool: createTodoToolFresh } = await import("./todo.js");
      const tool2 = createTodoToolFresh(sessionId);

      const list = await tool2.execute("t", { action: "list" });
      const todos = (list.details as { todos: { content: string }[] }).todos;
      expect(todos.map((t) => t.content)).toEqual(["resume task 1", "resume task 2"]);
    });

    it("update after /resume mutates the persisted file", async () => {
      const sessionId = "update-resume-session";
      const tool1 = createTodoTool(sessionId);
      const added = await tool1.execute("t", { action: "add", content: "to update" });
      const id = (added.details as { todos: { id: string }[] }).todos[0].id;

      vi.resetModules();
      vi.doMock("../config.js", () => ({ getNoviDir: () => mockedNoviDir }));
      const { createTodoTool: createTool2 } = await import("./todo.js");
      const tool2 = createTool2(sessionId);

      await tool2.execute("t", { action: "update", id, status: "done" });

      const raw = await readFile(todoFile(sessionId), "utf-8");
      const parsed = JSON.parse(raw) as { id: string; status: string }[];
      expect(parsed[0].status).toBe("done");
    });
  });
});
