import { describe, expect, it } from "vitest";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ToolDescriptor } from "../tools/contracts.js";
import { resolvePermissionsFromSettings } from "../permissions/policy.js";
import { buildMcpCatalogSnapshot, buildMcpServerCatalogSnapshot } from "./catalog.js";
import { mcpAgentToolSchemaBytes, projectMcpExposure } from "./exposure.js";
import { searchMcpTools } from "./search.js";

describe("MCP exposure projection", () => {
  const catalog = buildMcpCatalogSnapshot([
    snapshot([tool("a", 50), tool("b", 100), tool("c", 150)]),
  ]);

  it("keeps small auto catalogs direct and switches large catalogs to proxies plus pinned", () => {
    const total = catalog.tools.reduce((sum, entry) => sum + mcpAgentToolSchemaBytes(entry), 0);
    const direct = projectMcpExposure(catalog, {
      mode: "auto",
      directSchemaBytes: total,
      pinned: [],
    });
    expect(direct.direct).toHaveLength(3);
    expect(direct.proxiesActive).toBe(false);

    const deferred = projectMcpExposure(catalog, {
      mode: "auto",
      directSchemaBytes: 1,
      pinned: [catalog.tools[1]!.publicName],
    });
    expect(deferred.direct.map((entry) => entry.publicName)).toEqual([
      catalog.tools[1]!.publicName,
    ]);
    expect(deferred.deferred).toHaveLength(2);
    expect(deferred.proxiesActive).toBe(true);
  });

  it("filters disabled sources/tools and whole-denied descriptors before search/exposure", () => {
    const permissions = resolvePermissionsFromSettings(
      { permissions: { rules: [{ tool: catalog.tools[2]!.publicName, effect: "deny" }] } },
      { workspace: "/work" },
    );
    const projection = projectMcpExposure(catalog, {
      mode: "direct",
      directSchemaBytes: 1,
      pinned: [],
      enabledTools: { [catalog.tools[1]!.publicName]: false },
      permissions,
    });
    expect(projection.direct.map((entry) => entry.protocolTool.name)).toEqual(["a"]);
  });

  it("keeps a 10,000-tool auto catalog out of provider schemas while exact search remains available", () => {
    const baseServer = snapshot([tool("base", 10)]);
    const base = baseServer.tools[0]!;
    const tools = Array.from({ length: 10_000 }, (_, index) => {
      const name = `needle_${index}`;
      return Object.freeze({
        ...base,
        publicName: `mcp_demo_${name}`,
        protocolTool: { ...base.protocolTool, name, title: name },
        descriptor: { ...base.descriptor, name: `mcp_demo_${name}`, label: name },
        toolRevision: index.toString(16).padStart(64, "0"),
      });
    });
    const server = Object.freeze({ ...baseServer, tools: Object.freeze(tools) });
    const large = Object.freeze({
      revision: "f".repeat(64),
      servers: Object.freeze([server]),
      tools: Object.freeze(tools),
    });
    const projection = projectMcpExposure(large, {
      mode: "auto",
      directSchemaBytes: 32 * 1024,
      pinned: [],
    });
    expect(projection.directSchemaBytes).toBe(0);
    expect(projection.deferred).toHaveLength(10_000);
    expect(projection.proxiesActive).toBe(true);
    expect(searchMcpTools(large, { query: "needle_9999", limit: 1 }).results[0]?.name).toBe(
      "needle_9999",
    );
  });
});

function snapshot(tools: Tool[]) {
  return buildMcpServerCatalogSnapshot({
    serverName: "demo",
    serverFingerprint: "demo",
    transportKind: "stdio",
    tools,
    committedAt: 1,
    createDescriptor: ({ tool: protocolTool, publicName }) =>
      descriptor(publicName, protocolTool.name),
  });
}

function tool(name: string, descriptionBytes: number): Tool {
  return {
    name,
    description: "x".repeat(descriptionBytes),
    inputSchema: { type: "object", properties: { value: { type: "string" } } },
  };
}

function descriptor(name: string, label: string): ToolDescriptor {
  return {
    name,
    label,
    source: { kind: "external", id: "mcp:demo" },
    capabilities: ["external.invoke"],
    risk: "execute",
    defaultPermission: "ask",
    defaultEnabled: true,
    streaming: "none",
    modes: ["tui"],
    factory: () => ({}) as never,
    resolvePermissionIntents: () => [
      { capability: "external.invoke", target: label, scope: "session", summary: label },
    ],
  };
}
