import { describe, expect, it } from "vitest";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ToolDescriptor } from "../tools/contracts.js";
import {
  MAX_MCP_CATALOG_BYTES,
  MAX_MCP_CATALOG_TOOLS,
  buildMcpCatalogSnapshot,
  buildMcpServerCatalogSnapshot,
  canonicalStringify,
  diffMcpCatalog,
  markMcpCatalogDegraded,
} from "./catalog.js";

function protocolTool(name: string, partial: Partial<Tool> = {}): Tool {
  return {
    name,
    inputSchema: { type: "object", additionalProperties: false },
    ...partial,
  };
}

function descriptor(name: string): ToolDescriptor {
  return {
    name,
    label: name,
    source: { kind: "external", id: "mcp:test" },
    capabilities: ["external.invoke"],
    risk: "execute",
    defaultPermission: "ask",
    defaultEnabled: true,
    streaming: "none",
    modes: ["tui", "print", "json", "gateway"],
    optional: true,
    factory: () => ({}) as never,
    resolvePermissionIntents: () => [
      {
        capability: "external.invoke",
        target: "mcp:test/tool",
        scope: "session",
        summary: "test",
      },
    ],
  };
}

function snapshot(
  tools: readonly Tool[],
  options: { serverName?: string; fingerprint?: string; committedAt?: number } = {},
) {
  const serverName = options.serverName ?? "test";
  return buildMcpServerCatalogSnapshot({
    serverName,
    serverFingerprint: options.fingerprint ?? "fp",
    transportKind: "stdio",
    tools,
    committedAt: options.committedAt ?? 1,
    createDescriptor: ({ publicName }) => descriptor(publicName),
  });
}

describe("MCP catalog snapshots", () => {
  it("sorts tools, allocates stable names, and derives revisions from content", () => {
    const first = snapshot([protocolTool("z"), protocolTool("A-B"), protocolTool("A_B")], {
      committedAt: 1,
    });
    const second = snapshot([protocolTool("A_B"), protocolTool("z"), protocolTool("A-B")], {
      committedAt: 999,
    });

    expect(first.tools.map((entry) => entry.protocolTool.name)).toEqual(["A-B", "A_B", "z"]);
    expect(first.tools.map((entry) => entry.publicName)).toEqual([
      "mcp_test_a_b",
      "mcp_test_a_b_2",
      "mcp_test_z",
    ]);
    expect(second.revision).toBe(first.revision);
    expect(second.tools.map((entry) => entry.toolRevision)).toEqual(
      first.tools.map((entry) => entry.toolRevision),
    );
    expect(second.committedAt).not.toBe(first.committedAt);
  });

  it("compiles reusable input and output validators", () => {
    const built = snapshot([
      protocolTool("typed", {
        inputSchema: {
          type: "object",
          properties: { value: { type: "string", minLength: 2 } },
          required: ["value"],
          additionalProperties: false,
        },
        outputSchema: {
          type: "object",
          properties: { count: { type: "integer", minimum: 0 } },
          required: ["count"],
          additionalProperties: false,
        },
      }),
    ]);
    const entry = built.tools[0]!;

    expect(entry.validateInput({ value: "ok" }).valid).toBe(true);
    expect(entry.validateInput({ value: "x" }).valid).toBe(false);
    expect(entry.validateOutput?.({ count: 2 }).valid).toBe(true);
    expect(entry.validateOutput?.({ count: -1 }).valid).toBe(false);
  });

  it("uses 2020-12 by default and honors explicit draft-07 schemas", () => {
    const built = snapshot([
      protocolTool("default-2020", {
        inputSchema: {
          type: "object",
          properties: {
            tuple: {
              type: "array",
              prefixItems: [{ type: "string" }],
              items: false,
            },
          },
          required: ["tuple"],
        },
      }),
      protocolTool("explicit-draft7", {
        inputSchema: {
          $schema: "http://json-schema.org/draft-07/schema#",
          type: "object",
          properties: {
            tuple: {
              type: "array",
              items: [{ type: "string" }],
              additionalItems: false,
            },
          },
          required: ["tuple"],
        },
      }),
    ]);
    const draft2020 = built.tools.find((entry) => entry.protocolTool.name === "default-2020")!;
    const draft7 = built.tools.find((entry) => entry.protocolTool.name === "explicit-draft7")!;

    expect(draft2020.validateInput({ tuple: ["ok"] }).valid).toBe(true);
    expect(draft2020.validateInput({ tuple: ["ok", "extra"] }).valid).toBe(false);
    expect(draft7.validateInput({ tuple: ["ok"] }).valid).toBe(true);
    expect(draft7.validateInput({ tuple: ["ok", "extra"] }).valid).toBe(false);
  });

  it("recompiles repeated schema ids for a new atomic snapshot", () => {
    const first = snapshot([
      protocolTool("versioned", {
        inputSchema: {
          $id: "https://example.test/tool-input",
          type: "object",
          properties: { value: { type: "string", minLength: 1 } },
          required: ["value"],
        },
      }),
    ]);
    const second = snapshot([
      protocolTool("versioned", {
        inputSchema: {
          $id: "https://example.test/tool-input",
          type: "object",
          properties: { value: { type: "string", minLength: 3 } },
          required: ["value"],
        },
      }),
    ]);

    expect(first.tools[0]!.validateInput({ value: "x" }).valid).toBe(true);
    expect(second.tools[0]!.validateInput({ value: "x" }).valid).toBe(false);
  });

  it("rejects duplicate names and invalid schemas without a partial snapshot", () => {
    expect(() => snapshot([protocolTool("same"), protocolTool("same")])).toThrow(/duplicate tool/);
    expect(() =>
      snapshot([
        protocolTool("bad", {
          inputSchema: {
            type: "object",
            properties: { value: { type: "string", pattern: "[" } },
          },
        }),
      ]),
    ).toThrow(/invalid inputSchema/);
    expect(() =>
      snapshot([
        protocolTool("unknown-dialect", {
          inputSchema: {
            $schema: "https://example.test/custom-schema",
            type: "object",
          },
        }),
      ]),
    ).toThrow(/unsupported JSON Schema dialect/);
  });

  it("enforces tool-count and canonical UTF-8 byte limits", () => {
    const tooMany = Array.from({ length: MAX_MCP_CATALOG_TOOLS + 1 }, (_, index) =>
      protocolTool(`t${String(index).padStart(5, "0")}`),
    );
    expect(() => snapshot(tooMany)).toThrow(/MCP_CATALOG_LIMIT/);

    const oversized = protocolTool("large", { description: "界".repeat(MAX_MCP_CATALOG_BYTES) });
    expect(() => snapshot([oversized])).toThrow(/MCP_CATALOG_LIMIT/);
  });

  it("diffs exact tool contracts and preserves LKG content when degraded", () => {
    const before = snapshot([protocolTool("keep"), protocolTool("remove")]);
    const after = snapshot([protocolTool("add"), protocolTool("keep", { description: "changed" })]);
    expect(diffMcpCatalog(before, after)).toEqual({
      addedToolNames: ["add"],
      changedToolNames: ["keep"],
      removedToolNames: ["remove"],
    });

    const degraded = markMcpCatalogDegraded(before, "temporary failure");
    expect(degraded).toMatchObject({
      revision: before.revision,
      health: "degraded",
      diagnostic: "temporary failure",
    });
    expect(degraded.tools).toBe(before.tools);
  });

  it("builds a deterministic manager-wide snapshot", () => {
    const z = snapshot([protocolTool("b")], { serverName: "z" });
    const a = snapshot([protocolTool("a")], { serverName: "a" });
    const first = buildMcpCatalogSnapshot([z, a]);
    const second = buildMcpCatalogSnapshot([a, z]);

    expect(first.servers.map((server) => server.serverName)).toEqual(["a", "z"]);
    expect(first.revision).toBe(second.revision);
    expect(first.tools.map((entry) => entry.serverName)).toEqual(["a", "z"]);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.tools[0]!.protocolTool)).toBe(true);
  });

  it("canonicalizes object keys while retaining array order", () => {
    expect(canonicalStringify({ b: 1, a: [{ z: 2, y: 1 }] })).toBe('{"a":[{"y":1,"z":2}],"b":1}');
  });
});
