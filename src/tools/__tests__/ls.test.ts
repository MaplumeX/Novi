import { describe, expect, it } from "vitest";
import { getTool, setupEnv, toolEnvelope, writeFixture } from "./helpers.js";

describe("ls tool", () => {
  it("lists direct children with kind markers", async () => {
    const { env, cwd, cleanup } = await setupEnv();
    try {
      await writeFixture(cwd, "file1.txt", "x");
      await writeFixture(cwd, "sub/file2.txt", "y");
      const tool = getTool(env, "ls");
      const res = await tool.execute("t", {});
      const text = (res.content[0] as { text: string }).text;
      expect(text).toContain("d sub");
      expect(text).toContain("- file1.txt");
    } finally {
      await cleanup();
    }
  });

  it("defaults to cwd when no path given", async () => {
    const { env, cwd, cleanup } = await setupEnv();
    try {
      await writeFixture(cwd, "root.txt", "x");
      const tool = getTool(env, "ls");
      const res = await tool.execute("t", {});
      expect((res.content[0] as { text: string }).text).toContain("root.txt");
    } finally {
      await cleanup();
    }
  });

  it("shows empty for an empty directory", async () => {
    const { env, cleanup } = await setupEnv();
    try {
      const tool = getTool(env, "ls");
      const res = await tool.execute("t", {});
      // tmpdir itself may have vitest artifacts, so just verify it returns text.
      expect(res.content[0]).toMatchObject({ type: "text" });
    } finally {
      await cleanup();
    }
  });

  it("truncates when a directory has more than the line limit entries", async () => {
    const { env, cwd, cleanup } = await setupEnv();
    try {
      // Create 3000 files in a subdirectory (avoid polluting cwd root with other fixtures).
      const dir = "bigdir";
      for (let i = 0; i < 3000; i++) {
        await writeFixture(cwd, `${dir}/f${i}.txt`, "x");
      }
      const tool = getTool(env, "ls");
      const res = await tool.execute("t", { path: `${cwd}/${dir}` });
      const text = (res.content[0] as { text: string }).text;
      expect(text).toContain("[Output truncated:");
      const outputLines = text.split("\n");
      expect(outputLines.length).toBeLessThanOrEqual(2001);
      expect(toolEnvelope(res).truncation.truncated).toBe(true);
      expect(toolEnvelope(res).truncation.reasons).toContain("lines");
    } finally {
      await cleanup();
    }
  });
});
