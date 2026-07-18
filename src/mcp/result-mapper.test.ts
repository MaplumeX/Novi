import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import * as Type from "typebox";
import type { ToolDescriptor } from "../tools/contracts.js";
import { DEFAULT_TOOL_EXECUTION_BUDGET } from "../tools/runtime/budget.js";
import { ToolExecutionRuntime } from "../tools/runtime/runtime.js";
import { toolEnvelope } from "../tools/test-helpers.js";
import { buildMcpServerCatalogSnapshot, type McpCatalogToolEntry } from "./catalog.js";
import { mapMcpToolResult, McpProgressReporter, mcpResultToPreview } from "./result-mapper.js";

function catalogEntry(tool: Tool): McpCatalogToolEntry {
  return buildMcpServerCatalogSnapshot({
    serverName: "demo",
    serverFingerprint: "fp-demo",
    transportKind: "stdio",
    tools: [tool],
    committedAt: 1,
    createDescriptor: ({ publicName }): ToolDescriptor => ({
      name: publicName,
      label: publicName,
      source: { kind: "external", id: "mcp:demo" },
      capabilities: ["external.invoke"],
      risk: "execute",
      defaultPermission: "ask",
      defaultEnabled: true,
      streaming: "delta",
      modes: ["tui", "print", "json", "gateway"],
      factory: () => {
        throw new Error("not used by result mapper tests");
      },
      resolvePermissionIntents: () => [],
    }),
  }).tools[0]!;
}

function plainTool(partial: Partial<Tool> = {}): Tool {
  return {
    name: "inspect",
    inputSchema: { type: "object" },
    ...partial,
  };
}

describe("MCP result mapper", () => {
  it("preserves native text/image/resource semantics and canonical structured output", async () => {
    const entry = catalogEntry(
      plainTool({
        outputSchema: {
          type: "object",
          properties: { a: { type: "number" }, b: { type: "number" } },
          required: ["a", "b"],
          additionalProperties: false,
        },
      }),
    );
    const image = Buffer.from([1, 2, 3]).toString("base64");
    const result: CallToolResult = {
      content: [
        { type: "text", text: "first" },
        { type: "text", text: "second", annotations: { audience: ["assistant"] } },
        { type: "image", data: image, mimeType: "image/png" },
        {
          type: "resource_link",
          name: "manual",
          uri: "docs://manual",
          mimeType: "text/markdown",
          annotations: { priority: 0.8 },
        },
        {
          type: "resource",
          resource: { uri: "file:///readme", mimeType: "text/plain", text: "embedded" },
        },
      ],
      structuredContent: { b: 2, a: 1 },
    };

    const mapped = await mapMcpToolResult({
      result,
      entry,
      toolCallId: "call",
      toolName: "mcp_demo_inspect",
    });

    expect(mapped.content).toContainEqual({ type: "image", data: image, mimeType: "image/png" });
    expect(mapped.content.filter((part) => part.type === "text").map((part) => part.text)).toEqual([
      "first",
      "second",
      "Resource: manual (docs://manual, text/markdown)",
      "Embedded resource: file:///readme (text/plain)\nembedded",
      '{"a":1,"b":2}',
    ]);
    expect(mapped.details).toMatchObject({
      mcp: {
        source: "mcp:demo",
        tool: "inspect",
        structuredContent: { a: 1, b: 2 },
      },
    });
    expect(JSON.stringify(mapped.details)).not.toContain(image);
  });

  it("does not duplicate structured JSON already returned as text", async () => {
    const entry = catalogEntry(plainTool());
    const mapped = await mapMcpToolResult({
      result: {
        content: [{ type: "text", text: '{"a":1,"b":2}' }],
        structuredContent: { b: 2, a: 1 },
      },
      entry,
      toolCallId: "call",
      toolName: "mcp_demo_inspect",
    });
    expect(mapped.content).toEqual([{ type: "text", text: '{"a":1,"b":2}' }]);
  });

  it("bounds oversized canonical structured output through the shared runtime", async () => {
    const runtime = new ToolExecutionRuntime({
      sessionId: "session",
      budget: {
        ...DEFAULT_TOOL_EXECUTION_BUDGET,
        modelBytes: 64,
        modelLines: 2,
        memoryBytes: 512,
      },
      artifactsEnabled: false,
    });
    const entry = catalogEntry(plainTool());
    const wrapped = runtime.wrap({
      name: "mcp_demo_inspect",
      label: "Inspect",
      description: "Inspect",
      parameters: Type.Object({}),
      execute: async () =>
        mapMcpToolResult({
          result: { content: [], structuredContent: { payload: "x".repeat(1_000) } },
          entry,
          toolCallId: "large",
          toolName: "mcp_demo_inspect",
          runtime,
        }),
    });

    const result = await wrapped.execute("large", {});
    const envelope = toolEnvelope(result);
    expect(Buffer.byteLength(envelope.preview, "utf8")).toBeLessThanOrEqual(64);
    expect(envelope.truncation.truncated).toBe(true);
    expect(envelope.data).toMatchObject({
      mcp: {
        structuredContent: {
          truncated: true,
          reason: "structured-content-budget",
        },
      },
    });
    expect(JSON.stringify(envelope.data)).not.toContain("x".repeat(100));
  });

  it("uses the current catalog output validator and distinguishes tool errors", async () => {
    const entry = catalogEntry(
      plainTool({
        outputSchema: {
          type: "object",
          properties: { count: { type: "integer", minimum: 0 } },
          required: ["count"],
        },
      }),
    );
    await expect(
      mapMcpToolResult({
        result: { content: [{ type: "text", text: "missing" }] },
        entry,
        toolCallId: "call",
        toolName: "tool",
      }),
    ).rejects.toThrow(/NOVI_ERROR:MCP_OUTPUT_SCHEMA_INVALID/);
    await expect(
      mapMcpToolResult({
        result: { content: [], structuredContent: { count: -1 } },
        entry,
        toolCallId: "call",
        toolName: "tool",
      }),
    ).rejects.toThrow(/NOVI_ERROR:MCP_OUTPUT_SCHEMA_INVALID/);
    await expect(
      mapMcpToolResult({
        result: {
          content: [{ type: "text", text: "server refused Authorization: Bearer super-secret" }],
          isError: true,
        },
        entry,
        toolCallId: "call",
        toolName: "tool",
      }),
    ).rejects.toThrow(
      /NOVI_ERROR:MCP_TOOL_ERROR:server refused Authorization: Bearer \[redacted\]/,
    );
  });

  it("persists audio and embedded blobs privately without leaking base64", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "novi-mcp-binary-"));
    try {
      const runtime = new ToolExecutionRuntime({
        sessionId: "session",
        budget: { ...DEFAULT_TOOL_EXECUTION_BUDGET, memoryBytes: 1_024 },
        artifactsEnabled: true,
        artifactRoot: root,
      });
      const audioBytes = Buffer.from([4, 5, 6]);
      const blobBytes = Buffer.from([7, 8, 9]);
      const result: CallToolResult = {
        content: [
          { type: "audio", data: audioBytes.toString("base64"), mimeType: "audio/wav" },
          {
            type: "resource",
            resource: {
              uri: "file:///payload.bin",
              mimeType: "application/octet-stream",
              blob: blobBytes.toString("base64"),
            },
          },
        ],
      };
      const mapped = await mapMcpToolResult({
        result,
        entry: catalogEntry(plainTool()),
        toolCallId: "call",
        toolName: "tool",
        runtime,
      });
      const artifacts = mapped.details.artifacts as Array<{ path: string; bytes: number }>;
      expect(artifacts).toHaveLength(2);
      expect(await readFile(artifacts[0]!.path)).toEqual(audioBytes);
      expect(await readFile(artifacts[1]!.path)).toEqual(blobBytes);
      expect((await stat(artifacts[0]!.path)).mode & 0o777).toBe(0o600);
      expect((await stat(path.dirname(artifacts[0]!.path))).mode & 0o777).toBe(0o700);
      const publicShape = JSON.stringify(mapped);
      expect(publicShape).not.toContain(audioBytes.toString("base64"));
      expect(publicShape).not.toContain(blobBytes.toString("base64"));
      expect(publicShape).toContain("not model-native");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("degrades invalid, oversized, unsupported, or disabled binary content explicitly", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "novi-mcp-degraded-"));
    try {
      const runtime = new ToolExecutionRuntime({
        sessionId: "session",
        budget: { ...DEFAULT_TOOL_EXECUTION_BUDGET, memoryBytes: 2 },
        artifactsEnabled: false,
        artifactRoot: root,
      });
      const mapped = await mapMcpToolResult({
        result: {
          content: [
            { type: "audio", data: "!!!!", mimeType: "audio/wav" },
            {
              type: "image",
              data: Buffer.from([1, 2, 3]).toString("base64"),
              mimeType: "image/png",
            },
            { type: "image", data: "AQ==", mimeType: "text/plain" },
            { type: "image", data: "AQ==", mimeType: "invalid" },
          ],
        },
        entry: catalogEntry(plainTool()),
        toolCallId: "call",
        toolName: "tool",
        runtime,
      });
      const preview = mapped.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      expect(preview).toContain("invalid base64");
      expect(preview).toContain("exceeds 2 bytes");
      expect(preview).toContain("artifact persistence is disabled");
      expect(preview).toContain("invalid MIME type");
      expect(JSON.stringify(mapped)).not.toContain("!!!!");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves stable artifact quota and write failures", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "novi-mcp-artifact-errors-"));
    try {
      const result: CallToolResult = {
        content: [
          {
            type: "audio",
            data: Buffer.from([1, 2, 3]).toString("base64"),
            mimeType: "audio/wav",
          },
        ],
      };
      const quotaRuntime = new ToolExecutionRuntime({
        sessionId: "quota",
        budget: {
          ...DEFAULT_TOOL_EXECUTION_BUDGET,
          memoryBytes: 100,
          artifactSessionBytes: 2,
          artifactGlobalBytes: 2,
        },
        artifactsEnabled: true,
        artifactRoot: root,
      });
      await expect(
        mapMcpToolResult({
          result,
          entry: catalogEntry(plainTool()),
          toolCallId: "call",
          toolName: "tool",
          runtime: quotaRuntime,
        }),
      ).rejects.toMatchObject({ code: "ARTIFACT_QUOTA_EXCEEDED" });

      const unusable = path.join(root, "not-a-directory");
      await writeFile(unusable, "x");
      const writeRuntime = new ToolExecutionRuntime({
        sessionId: "write",
        budget: { ...DEFAULT_TOOL_EXECUTION_BUDGET, memoryBytes: 100 },
        artifactsEnabled: true,
        artifactRoot: unusable,
      });
      await expect(
        mapMcpToolResult({
          result,
          entry: catalogEntry(plainTool()),
          toolCallId: "call",
          toolName: "tool",
          runtime: writeRuntime,
        }),
      ).rejects.toMatchObject({ code: "ARTIFACT_WRITE_FAILED" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps preview bounded and never includes binary payloads", () => {
    const payload = Buffer.alloc(100, 7).toString("base64");
    const preview = mcpResultToPreview({
      content: [{ type: "audio", data: payload, mimeType: "audio/wav" }],
    });
    expect(preview).toBe("[audio audio/wav]");
    expect(preview).not.toContain(payload);
  });
});

describe("MCP progress reporter", () => {
  it("emits continuous sequences with non-cumulative progress deltas", () => {
    let now = 1_000;
    const updates: Array<{ text: string; sequence: unknown }> = [];
    const reporter = new McpProgressReporter(
      { ...DEFAULT_TOOL_EXECUTION_BUDGET, partialUpdatesPerSecond: 10 },
      (partial) => {
        updates.push({
          text: partial.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join(""),
          sequence: (partial.details as Record<string, unknown>).sequence,
        });
      },
      () => now,
    );
    reporter.update({ progress: 1, total: 2, message: "one" });
    now += 100;
    reporter.update({ progress: 2, total: 2, message: "two" });
    reporter.finish();

    expect(updates).toEqual([
      { text: "one\n", sequence: 1 },
      { text: "two\n", sequence: 2 },
    ]);
    expect(reporter.getDiagnostics()).toEqual([]);
  });

  it("emits bounded true deltas and diagnoses invalid, regressive, and late progress", async () => {
    const updates: string[] = [];
    const reporter = new McpProgressReporter(
      { ...DEFAULT_TOOL_EXECUTION_BUDGET, partialUpdatesPerSecond: 10_000 },
      (partial) => {
        updates.push(
          partial.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join(""),
        );
      },
      () => 1_000,
    );
    reporter.update({ progress: 1, total: 3, message: "one" });
    reporter.update({ progress: 1, total: 3, message: "duplicate" });
    reporter.update({ progress: 2, total: 1, message: "two" });
    reporter.update({ progress: Number.NaN, message: "invalid" });
    reporter.finish();
    reporter.update({ progress: 3, total: 3, message: "late" });

    expect(updates.join("")).toBe("one\n");
    expect(updates.join("")).not.toContain("duplicate");
    expect(reporter.getDiagnostics()).toEqual([
      "non-monotonic-progress:1",
      "invalid-progress-total",
      "invalid-progress",
      "progress-rate-limited",
      "late-progress",
    ]);
  });
});
