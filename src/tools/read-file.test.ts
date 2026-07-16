import { describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { envelopeData, getTool, setupEnv, toolEnvelope, writeFixture } from "./test-helpers.js";

describe("read_file tool", () => {
  it("reads a file and returns its text", async () => {
    const { env, cwd, cleanup } = await setupEnv();
    try {
      const file = await writeFixture(cwd, "a.txt", "hello\nworld\n");
      const tool = getTool(env, "read_file");
      const res = await tool.execute("t", { path: file });
      expect(res.content[0]).toEqual({ type: "text", text: "hello\nworld\n" });
      expect(envelopeData(res)).toMatchObject({ path: file });
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
      expect((res.content[0] as { text: string }).text).toBe("two\nthree\n");
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

  it("truncates a file exceeding the line limit when no limit is given", async () => {
    const { env, cwd, cleanup } = await setupEnv();
    try {
      const lines = Array.from({ length: 3000 }, (_, i) => `line${i}`);
      const file = await writeFixture(cwd, "big.txt", lines.join("\n"));
      const tool = getTool(env, "read_file");
      const res = await tool.execute("t", { path: file });
      const text = (res.content[0] as { text: string }).text;
      const outputLines = text.split("\n");
      // Truncated to 2000 lines + footer.
      expect(outputLines.length).toBeLessThanOrEqual(2001);
      expect(text).toContain("[Output truncated:");
      // Head truncation: first line preserved.
      expect(outputLines[0]).toBe("line0");
      expect(toolEnvelope(res).truncation.truncated).toBe(true);
      expect(toolEnvelope(res).truncation.reasons).toContain("lines");
    } finally {
      await cleanup();
    }
  });

  it("does not truncate when limit is under the line cap", async () => {
    const { env, cwd, cleanup } = await setupEnv();
    try {
      const lines = Array.from({ length: 3000 }, (_, i) => `line${i}`);
      const file = await writeFixture(cwd, "big2.txt", lines.join("\n"));
      const tool = getTool(env, "read_file");
      const res = await tool.execute("t", { path: file, limit: 10 });
      const text = (res.content[0] as { text: string }).text;
      expect(text).not.toContain("[Output truncated:");
      expect(toolEnvelope(res).truncation.truncated).toBe(false);
    } finally {
      await cleanup();
    }
  });
});

describe("read_file cache", () => {
  it("returns fresh content on first read (cache miss)", async () => {
    const { env, cwd, cleanup } = await setupEnv();
    try {
      const file = await writeFixture(cwd, "c.txt", "hello\n");
      const tool = getTool(env, "read_file");
      const res = await tool.execute("t", { path: file });
      expect((res.content[0] as { text: string }).text).toBe("hello\n");
      expect(envelopeData(res).cache).toBe("miss");
    } finally {
      await cleanup();
    }
  });

  it("returns hint on second read of unchanged file (cache hit)", async () => {
    const { env, cwd, cleanup } = await setupEnv();
    try {
      const file = await writeFixture(cwd, "c.txt", "hello\n");
      const tool = getTool(env, "read_file");
      // First read: miss, returns content.
      await tool.execute("t", { path: file });
      // Second read: hit, returns hint.
      const res = await tool.execute("t", { path: file });
      const text = (res.content[0] as { text: string }).text;
      expect(text).toContain("[cached]");
      expect(text).toContain(file);
      expect(envelopeData(res).cache).toBe("hit");
    } finally {
      await cleanup();
    }
  });

  it("returns fresh content after external modification (stat mismatch)", async () => {
    const { env, cwd, cleanup } = await setupEnv();
    try {
      const file = await writeFixture(cwd, "c.txt", "hello\n");
      const tool = getTool(env, "read_file");
      await tool.execute("t", { path: file });
      // Externally modify the file (change content + mtime).
      await new Promise((r) => setTimeout(r, 10));
      await writeFile(file, "changed\n", "utf8");
      const res = await tool.execute("t", { path: file });
      expect((res.content[0] as { text: string }).text).toBe("changed\n");
      expect(envelopeData(res).cache).toBe("miss");
    } finally {
      await cleanup();
    }
  });

  it("caches different offset/limit ranges independently", async () => {
    const { env, cwd, cleanup } = await setupEnv();
    try {
      const file = await writeFixture(cwd, "c.txt", "one\ntwo\nthree\nfour\n");
      const tool = getTool(env, "read_file");
      // Read offset=1, limit=2
      const r1 = await tool.execute("t", { path: file, offset: 1, limit: 2 });
      expect(envelopeData(r1).cache).toBe("miss");
      // Read offset=3, limit=2 — different key, should miss
      const r2 = await tool.execute("t", { path: file, offset: 3, limit: 2 });
      expect(envelopeData(r2).cache).toBe("miss");
      expect((r2.content[0] as { text: string }).text).toBe("three\nfour\n");
      // Re-read offset=1, limit=2 — should hit
      const r3 = await tool.execute("t", { path: file, offset: 1, limit: 2 });
      expect(envelopeData(r3).cache).toBe("hit");
    } finally {
      await cleanup();
    }
  });
});
