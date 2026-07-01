import { describe, expect, it } from "vitest";
import { getTool, setupEnv, writeFixture } from "./helpers.js";

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
});
