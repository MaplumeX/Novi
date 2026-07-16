import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { envelopeData, getTool, getTools, setupEnv, writeFixture } from "./test-helpers.js";
import { resolvePermissionsFromSettings } from "../permissions/policy.js";

describe("write_file tool", () => {
  it("writes content to a new file, creating parent dirs", async () => {
    const { env, cwd, cleanup } = await setupEnv();
    try {
      const tool = getTool(env, "write_file");
      const res = await tool.execute("t", { path: "nested/dir/out.txt", content: "payload" });
      expect(envelopeData(res)).toMatchObject({ bytes: 7 });
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

  it("denies native writes outside the workspace without a global allowlist", async () => {
    const { env, cwd, cleanup } = await setupEnv();
    const outside = path.join(path.dirname(cwd), `${path.basename(cwd)}-outside.txt`);
    try {
      const tool = getTool(env, "write_file");
      await expect(tool.execute("t", { path: outside, content: "blocked" })).rejects.toThrow(
        "NOVI_ERROR:WORKSPACE_EXTERNAL_WRITE_DENIED",
      );
    } finally {
      await rm(outside, { force: true });
      await cleanup();
    }
  });

  it("allows native external writes only under a global allowlist", async () => {
    const { env, cwd, cleanup } = await setupEnv();
    const outside = path.join(path.dirname(cwd), `${path.basename(cwd)}-allowed.txt`);
    try {
      const permissions = resolvePermissionsFromSettings(
        { permissions: { externalWriteAllowlist: [outside] } },
        { workspace: cwd },
      );
      const tool = getTool(env, "write_file", "test-session", { permissions });
      await tool.execute("t", { path: outside, content: "allowed" });
      expect(await readFile(outside, "utf8")).toBe("allowed");
    } finally {
      await rm(outside, { force: true });
      await cleanup();
    }
  });

  it("invalidates the read cache after a successful write", async () => {
    const { env, cwd, cleanup } = await setupEnv();
    try {
      const file = await writeFixture(cwd, "w.txt", "old\n");
      const tools = getTools(env, ["read_file", "write_file"]);
      const readTool = tools["read_file"]!;
      const writeTool = tools["write_file"]!;

      // First read: miss
      const r1 = await readTool.execute("t", { path: file });
      expect(envelopeData(r1).cache).toBe("miss");

      // Second read: hit
      const r2 = await readTool.execute("t", { path: file });
      expect(envelopeData(r2).cache).toBe("hit");

      // Overwrite the file
      await writeTool.execute("t", { path: file, content: "new\n" });

      // Third read: miss (cache invalidated by write)
      const r3 = await readTool.execute("t", { path: file });
      expect(envelopeData(r3).cache).toBe("miss");
      expect((r3.content[0] as { text: string }).text).toBe("new\n");
    } finally {
      await cleanup();
    }
  });
});
