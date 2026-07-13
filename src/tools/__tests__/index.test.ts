import { describe, expect, it } from "vitest";
import { IsObject } from "typebox";
import { createBuiltinToolAssembly } from "../index.js";
import { resolvePermissionsFromSettings } from "../../permissions/policy.js";
import { setupEnv } from "./helpers.js";

const EXPECTED = [
  "read_file",
  "write_file",
  "edit_file",
  "bash",
  "ls",
  "glob",
  "grep",
  "todo",
  "web_search",
  "fetch_content",
];

describe("createBuiltinToolAssembly", () => {
  it("returns all 10 tools with required metadata", async () => {
    const { env, cleanup } = await setupEnv();
    try {
      const assembly = createBuiltinToolAssembly(env, "test-session");
      const tools = assembly.tools;
      expect(tools.map((t) => t.name).sort()).toEqual([...EXPECTED].sort());
      for (const tool of tools) {
        expect(typeof tool.name).toBe("string");
        expect(typeof tool.label).toBe("string");
        expect(typeof tool.description).toBe("string");
        expect(IsObject(tool.parameters)).toBe(true);
        expect(typeof tool.execute).toBe("function");
      }
      expect(assembly.activeToolNames.sort()).toEqual([...EXPECTED].sort());
      expect(assembly.descriptors.map((descriptor) => descriptor.name).sort()).toEqual(
        [...EXPECTED].sort(),
      );
      expect(assembly.availability.every((entry) => entry.status === "active")).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("hides whole-tool denied and explicitly disabled tools", async () => {
    const { env, cleanup } = await setupEnv();
    try {
      const assembly = createBuiltinToolAssembly(env, "test-session", {
        exposure: { enabled: { grep: false } },
        permissions: resolvePermissionsFromSettings(
          { permissions: { rules: [{ tool: "bash", effect: "deny" }] } },
          { workspace: env.cwd },
        ),
      });
      expect(assembly.activeToolNames).not.toContain("grep");
      expect(assembly.activeToolNames).not.toContain("bash");
      expect(assembly.availability.find((entry) => entry.name === "grep")?.status).toBe("disabled");
      expect(assembly.availability.find((entry) => entry.name === "bash")?.status).toBe("denied");
    } finally {
      await cleanup();
    }
  });

  it("keeps a tool active when only a scoped rule denies one target", async () => {
    const { env, cleanup } = await setupEnv();
    try {
      const assembly = createBuiltinToolAssembly(env, "test-session", {
        permissions: resolvePermissionsFromSettings(
          {
            permissions: {
              rules: [
                {
                  capability: "filesystem.read",
                  scope: "file",
                  target: "secret.txt",
                  effect: "deny",
                },
              ],
            },
          },
          { workspace: env.cwd },
        ),
      });
      expect(assembly.activeToolNames).toContain("read_file");
      expect(assembly.availability.find((entry) => entry.name === "read_file")?.status).toBe(
        "active",
      );
    } finally {
      await cleanup();
    }
  });

  it("marks selected credential-backed web tools unavailable", async () => {
    const { env, cleanup } = await setupEnv();
    try {
      const assembly = createBuiltinToolAssembly(env, "test-session", {
        webSearch: { provider: "brave" },
        env: {},
      });
      expect(assembly.activeToolNames).not.toContain("web_search");
      expect(assembly.availability.find((entry) => entry.name === "web_search")).toMatchObject({
        status: "unavailable",
        reasonCode: "INITIALIZATION_FAILED",
      });
    } finally {
      await cleanup();
    }
  });
});
