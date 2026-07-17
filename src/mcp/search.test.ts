import { describe, expect, it } from "vitest";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ToolDescriptor } from "../tools/contracts.js";
import { buildMcpCatalogSnapshot, buildMcpServerCatalogSnapshot } from "./catalog.js";
import {
  MAX_MCP_SEARCH_QUERY_BYTES,
  MAX_MCP_SEARCH_RESPONSE_BYTES,
  MAX_MCP_SEARCH_SCHEMA_BYTES,
  searchMcpTools,
} from "./search.js";

describe("MCP catalog search", () => {
  it("ranks deterministically with stable tie breaks and filters", () => {
    const catalog = buildMcpCatalogSnapshot([
      snapshot("zeta", [
        tool("read_issue", "Read issue by id", "issue tracker"),
        tool("search_docs", "Search docs", "documentation"),
      ]),
      snapshot("alpha", [tool("read_issue", "Read issue", "ticket reader")]),
    ]);
    const first = searchMcpTools(catalog, { query: "read issue" });
    const second = searchMcpTools(catalog, { query: "read issue" });
    expect(second).toEqual(first);
    expect(first.results.slice(0, 2).map((item) => item.source)).toEqual(["mcp:alpha", "mcp:zeta"]);
    expect(
      searchMcpTools(catalog, { query: "issue", source: "zeta", limit: 1 }).results,
    ).toHaveLength(1);
    expect(
      searchMcpTools(catalog, { query: "issue", capability: "filesystem.write" }).results,
    ).toEqual([]);
  });

  it("bounds results and visibly truncates oversized schemas without changing host validators", () => {
    const many = Array.from({ length: 8 }, (_, index) =>
      tool(`search_${index}`, "Search records", "search"),
    );
    many[0]!.inputSchema = {
      type: "object",
      properties: {
        payload: { type: "string", description: "x".repeat(MAX_MCP_SEARCH_SCHEMA_BYTES * 2) },
      },
    };
    const catalog = buildMcpCatalogSnapshot([snapshot("demo", many)]);
    const result = searchMcpTools(catalog, { query: "search", limit: 5 });
    expect(result.results).toHaveLength(5);
    expect(result.results[0]!.schemaTruncated).toBe(true);
    expect(typeof result.results[0]!.inputSchema).toBe("string");
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(
      MAX_MCP_SEARCH_RESPONSE_BYTES,
    );
    expect(catalog.tools[0]!.validateInput({ payload: "ok" }).valid).toBe(true);
  });

  it("rejects oversized or control-bearing search inputs before indexing", () => {
    const catalog = buildMcpCatalogSnapshot([
      snapshot("demo", [tool("search", "Search", "records")]),
    ]);
    expect(() =>
      searchMcpTools(catalog, { query: "x".repeat(MAX_MCP_SEARCH_QUERY_BYTES + 1) }),
    ).toThrow("PERMISSION_INTENT_INVALID");
    expect(() => searchMcpTools(catalog, { query: "search", source: "demo\nother" })).toThrow(
      "PERMISSION_INTENT_INVALID",
    );
  });
});

function snapshot(serverName: string, tools: Tool[]) {
  return buildMcpServerCatalogSnapshot({
    serverName,
    serverFingerprint: serverName,
    transportKind: "stdio",
    tools,
    committedAt: 1,
    createDescriptor: ({ tool: protocolTool, publicName }) =>
      descriptor(serverName, publicName, protocolTool.name),
  });
}

function tool(name: string, title: string, description: string): Tool {
  return {
    name,
    title,
    description,
    inputSchema: {
      type: "object",
      properties: { issue: { type: "string", description: "issue identifier" } },
    },
  };
}

function descriptor(server: string, name: string, label: string): ToolDescriptor {
  return {
    name,
    label,
    source: { kind: "external", id: `mcp:${server}` },
    capabilities: ["external.invoke"],
    risk: "read",
    defaultPermission: "ask",
    defaultEnabled: true,
    streaming: "none",
    modes: ["tui"],
    factory: () => ({
      name,
      label,
      description: label,
      parameters: {} as never,
      execute: async () => ({ content: [], details: {} }),
    }),
    resolvePermissionIntents: () => [
      { capability: "external.invoke", target: label, scope: "session", summary: label },
    ],
  };
}
