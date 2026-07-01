import { describe, expect, it } from "vitest";
import { getTool, setupEnv, writeFixture } from "./helpers.js";

describe("grep tool", () => {
  it("finds matching lines via ripgrep path", async () => {
    const { env, cwd, cleanup } = await setupEnv();
    try {
      await writeFixture(cwd, "a.txt", "foo\nbar\nbaz\n");
      await writeFixture(cwd, "sub/b.txt", "banana\n");
      const tool = getTool(env, "grep");
      const res = await tool.execute("t", { pattern: "ba[rz]" });
      const matches = (res.details as { matches: { file: string; line: number; text: string }[] }).matches;
      // ripgrep should be available in this env; either engine returns these.
      expect(matches.length).toBe(2);
      expect(matches.some((m) => m.line === 2 && m.text === "bar")).toBe(true);
      expect(matches.some((m) => m.line === 3 && m.text === "baz")).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("supports a glob filter", async () => {
    const { env, cwd, cleanup } = await setupEnv();
    try {
      await writeFixture(cwd, "a.txt", "needle\n");
      await writeFixture(cwd, "b.md", "needle\n");
      const tool = getTool(env, "grep");
      const res = await tool.execute("t", { pattern: "needle", glob: "*.md" });
      const matches = (res.details as { matches: { file: string }[] }).matches;
      expect(matches.every((m) => m.file.endsWith(".md"))).toBe(true);
      expect(matches.length).toBe(1);
    } finally {
      await cleanup();
    }
  });

  it("returns no matches cleanly", async () => {
    const { env, cwd, cleanup } = await setupEnv();
    try {
      await writeFixture(cwd, "a.txt", "alpha\n");
      const tool = getTool(env, "grep");
      const res = await tool.execute("t", { pattern: "zzz" });
      expect((res.content[0] as { text: string }).text).toBe("(no matches)");
    } finally {
      await cleanup();
    }
  });

  it("falls back to the tree scan when ripgrep is unavailable", async () => {
    const { env, cwd, cleanup } = await setupEnv();
    try {
      await writeFixture(cwd, "a.txt", "foo\nbar\n");
      // Force the fallback path by giving an invalid PATH so `rg` can't spawn.
      const fallbackEnv = new (env.constructor as typeof import("@earendil-works/pi-agent-core/node").NodeExecutionEnv)({
        cwd,
        shellEnv: { ...process.env, PATH: "/nonexistent" },
      });
      try {
        const fallbackTool = getTool(fallbackEnv, "grep");
        const res = await fallbackTool.execute("t", { pattern: "bar" });
        const matches = (res.details as { matches: { line: number; text: string }[] }).matches;
        expect(matches.length).toBe(1);
        expect(matches[0]).toMatchObject({ line: 2, text: "bar" });
      } finally {
        await fallbackEnv.cleanup();
      }
    } finally {
      await cleanup();
    }
  });
});
