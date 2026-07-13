import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { envelopeData, getTool, setupEnv, writeFixture } from "./helpers.js";
import type { AgentTool } from "@earendil-works/pi-agent-core/node";

async function runEdit(
  tool: AgentTool,
  args: Record<string, unknown>,
): Promise<Awaited<ReturnType<AgentTool["execute"]>>> {
  return tool.execute("t", args);
}

describe("edit_file tool", () => {
  it("replaces the single unique occurrence", async () => {
    const { env, cwd, cleanup } = await setupEnv();
    try {
      const file = await writeFixture(cwd, "e.txt", "alpha\nbeta\nalpha-done\n");
      const tool = getTool(env, "edit_file");
      const res = await runEdit(tool, {
        path: file,
        edits: [{ oldText: "beta", newText: "BETA" }],
      });
      expect(envelopeData(res)).toMatchObject({ replaced: 1 });
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
        runEdit(tool, { path: file, edits: [{ oldText: "missing", newText: "x" }] }),
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
        runEdit(tool, { path: file, edits: [{ oldText: "dup", newText: "x" }] }),
      ).rejects.toThrow(/matches 2 times/);
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
      expect(envelopeData(res)).toMatchObject({ replaced: 2 });
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
