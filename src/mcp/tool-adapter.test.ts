import { describe, expect, it } from "vitest";
import { IsObject } from "typebox";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  buildMcpToolName,
  mapMcpCapabilities,
  mapMcpRisk,
  mcpInputSchemaToTypeBox,
  mcpResultToPreview,
  resolveMcpPermissionIntents,
  sanitizeNamePart,
} from "./tool-adapter.js";

function tool(partial: Partial<Tool> & Pick<Tool, "name">): Tool {
  return {
    inputSchema: { type: "object" },
    ...partial,
  };
}

describe("MCP tool naming", () => {
  it("builds stable sanitized names", () => {
    expect(buildMcpToolName("Docs-Server", "Read File")).toBe("mcp_docs_server_read_file");
    expect(sanitizeNamePart("123go")).toBe("x_123go");
    expect(sanitizeNamePart("")).toBe("x");
  });
});

describe("capability / risk mapping", () => {
  it("maps path tools to filesystem capabilities", () => {
    const t = tool({
      name: "read_path",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
      },
      annotations: { readOnlyHint: true },
    });
    expect(mapMcpCapabilities(t)).toEqual(["filesystem.read"]);
    expect(mapMcpRisk(t, "stdio")).toBe("read");
  });

  it("maps command tools to shell.execute", () => {
    const t = tool({
      name: "run",
      inputSchema: {
        type: "object",
        properties: { command: { type: "string" } },
      },
    });
    expect(mapMcpCapabilities(t)).toContain("shell.execute");
    expect(mapMcpRisk(t, "stdio")).toBe("execute");
  });

  it("falls back to external.invoke", () => {
    const t = tool({ name: "mystery" });
    expect(mapMcpCapabilities(t)).toEqual(["external.invoke"]);
    expect(mapMcpRisk(t, "http")).toBe("network");
  });
});

describe("permission intents", () => {
  it("emits external.invoke fallback intent", () => {
    const t = tool({ name: "mystery" });
    const intents = resolveMcpPermissionIntents({
      input: { foo: 1 },
      tool: t,
      serverName: "demo",
      mcpToolName: "mystery",
      capabilities: ["external.invoke"],
    });
    expect(intents).toEqual([
      {
        capability: "external.invoke",
        target: "mcp:demo/mystery",
        scope: "session",
        summary: "invoke mystery on demo",
      },
    ]);
  });

  it("maps path args to filesystem intents", () => {
    const t = tool({
      name: "read",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
      },
    });
    const intents = resolveMcpPermissionIntents({
      input: { path: "src/a.ts" },
      tool: t,
      serverName: "fs",
      mcpToolName: "read",
      capabilities: ["filesystem.read"],
    });
    expect(intents[0]).toMatchObject({
      capability: "filesystem.read",
      target: "src/a.ts",
      scope: "file",
    });
  });
});

describe("schema + result mapping", () => {
  it("produces TypeBox Object-kind parameters", () => {
    const schema = mcpInputSchemaToTypeBox({
      type: "object",
      properties: { q: { type: "string" } },
      required: ["q"],
    });
    expect(IsObject(schema)).toBe(true);
    expect(schema.required).toEqual(["q"]);
  });

  it("previews MCP text content", () => {
    expect(
      mcpResultToPreview({
        content: [{ type: "text", text: "hello" }],
      }),
    ).toBe("hello");
  });
});
