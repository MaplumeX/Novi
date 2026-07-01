import { describe, expect, it } from "vitest";
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
});
