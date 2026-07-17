import { describe, expect, it } from "vitest";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ToolDescriptor } from "../tools/contracts.js";
import { buildMcpCatalogSnapshot, buildMcpServerCatalogSnapshot } from "./catalog.js";
import {
  MAX_MCP_TOOL_REF_BYTES,
  decodeMcpToolRef,
  encodeMcpToolRef,
  resolveMcpToolRef,
} from "./tool-ref.js";

describe("MCP toolRef", () => {
  it("round-trips canonically and resolves only against the current revisions", () => {
    const first = snapshot("a"),
      current = buildMcpCatalogSnapshot([first]);
    const entry = first.tools[0]!;
    const ref = encodeMcpToolRef(entry, first.revision);
    expect(decodeMcpToolRef(ref)).toMatchObject({
      sourceId: "mcp:demo",
      protocolName: "a",
      catalogRevision: first.revision,
      toolRevision: entry.toolRevision,
    });
    expect(resolveMcpToolRef(current, ref)).toBe(entry);
  });

  it("rejects malformed, oversized, forged and stale references without resolving a call", () => {
    expect(() => decodeMcpToolRef("nope")).toThrow("PERMISSION_INTENT_INVALID");
    expect(() => decodeMcpToolRef(`mcp:v1:${"a".repeat(MAX_MCP_TOOL_REF_BYTES)}`)).toThrow(
      "PERMISSION_INTENT_INVALID",
    );
    const first = snapshot("a");
    const ref = encodeMcpToolRef(first.tools[0]!, first.revision);
    expect(() => resolveMcpToolRef(buildMcpCatalogSnapshot([snapshot("b")]), ref)).toThrow(
      "MCP_TOOL_STALE",
    );
    const payload = decodeMcpToolRef(ref);
    const forged = `mcp:v1:${Buffer.from(
      JSON.stringify({ ...payload, toolRevision: "0".repeat(64) }),
    ).toString("base64url")}`;
    expect(() => resolveMcpToolRef(buildMcpCatalogSnapshot([first]), forged)).toThrow(
      "MCP_TOOL_STALE",
    );
  });
});

function snapshot(name: string) {
  return buildMcpServerCatalogSnapshot({
    serverName: "demo",
    serverFingerprint: "fingerprint",
    transportKind: "stdio",
    tools: [tool(name)],
    committedAt: 1,
    createDescriptor: ({ tool: protocolTool, publicName }) =>
      descriptor(publicName, protocolTool.name),
  });
}

function tool(name: string): Tool {
  return { name, description: `Tool ${name}`, inputSchema: { type: "object" } };
}

function descriptor(name: string, protocolName: string): ToolDescriptor {
  return {
    name,
    label: protocolName,
    source: { kind: "external", id: "mcp:demo" },
    capabilities: ["external.invoke"],
    risk: "execute",
    defaultPermission: "ask",
    defaultEnabled: true,
    streaming: "none",
    modes: ["tui"],
    factory: () => ({
      name,
      label: name,
      description: name,
      parameters: {} as never,
      execute: async () => ({ content: [], details: {} }),
    }),
    resolvePermissionIntents: () => [
      {
        capability: "external.invoke",
        target: protocolName,
        scope: "session",
        summary: protocolName,
      },
    ],
  };
}
