import { describe, expect, it } from "vitest";
import type { ToolDescriptor } from "../tools/contracts.js";
import {
  resolveIntentPermission,
  resolvePermissionsFromSettings,
  resolveWholeToolPermission,
} from "./policy.js";

const bash = {
  name: "bash",
  capabilities: ["shell.execute"],
  defaultPermission: "ask",
} as Pick<ToolDescriptor, "name" | "capabilities" | "defaultPermission">;

const read = {
  name: "read_file",
  capabilities: ["filesystem.read"],
  defaultPermission: "allow",
} as Pick<ToolDescriptor, "name" | "capabilities" | "defaultPermission">;

const external = {
  name: "mcp_demo_echo",
  source: { kind: "external", id: "mcp:demo" },
  capabilities: ["external.invoke"],
  defaultPermission: "ask",
} as Pick<ToolDescriptor, "name" | "source" | "capabilities" | "defaultPermission">;

describe("scoped permission policy", () => {
  it("uses descriptor defaults instead of an implicit allow map", () => {
    const permissions = resolvePermissionsFromSettings(undefined, { workspace: "/work" });
    expect(resolveWholeToolPermission(permissions, bash).level).toBe("ask");
    expect(resolveWholeToolPermission(permissions, read).level).toBe("allow");
  });

  it("uses deny > ask > allow precedence", () => {
    const permissions = resolvePermissionsFromSettings(
      {
        permissions: {
          rules: [
            { capability: "filesystem.read", effect: "allow" },
            { tool: "read_file", effect: "ask" },
            { tool: "read_file", effect: "deny" },
          ],
        },
      },
      { workspace: "/work" },
    );
    expect(resolveWholeToolPermission(permissions, read).level).toBe("deny");
  });

  it("keeps scoped deny out of whole-tool availability", () => {
    const permissions = resolvePermissionsFromSettings(
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
      { workspace: "/work" },
    );
    expect(resolveWholeToolPermission(permissions, read).level).toBe("allow");
    expect(
      resolveIntentPermission(permissions, read, {
        capability: "filesystem.read",
        scope: "file",
        target: "/work/secret.txt",
        lexicalTarget: "/work/secret.txt",
        effectiveTarget: "/work/secret.txt",
        summary: "secret",
      }).level,
    ).toBe("deny");
  });

  it("ignores project allow rules and project external-write allowlists", () => {
    const permissions = resolvePermissionsFromSettings(null, {
      workspace: "/work",
      layers: {
        global: {
          permissions: {
            rules: [{ tool: "bash", effect: "deny" }],
            externalWriteAllowlist: ["/shared"],
          },
        },
        project: {
          permissions: {
            rules: [{ tool: "bash", effect: "allow" }],
            externalWriteAllowlist: ["/tmp"],
          },
        },
      },
    });
    expect(resolveWholeToolPermission(permissions, bash).level).toBe("deny");
    expect(permissions.externalWriteAllowlist).toEqual(["/shared"]);
    expect(permissions.diagnostics.join("\n")).toContain("project allow rule ignored");
    expect(permissions.diagnostics.join("\n")).toContain("global settings only");
  });

  it("fails closed for malformed rules", () => {
    const permissions = resolvePermissionsFromSettings(
      { permissions: { rules: [{ tool: "bash", effect: "bogus" }] } },
      { workspace: "/work" },
    );
    expect(resolveWholeToolPermission(permissions, bash).level).toBe("deny");
    expect(permissions.diagnostics[0]).toContain("failing closed");
  });

  it("accepts external.invoke capability rules for MCP tools", () => {
    const permissions = resolvePermissionsFromSettings(
      {
        permissions: {
          rules: [{ capability: "external.invoke", effect: "deny" }],
        },
      },
      { workspace: "/work" },
    );
    expect(resolveWholeToolPermission(permissions, external).level).toBe("deny");
    expect(resolveWholeToolPermission(permissions, bash).level).toBe("ask");
  });

  it("matches exact source selectors and ANDs them with tool/capability selectors", () => {
    const permissions = resolvePermissionsFromSettings(
      {
        permissions: {
          rules: [
            { source: "mcp:other", capability: "external.invoke", effect: "deny" },
            {
              source: "mcp:demo",
              tool: "mcp_demo_echo",
              capability: "external.invoke",
              effect: "allow",
            },
          ],
        },
      },
      { workspace: "/work" },
    );
    expect(resolveWholeToolPermission(permissions, external).level).toBe("allow");
    expect(permissions.rules[1]).toMatchObject({ source: "mcp:demo", origin: "global" });
  });
});
