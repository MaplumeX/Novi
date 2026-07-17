import { describe, expect, it } from "vitest";
import type { SerializableToolDescriptor } from "../tools/contracts.js";
import { resolveAgentPolicy } from "./profiles.js";
import type { ResolvedSubagentSettings } from "./types.js";

const tools: SerializableToolDescriptor[] = [
  descriptor("read_file", "read"),
  descriptor("grep", "read"),
  descriptor("bash", "execute"),
  descriptor("write_file", "write"),
  descriptor("agents", "write"),
  descriptor("jobs", "write"),
  descriptor("mcp_docs_search", "network", { kind: "external", id: "mcp:docs" }),
];

const settings: ResolvedSubagentSettings = {
  enabled: true,
  maxConcurrent: 8,
  maxChildrenPerParent: 5,
  maxSpawnDepth: 1,
  runTimeoutMs: 900_000,
  maxResultBytes: 65_536,
  retentionDays: 30,
  allowedModels: ["openai/child"],
  profiles: {},
};

function descriptor(
  name: string,
  risk: SerializableToolDescriptor["risk"],
  source: SerializableToolDescriptor["source"] = { kind: "builtin", id: "builtin" },
): SerializableToolDescriptor {
  return {
    name,
    label: name,
    source,
    capabilities: source.kind === "external" ? ["external.invoke"] : ["filesystem.read"],
    risk,
    defaultPermission: "allow",
    defaultEnabled: true,
    streaming: "none",
    modes: ["tui", "json", "gateway"],
    optional: false,
  };
}

function parent() {
  return {
    model: { provider: "anthropic", id: "parent" },
    thinking: "high" as const,
    tools,
    activeToolNames: tools.map((tool) => tool.name),
    skillNames: ["one", "two"],
    permissions: {
      rules: [{ effect: "deny" as const, tool: "bash", source: "global" as const }],
      externalWriteAllowlist: [],
      autoApproveAsks: false,
      diagnostics: [],
    },
  };
}

describe("resolveAgentPolicy", () => {
  it("keeps explorer read-only and removes delegation and MCP by default", () => {
    const result = resolveAgentPolicy({ settings, parent: parent(), profile: "explorer" });
    expect(result.snapshot.activeToolNames).toEqual(["grep", "read_file"]);
    expect(result.snapshot.writable).toBe(false);
    expect(result.maxAttempts).toBe(2);
  });

  it("lets worker inherit parent tools but never delegation tools", () => {
    const result = resolveAgentPolicy({ settings, parent: parent(), profile: "worker" });
    expect(result.snapshot.activeToolNames).toEqual(["bash", "grep", "read_file", "write_file"]);
    expect(result.snapshot.writable).toBe(true);
    expect(result.maxAttempts).toBe(1);
  });

  it("allows only configured model overrides and caps thinking", () => {
    const result = resolveAgentPolicy({
      settings,
      parent: parent(),
      profile: "reviewer",
      model: "openai/child",
      thinking: "low",
      modelAvailable: () => true,
    });
    expect(result.model).toEqual({ provider: "openai", id: "child" });
    expect(result.thinking).toBe("low");
    expect(() =>
      resolveAgentPolicy({ settings, parent: parent(), model: "other/model" }),
    ).toThrowError(expect.objectContaining({ code: "AGENT_MODEL_NOT_ALLOWED" }));
  });

  it("intersects custom skills, MCP sources, and parent-active tools", () => {
    const result = resolveAgentPolicy({
      settings: {
        ...settings,
        profiles: {
          docs: {
            tools: { allow: ["read_file", "mcp_docs_search", "missing"] },
            skills: ["two", "missing"],
            mcpSources: ["mcp:docs"],
            maxThinking: "medium",
          },
        },
      },
      parent: parent(),
      profile: "docs",
    });
    expect(result.snapshot.activeToolNames).toEqual(["mcp_docs_search", "read_file"]);
    expect(result.snapshot.skillNames).toEqual(["two"]);
    expect(result.snapshot.mcpSources).toEqual(["mcp:docs"]);
    expect(result.thinking).toBe("medium");
  });
});
