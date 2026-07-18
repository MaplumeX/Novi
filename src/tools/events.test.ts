import { describe, expect, it } from "vitest";
import type { AgentHarnessEvent } from "@earendil-works/pi-agent-core/node";
import {
  ToolEventDecoder,
  assertJsonSafe,
  createToolResultEnvelope,
  persistedToolCallView,
  reduceToolCallState,
} from "./events.js";

function event(value: unknown): AgentHarnessEvent {
  return value as AgentHarnessEvent;
}

describe("ToolEventDecoder and reduceToolCallState", () => {
  it("reconstructs start, ordered deltas, and a bounded final envelope", () => {
    const decoder = new ToolEventDecoder();
    const events = [
      decoder.decode(
        event({
          type: "tool_execution_start",
          toolCallId: "call-1",
          toolName: "bash",
          args: { command: "pwd" },
        }),
        100,
      ),
      decoder.decode(
        event({
          type: "tool_execution_update",
          toolCallId: "call-1",
          toolName: "bash",
          args: { command: "pwd" },
          partialResult: { content: [{ type: "text", text: "/re" }], details: { sequence: 1 } },
        }),
        110,
      ),
      decoder.decode(
        event({
          type: "tool_execution_update",
          toolCallId: "call-1",
          toolName: "bash",
          args: { command: "pwd" },
          partialResult: { content: [{ type: "text", text: "po" }], details: { sequence: 2 } },
        }),
        120,
      ),
      decoder.decode(
        event({
          type: "tool_execution_end",
          toolCallId: "call-1",
          toolName: "bash",
          result: {
            content: [{ type: "text", text: "/repo" }],
            details: { durationMs: 30, resource: { totalBytes: 5, totalLines: 1 } },
          },
          isError: false,
        }),
        130,
      ),
    ];
    const calls = events.reduce(
      (state, item) => reduceToolCallState(state, item!),
      [] as ReturnType<typeof reduceToolCallState>,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      id: "call-1",
      name: "bash",
      args: { command: "pwd" },
      partialText: "/repo",
      resultText: "/repo",
      status: "done",
      lastSequence: 2,
      result: { version: 1, status: "success", metrics: { startedAt: 100, durationMs: 30 } },
    });
  });

  it("diagnoses duplicates, gaps, and out-of-order deltas", () => {
    const base = {
      id: "call-2",
      tool: {
        name: "custom",
        label: "Custom",
        source: { kind: "external" as const, id: "unknown" },
        capabilities: [],
        risk: "read" as const,
      },
      name: "custom",
      args: {},
      status: "running" as const,
      lastSequence: 0,
      diagnostics: [],
    };
    const delta = (sequence: number, text: string) => ({
      type: "tool.delta" as const,
      toolCallId: "call-2",
      sequence,
      delta: text,
      at: sequence,
    });
    let calls = reduceToolCallState([base], delta(1, "a"));
    calls = reduceToolCallState(calls, delta(1, "duplicate"));
    calls = reduceToolCallState(calls, delta(3, "c"));
    calls = reduceToolCallState(calls, delta(2, "late"));

    expect(calls[0]?.partialText).toBe("ac");
    expect(calls[0]?.diagnostics).toEqual(["duplicate:1", "gap:2-2", "out-of-order:2<3"]);
  });

  it("survives end before start with a minimal unknown tool view", () => {
    const decoder = new ToolEventDecoder();
    const end = decoder.decode(
      event({
        type: "tool_execution_end",
        toolCallId: "early",
        toolName: "future_tool",
        result: { content: [{ type: "text", text: "done" }] },
        isError: false,
      }),
      10,
    )!;
    expect(reduceToolCallState([], end)[0]).toMatchObject({
      id: "early",
      status: "done",
      resultText: "done",
    });
  });

  it("drops progress and duplicate terminal events after completion", () => {
    const decoder = new ToolEventDecoder();
    const end = {
      type: "tool_execution_end",
      toolCallId: "race",
      toolName: "slow",
      result: { content: [{ type: "text", text: "done" }] },
      isError: false,
    };
    expect(decoder.decode(event(end))).toMatchObject({ type: "tool.end", toolCallId: "race" });
    expect(
      decoder.decode(
        event({
          type: "tool_execution_update",
          toolCallId: "race",
          toolName: "slow",
          partialResult: { content: [{ type: "text", text: "late" }], details: { sequence: 1 } },
        }),
      ),
    ).toBeUndefined();
    expect(decoder.decode(event(end))).toBeUndefined();
  });
});

describe("ToolResultEnvelope", () => {
  it("decodes stable errors, cancellation, truncation, and artifacts", () => {
    const envelope = createToolResultEnvelope({
      result: {
        content: [{ type: "text", text: "NOVI_ERROR:TOOL_ABORTED:stopped" }],
        details: {
          durationMs: 20,
          resource: {
            totalBytes: 1_000,
            totalLines: 20,
            truncated: true,
            truncationReasons: ["bytes"],
            artifactPath: "/tmp/full.log",
            artifactBytes: 1_000,
          },
        },
      },
      isError: true,
      startedAt: 10,
      at: 30,
      input: {},
    });

    expect(envelope).toMatchObject({
      status: "cancelled",
      error: { code: "TOOL_ABORTED", message: "stopped", retryable: false },
      truncation: { truncated: true, reasons: ["bytes"] },
      artifacts: [{ kind: "full-output", path: "/tmp/full.log", bytes: 1_000 }],
    });
    expect(() => assertJsonSafe(envelope)).not.toThrow();
  });

  it("marks stale MCP references retryable so the model can search again", () => {
    const envelope = createToolResultEnvelope({
      result: {
        content: [
          {
            type: "text",
            text: "NOVI_ERROR:MCP_TOOL_STALE:mcp:demo/read changed; run search again",
          },
        ],
        details: {},
      },
      isError: true,
      startedAt: 1,
      at: 2,
      input: {},
    });
    expect(envelope.error).toMatchObject({ code: "MCP_TOOL_STALE", retryable: true });
  });

  it("keeps MCP metadata and binary artifacts in the shared JSON-safe envelope", () => {
    const envelope = createToolResultEnvelope({
      result: {
        content: [{ type: "text", text: "audio stored privately" }],
        details: {
          mcp: {
            source: "mcp:demo",
            tool: "speak",
            revision: "rev-1",
            content: [{ index: 0, type: "audio", modelFacing: false, bytes: 3 }],
          },
          artifacts: [{ kind: "document", path: "/private/content.bin", bytes: 3 }],
        },
      },
      isError: false,
      startedAt: 1,
      at: 2,
      input: {},
    });

    expect(envelope).toMatchObject({
      status: "success",
      data: { mcp: { source: "mcp:demo", tool: "speak" } },
      artifacts: [{ kind: "document", path: "/private/content.bin", bytes: 3 }],
    });
    expect((envelope.data as Record<string, unknown>).artifacts).toBeUndefined();
    expect(() => assertJsonSafe(envelope)).not.toThrow();
  });

  it("marks MCP transport errors retryable but protocol/output errors terminal", () => {
    const make = (code: string) =>
      createToolResultEnvelope({
        result: { content: [{ type: "text", text: `NOVI_ERROR:${code}:failed` }], details: {} },
        isError: true,
        startedAt: 1,
        at: 2,
        input: {},
      });
    expect(make("MCP_TRANSPORT_ERROR").error?.retryable).toBe(true);
    expect(make("MCP_PROTOCOL_ERROR").error?.retryable).toBe(false);
    expect(make("MCP_OUTPUT_SCHEMA_INVALID").error?.retryable).toBe(false);
  });

  it("rejects unsafe public JSON and redacts unsafe decoder inputs", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => assertJsonSafe(cyclic)).toThrow(/Cyclic/);
    expect(() => assertJsonSafe({ apiKey: "secret" })).toThrow(/Secret-bearing/);
    expect(() => assertJsonSafe({ fn: () => undefined })).toThrow(/Unsupported/);

    const decoded = new ToolEventDecoder().decode(
      event({
        type: "tool_execution_start",
        toolCallId: "safe",
        toolName: "custom",
        args: { query: "ok", authorization: "Bearer secret", cyclic },
      }),
    );
    expect(decoded).toMatchObject({
      type: "tool.start",
      input: { query: "ok", cyclic: { self: "[cyclic]" } },
    });
    expect(JSON.stringify(decoded)).not.toContain("secret");
  });

  it("fails closed for an unknown final result shape", () => {
    const envelope = createToolResultEnvelope({
      result: { futurePayload: true },
      isError: false,
      startedAt: 1,
      at: 2,
      input: {},
    });
    expect(envelope).toMatchObject({
      status: "error",
      error: { code: "TOOL_RESULT_INVALID", retryable: false },
    });
  });

  it("reconstructs persisted results through the same envelope path", () => {
    const envelope = createToolResultEnvelope({
      result: {
        content: [{ type: "text", text: "hello" }],
        details: {
          durationMs: 4,
          mcp: { source: "mcp:demo", tool: "read", revision: "rev-1" },
        },
      },
      isError: false,
      startedAt: 4,
      at: 8,
      input: { path: "a.ts" },
    });
    const view = persistedToolCallView(
      { id: "persisted", name: "read_file", arguments: { path: "a.ts" } },
      {
        role: "toolResult",
        toolCallId: "persisted",
        toolName: "read_file",
        content: [{ type: "text", text: "hello" }],
        details: { envelope },
        isError: false,
        timestamp: 8,
      },
    );
    expect(view).toMatchObject({
      id: "persisted",
      args: { path: "a.ts" },
      status: "done",
      resultText: "hello",
      result: {
        version: 1,
        status: "success",
        data: { mcp: { source: "mcp:demo", tool: "read", revision: "rev-1" } },
      },
    });
    expect(view.result).toEqual(envelope);
  });
});
