import { describe, expect, it } from "vitest";
import { getTool, setupEnv, writeFixture } from "./helpers.js";

describe("read_file tool", () => {
  it("reads a file and returns its text", async () => {
    const { env, cwd, cleanup } = await setupEnv();
    try {
      const file = await writeFixture(cwd, "a.txt", "hello\nworld\n");
      const tool = getTool(env, "read_file");
      const res = await tool.execute("t", { path: file });
      expect(res.content[0]).toEqual({ type: "text", text: "hello\nworld\n" });
      expect(res.details).toMatchObject({ path: file });
    } finally {
      await cleanup();
    }
  });

  it("slices by 1-based offset/limit", async () => {
    const { env, cwd, cleanup } = await setupEnv();
    try {
      const file = await writeFixture(cwd, "lines.txt", "one\ntwo\nthree\nfour\nfive\n");
      const tool = getTool(env, "read_file");
      const res = await tool.execute("t", { path: file, offset: 2, limit: 2 });
      expect((res.content[0] as { text: string }).text).toBe("two\nthree");
    } finally {
      await cleanup();
    }
  });

  it("throws when the file does not exist", async () => {
    const { env, cleanup } = await setupEnv();
    try {
      const tool = getTool(env, "read_file");
      await expect(tool.execute("t", { path: "nope.txt" })).rejects.toThrow(/read_file failed/);
    } finally {
      await cleanup();
    }
  });
});
