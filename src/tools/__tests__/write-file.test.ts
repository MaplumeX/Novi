import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { getTool, setupEnv } from "./helpers.js";

describe("write_file tool", () => {
  it("writes content to a new file, creating parent dirs", async () => {
    const { env, cwd, cleanup } = await setupEnv();
    try {
      const tool = getTool(env, "write_file");
      const res = await tool.execute("t", { path: "nested/dir/out.txt", content: "payload" });
      expect(res.details).toMatchObject({ bytes: 7 });
      const written = await readFile(`${cwd}/nested/dir/out.txt`, "utf8");
      expect(written).toBe("payload");
    } finally {
      await cleanup();
    }
  });

  it("overwrites an existing file", async () => {
    const { env, cwd, cleanup } = await setupEnv();
    try {
      const tool = getTool(env, "write_file");
      await tool.execute("t", { path: "f.txt", content: "old" });
      await tool.execute("t", { path: "f.txt", content: "new" });
      const written = await readFile(`${cwd}/f.txt`, "utf8");
      expect(written).toBe("new");
    } finally {
      await cleanup();
    }
  });
});
