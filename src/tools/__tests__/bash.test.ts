import { describe, expect, it, vi } from "vitest";
import { getTool, setupEnv } from "./helpers.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_TOOL_EXECUTION_BUDGET } from "../runtime/budget.js";

describe("bash tool", () => {
  it("returns stdout on success", async () => {
    const { env, cleanup } = await setupEnv();
    try {
      const tool = getTool(env, "bash");
      const res = await tool.execute("t", { command: "echo hello" });
      expect((res.content[0] as { text: string }).text).toContain("hello");
      expect(res.details).toMatchObject({ exitCode: 0, resourceGoverned: true });
      expect(res.details).not.toHaveProperty("stdout");
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
      const resource = (res.details as { resource: { truncated: boolean } }).resource;
      expect(resource.truncated).toBe(true);
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
      const resource = (res.details as { resource: { truncationReasons: string[] } }).resource;
      expect(resource.truncationReasons).toContain("bytes");
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
        expect(c[0].details).toMatchObject({ streaming: true, delta: true });
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
      const result = await tool.execute("t", { command: "echo hello" }, undefined);
      expect(result.details).toMatchObject({ timeoutMs: 120_000 });
    } finally {
      await cleanup();
    }
  });

  it("forwards explicit timeout param", async () => {
    const { env, cleanup } = await setupEnv();
    try {
      const tool = getTool(env, "bash");
      const result = await tool.execute("t", { command: "echo hello", timeout: 500 }, undefined);
      expect(result.details).toMatchObject({ timeoutMs: 500 });
    } finally {
      await cleanup();
    }
  });

  it("final result contains bounded stdout/stderr without duplicating them in details", async () => {
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
      expect(res.details).toMatchObject({ exitCode: 0, resourceGoverned: true });
      expect(res.details).not.toHaveProperty("stdout");
      expect(res.details).not.toHaveProperty("stderr");
      // Final details should not have streaming flag.
      expect((res.details as { streaming?: boolean }).streaming).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  it("keeps multi-megabyte output bounded and persists the exact artifact", async () => {
    const { env, cleanup } = await setupEnv();
    const artifactRoot = await mkdtemp(path.join(tmpdir(), "novi-bash-artifact-"));
    try {
      const budget = {
        ...DEFAULT_TOOL_EXECUTION_BUDGET,
        modelBytes: 1024,
        modelLines: 100,
        memoryBytes: 4096,
        partialBytes: 1024,
        partialUpdatesPerSecond: 100,
      };
      const tool = getTool(env, "bash", "large-output", {
        budget,
        artifactsEnabled: true,
        artifactRoot,
      });
      const updates: Array<{ content: Array<{ type: string; text?: string }> }> = [];
      const res = await tool.execute(
        "large-call",
        { command: "head -c 2097152 /dev/zero | tr '\\0' x" },
        undefined,
        (update) => updates.push(update as (typeof updates)[number]),
      );
      const details = res.details as {
        resource: { artifactPath: string; totalBytes: number; outputBytes: number };
      };
      expect(details.resource.totalBytes).toBe(2 * 1024 * 1024);
      expect(details.resource.outputBytes).toBeLessThanOrEqual(1024);
      expect((await readFile(details.resource.artifactPath)).byteLength).toBe(2 * 1024 * 1024);
      expect(
        updates.every((update) => Buffer.byteLength(update.content[0]?.text ?? "") <= 1024),
      ).toBe(true);
    } finally {
      await cleanup();
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });

  it("hard-fails at the resolved timeout and bounds non-zero error text", async () => {
    const { env, cleanup } = await setupEnv();
    try {
      const timeoutTool = getTool(env, "bash", "timeout", {
        budget: { ...DEFAULT_TOOL_EXECUTION_BUDGET, timeoutMs: 50 },
      });
      const started = Date.now();
      await expect(timeoutTool.execute("timeout-call", { command: "sleep 2" })).rejects.toThrow(
        "NOVI_ERROR:TOOL_TIMEOUT:",
      );
      expect(Date.now() - started).toBeLessThan(1000);

      const errorTool = getTool(env, "bash", "error", {
        budget: { ...DEFAULT_TOOL_EXECUTION_BUDGET, modelBytes: 1024 },
      });
      let thrown: unknown;
      try {
        await errorTool.execute("error-call", {
          command: "head -c 1048576 /dev/zero | tr '\\0' x; exit 9",
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toContain("TOOL_EXIT_NONZERO");
      expect(Buffer.byteLength((thrown as Error).message)).toBeLessThan(600);
    } finally {
      await cleanup();
    }
  });
});
