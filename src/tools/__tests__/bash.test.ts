import { describe, expect, it, vi } from "vitest";
import { getTool, setupEnv } from "./helpers.js";

describe("bash tool", () => {
  it("returns stdout on success", async () => {
    const { env, cleanup } = await setupEnv();
    try {
      const tool = getTool(env, "bash");
      const res = await tool.execute("t", { command: "echo hello" });
      expect((res.content[0] as { text: string }).text).toContain("hello");
      expect(res.details).toMatchObject({ exitCode: 0, stdout: "hello\n" });
    } finally {
      await cleanup();
    }
  });

  it("throws on non-zero exit code", async () => {
    const { env, cleanup } = await setupEnv();
    try {
      const tool = getTool(env, "bash");
      await expect(tool.execute("t", { command: "exit 7" })).rejects.toThrow(/code 7/);
    } finally {
      await cleanup();
    }
  });

  it("truncates output exceeding the line limit (tail)", async () => {
    const { env, cleanup } = await setupEnv();
    try {
      const tool = getTool(env, "bash");
      // Generate 3000 lines.
      const res = await tool.execute("t", { command: "seq 1 3000" });
      const text = (res.content[0] as { text: string }).text;
      const lines = text.split("\n");
      // Body includes `exit 0` prefix + 3000 output lines → truncated to 2000.
      // Plus the footer line.
      expect(lines.length).toBeLessThanOrEqual(2001);
      expect(text).toContain("[Output truncated:");
      // Tail truncation: the last output line (3000) should be preserved.
      expect(text).toContain("3000");
      const truncation = (res.details as { truncation: { truncated: boolean } }).truncation;
      expect(truncation.truncated).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("truncates output exceeding the byte limit (tail)", async () => {
    const { env, cleanup } = await setupEnv();
    try {
      const tool = getTool(env, "bash");
      // Generate a large output exceeding 50KB but staying under 2000 lines,
      // so the byte limit is the one that triggers.
      const res = await tool.execute("t", {
        command:
          "yes 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' | head -1000",
      });
      const text = (res.content[0] as { text: string }).text;
      expect(text).toContain("[Output truncated:");
      expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(60000);
      const truncation = (res.details as { truncation: { truncatedBy: string } }).truncation;
      expect(truncation.truncatedBy).toBe("bytes");
    } finally {
      await cleanup();
    }
  });

  it("streams partial output via onUpdate callback", async () => {
    const { env, cleanup } = await setupEnv();
    try {
      const tool = getTool(env, "bash");
      const onUpdate = vi.fn();
      await tool.execute("t", { command: "echo a; sleep 0.1; echo b" }, undefined, onUpdate);
      expect(onUpdate).toHaveBeenCalled();
      // At least one partial update should contain output seen so far.
      const calls = onUpdate.mock.calls;
      const partials = calls.map((c) => (c[0].content[0] as { text: string }).text);
      // The first update should at least contain "a"; a later one should contain "b".
      expect(partials.some((t) => t.includes("a"))).toBe(true);
      expect(partials.some((t) => t.includes("b"))).toBe(true);
      // All partials should have streaming details.
      for (const c of calls) {
        expect(c[0].details).toMatchObject({ exitCode: null, streaming: true });
      }
    } finally {
      await cleanup();
    }
  });

  it("works without onUpdate callback", async () => {
    const { env, cleanup } = await setupEnv();
    try {
      const tool = getTool(env, "bash");
      const res = await tool.execute("t", { command: "echo hello" }, undefined);
      expect((res.content[0] as { text: string }).text).toContain("hello");
    } finally {
      await cleanup();
    }
  });

  it("applies default 120s timeout when timeout param omitted", async () => {
    const { env, cleanup } = await setupEnv();
    try {
      const tool = getTool(env, "bash");
      const execSpy = vi.spyOn(env, "exec");
      await tool.execute("t", { command: "echo hello" }, undefined);
      expect(execSpy).toHaveBeenCalledOnce();
      const opts = execSpy.mock.calls[0][1];
      expect(opts?.timeout).toBe(120_000);
    } finally {
      await cleanup();
    }
  });

  it("forwards explicit timeout param", async () => {
    const { env, cleanup } = await setupEnv();
    try {
      const tool = getTool(env, "bash");
      const execSpy = vi.spyOn(env, "exec");
      await tool.execute("t", { command: "echo hello", timeout: 500 }, undefined);
      expect(execSpy).toHaveBeenCalledOnce();
      const opts = execSpy.mock.calls[0][1];
      expect(opts?.timeout).toBe(500);
    } finally {
      await cleanup();
    }
  });

  it("final result contains full stdout/stderr", async () => {
    const { env, cleanup } = await setupEnv();
    try {
      const tool = getTool(env, "bash");
      const onUpdate = vi.fn();
      const res = await tool.execute(
        "t",
        { command: "echo out; echo err 1>&2" },
        undefined,
        onUpdate,
      );
      const text = (res.content[0] as { text: string }).text;
      expect(text).toContain("out");
      expect(text).toContain("err");
      expect(res.details).toMatchObject({ exitCode: 0, stdout: "out\n", stderr: "err\n" });
      // Final details should not have streaming flag.
      expect((res.details as { streaming?: boolean }).streaming).toBeUndefined();
    } finally {
      await cleanup();
    }
  });
});
