import { describe, expect, it } from "vitest";
import { getTool, setupEnv, writeFixture } from "./helpers.js";
import { mkdir, symlink } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_TOOL_EXECUTION_BUDGET } from "../runtime/budget.js";

describe("glob tool", () => {
  it("matches files by extension pattern", async () => {
    const { env, cwd, cleanup } = await setupEnv();
    try {
      await writeFixture(cwd, "a.ts", "x");
      await writeFixture(cwd, "b.js", "y");
      await writeFixture(cwd, "src/c.ts", "z");
      const tool = getTool(env, "glob");
      const res = await tool.execute("t", { pattern: "**/*.ts" });
      const matches = (res.details as { matches: string[] }).matches.sort();
      expect(matches).toEqual(["a.ts", "src/c.ts"]);
    } finally {
      await cleanup();
    }
  });

  it("returns no matches", async () => {
    const { env, cwd, cleanup } = await setupEnv();
    try {
      await writeFixture(cwd, "a.txt", "x");
      const tool = getTool(env, "glob");
      const res = await tool.execute("t", { pattern: "**/*.nope" });
      expect((res.content[0] as { text: string }).text).toBe("(no matches)");
      expect((res.details as { count: number }).count).toBe(0);
    } finally {
      await cleanup();
    }
  });

  it("truncates when matching more than the line limit", async () => {
    const { env, cwd, cleanup } = await setupEnv();
    try {
      // Create 3000 files.
      for (let i = 0; i < 3000; i++) {
        await writeFixture(cwd, `f${i}.txt`, "x");
      }
      const tool = getTool(env, "glob");
      const res = await tool.execute("t", { pattern: "**/*.txt" });
      const text = (res.content[0] as { text: string }).text;
      expect(text).toContain("[Output truncated:");
      const outputLines = text.split("\n");
      expect(outputLines.length).toBeLessThanOrEqual(2001);
      const resource = (
        res.details as { resource: { truncated: boolean; truncationReasons: string[] } }
      ).resource;
      expect(resource.truncated).toBe(true);
      expect(resource.truncationReasons).toContain("lines");
    } finally {
      await cleanup();
    }
  });

  it("stops deterministically at result limits and honors ignores/symlinks", async () => {
    const { env, cwd, cleanup } = await setupEnv();
    try {
      await writeFixture(cwd, "a.txt", "a");
      await writeFixture(cwd, "b.txt", "b");
      await writeFixture(cwd, "c.txt", "c");
      await writeFixture(cwd, "node_modules/ignored.txt", "ignored");
      const external = path.join(cwd, "external");
      await mkdir(external);
      await writeFixture(external, "escaped.txt", "escaped");
      await symlink(external, path.join(cwd, "link"));
      const tool = getTool(env, "glob", "bounded", {
        budget: { ...DEFAULT_TOOL_EXECUTION_BUDGET, resultCount: 2 },
      });
      const res = await tool.execute("t", { pattern: "**/*.txt" });
      expect((res.details as { matches: string[] }).matches).toEqual(["a.txt", "b.txt"]);
      expect((res.details as { traversal: { reason: string } }).traversal.reason).toBe(
        "result_limit",
      );
    } finally {
      await cleanup();
    }
  });
});
