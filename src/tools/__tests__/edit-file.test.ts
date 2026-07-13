import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { getTool, setupEnv, writeFixture } from "./helpers.js";
import type { AgentTool } from "@earendil-works/pi-agent-core/node";

/**
 * Simulate the harness: run `prepareArguments` (if present) then `execute`.
 * Tests call this so legacy `{path, oldText, newText}` args are converted
 * the same way the harness would.
 */
async function runEdit(
  tool: AgentTool,
  args: Record<string, unknown>,
): Promise<Awaited<ReturnType<AgentTool["execute"]>>> {
  const prepared = tool.prepareArguments ? tool.prepareArguments(args) : args;
  return tool.execute("t", prepared);
}

describe("edit_file tool", () => {
  it("replaces the single unique occurrence (legacy form)", async () => {
    const { env, cwd, cleanup } = await setupEnv();
    try {
      const file = await writeFixture(cwd, "e.txt", "alpha\nbeta\nalpha-done\n");
      const tool = getTool(env, "edit_file");
      const res = await runEdit(tool, { path: file, oldText: "beta", newText: "BETA" });
      expect(res.details).toMatchObject({ replaced: 1 });
      const read = await getTool(env, "read_file").execute("t", { path: file });
      expect((read.content[0] as { text: string }).text).toBe("alpha\nBETA\nalpha-done\n");
    } finally {
      await cleanup();
    }
  });

  it("throws when oldText is not found (legacy form)", async () => {
    const { env, cwd, cleanup } = await setupEnv();
    try {
      const file = await writeFixture(cwd, "e.txt", "hello\n");
      const tool = getTool(env, "edit_file");
      await expect(runEdit(tool, { path: file, oldText: "missing", newText: "x" })).rejects.toThrow(
        /not found/,
      );
    } finally {
      await cleanup();
    }
  });

  it("throws when oldText matches more than once (legacy form)", async () => {
    const { env, cwd, cleanup } = await setupEnv();
    try {
      const file = await writeFixture(cwd, "e.txt", "dup\ndup\n");
      const tool = getTool(env, "edit_file");
      await expect(runEdit(tool, { path: file, oldText: "dup", newText: "x" })).rejects.toThrow(
        /matches 2 times/,
      );
    } finally {
      await cleanup();
    }
  });

  it("applies multiple edits in one call", async () => {
    const { env, cwd, cleanup } = await setupEnv();
    try {
      const file = await writeFixture(cwd, "e.txt", "alpha\nbeta\ngamma\n");
      const tool = getTool(env, "edit_file");
      const res = await runEdit(tool, {
        path: file,
        edits: [
          { oldText: "alpha", newText: "ALPHA" },
          { oldText: "gamma", newText: "GAMMA" },
        ],
      });
      expect(res.details).toMatchObject({ replaced: 2 });
      const read = await getTool(env, "read_file").execute("t", { path: file });
      expect((read.content[0] as { text: string }).text).toBe("ALPHA\nbeta\nGAMMA\n");
    } finally {
      await cleanup();
    }
  });

  it("atomicity: file unchanged when one edit in a multi-edit call is not found", async () => {
    const { env, cwd, cleanup } = await setupEnv();
    try {
      const original = "alpha\nbeta\ngamma\n";
      const file = await writeFixture(cwd, "e.txt", original);
      const tool = getTool(env, "edit_file");
      await expect(
        runEdit(tool, {
          path: file,
          edits: [
            { oldText: "alpha", newText: "ALPHA" },
            { oldText: "missing", newText: "X" },
          ],
        }),
      ).rejects.toThrow(/edits\[1\].*not found/);
      // File must be unchanged.
      const after = await readFile(file, "utf8");
      expect(after).toBe(original);
    } finally {
      await cleanup();
    }
  });

  it("throws with edits[i] reference when one edit in a multi-edit call is not unique", async () => {
    const { env, cwd, cleanup } = await setupEnv();
    try {
      const original = "dup\ndup\nunique\n";
      const file = await writeFixture(cwd, "e.txt", original);
      const tool = getTool(env, "edit_file");
      await expect(
        runEdit(tool, {
          path: file,
          edits: [
            { oldText: "unique", newText: "U" },
            { oldText: "dup", newText: "D" },
          ],
        }),
      ).rejects.toThrow(/edits\[1\].*matches 2 times/);
      // File must be unchanged.
      const after = await readFile(file, "utf8");
      expect(after).toBe(original);
    } finally {
      await cleanup();
    }
  });

  it("rejects overlapping edits", async () => {
    const { env, cwd, cleanup } = await setupEnv();
    try {
      const original = "abcdef\n";
      const file = await writeFixture(cwd, "e.txt", original);
      const tool = getTool(env, "edit_file");
      await expect(
        runEdit(tool, {
          path: file,
          edits: [
            { oldText: "abc", newText: "X" },
            { oldText: "cde", newText: "Y" },
          ],
        }),
      ).rejects.toThrow(/overlap/);
      const after = await readFile(file, "utf8");
      expect(after).toBe(original);
    } finally {
      await cleanup();
    }
  });

  it("handles edits passed as a JSON string", async () => {
    const { env, cwd, cleanup } = await setupEnv();
    try {
      const file = await writeFixture(cwd, "e.txt", "alpha\nbeta\n");
      const tool = getTool(env, "edit_file");
      const res = await runEdit(tool, {
        path: file,
        edits: JSON.stringify([
          { oldText: "alpha", newText: "ALPHA" },
          { oldText: "beta", newText: "BETA" },
        ]),
      });
      expect(res.details).toMatchObject({ replaced: 2 });
      const read = await getTool(env, "read_file").execute("t", { path: file });
      expect((read.content[0] as { text: string }).text).toBe("ALPHA\nBETA\n");
    } finally {
      await cleanup();
    }
  });

  it("throws when edits array is empty", async () => {
    const { env, cwd, cleanup } = await setupEnv();
    try {
      const file = await writeFixture(cwd, "e.txt", "hello\n");
      const tool = getTool(env, "edit_file");
      await expect(runEdit(tool, { path: file, edits: [] })).rejects.toThrow(
        /at least one replacement/,
      );
    } finally {
      await cleanup();
    }
  });
});
