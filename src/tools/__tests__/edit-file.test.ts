import { describe, expect, it } from "vitest";
import { getTool, setupEnv, writeFixture } from "./helpers.js";

describe("edit_file tool", () => {
  it("replaces the single unique occurrence", async () => {
    const { env, cwd, cleanup } = await setupEnv();
    try {
      const file = await writeFixture(cwd, "e.txt", "alpha\nbeta\nalpha-done\n");
      const tool = getTool(env, "edit_file");
      const res = await tool.execute("t", { path: file, oldText: "beta", newText: "BETA" });
      expect(res.details).toMatchObject({ replaced: 1 });
      const read = await getTool(env, "read_file").execute("t", { path: file });
      expect((read.content[0] as { text: string }).text).toBe("alpha\nBETA\nalpha-done\n");
    } finally {
      await cleanup();
    }
  });

  it("throws when oldText is not found", async () => {
    const { env, cwd, cleanup } = await setupEnv();
    try {
      const file = await writeFixture(cwd, "e.txt", "hello\n");
      const tool = getTool(env, "edit_file");
      await expect(
        tool.execute("t", { path: file, oldText: "missing", newText: "x" }),
      ).rejects.toThrow(/not found/);
    } finally {
      await cleanup();
    }
  });

  it("throws when oldText matches more than once", async () => {
    const { env, cwd, cleanup } = await setupEnv();
    try {
      const file = await writeFixture(cwd, "e.txt", "dup\ndup\n");
      const tool = getTool(env, "edit_file");
      await expect(
        tool.execute("t", { path: file, oldText: "dup", newText: "x" }),
      ).rejects.toThrow(/matches 2 times/);
    } finally {
      await cleanup();
    }
  });
});
