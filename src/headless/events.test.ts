import { describe, expect, it } from "vitest";
import type { AgentHarnessEvent } from "@earendil-works/pi-agent-core/node";
import { HeadlessEventProjector, extractText, projectToolCatalog } from "./events.js";
import type { ToolCatalogSnapshot } from "../tools/contracts.js";

function projectEvent(
  event: AgentHarnessEvent,
  catalog?: ToolCatalogSnapshot,
): Record<string, unknown> {
  return new HeadlessEventProjector(catalog).project(event) as Record<string, unknown>;
}

/** Assert a value survives `JSON.stringify` (no functions / circular refs). */
function assertJsonSafe(value: unknown): void {
  expect(() => JSON.stringify(value)).not.toThrow();
}

describe("extractText", () => {
  it("passes through plain strings", () => {
    expect(extractText("hello")).toBe("hello");
  });

  it("concatenates text parts from a content array", () => {
    const content = [
      { type: "text", text: "foo" },
      { type: "text", text: "bar" },
    ];
    expect(extractText(content)).toBe("foobar");
  });

  it("ignores non-text parts", () => {
    const content = [
      { type: "text", text: "keep" },
      { type: "image", data: "base64", mimeType: "image/png" },
      { type: "thinking", thinking: "secret" },
    ];
    expect(extractText(content)).toBe("keep");
  });

  it("returns empty string for unknown shapes", () => {
    expect(extractText(undefined as never)).toBe("");
  });
});

describe("projectEvent", () => {
  it("every projected event is JSON-serializable", () => {
    const events: AgentHarnessEvent[] = [
      { type: "agent_start" },
      { type: "agent_end", messages: [] },
      { type: "turn_start" },
      {
        type: "turn_end",
        message: { role: "assistant", content: [] } as never,
        toolResults: [],
      },
      { type: "message_start", message: { role: "user", content: "hi" } as never },
      {
        type: "message_update",
        message: { role: "assistant", content: [] } as never,
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: "d",
          partial: {} as never,
        },
      },
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "final" }],
        } as never,
      },
      {
        type: "tool_execution_start",
        toolCallId: "tc1",
        toolName: "bash",
        args: { cmd: "ls" },
      },
      {
        type: "tool_execution_end",
        toolCallId: "tc1",
        toolName: "bash",
        result: {},
        isError: false,
      },
      { type: "queue_update", steer: [], followUp: [], nextTurn: [] },
      { type: "settled", nextTurnCount: 0 },
    ];
    for (const event of events) {
      const projected = projectEvent(event);
      assertJsonSafe(projected);
      expect(projected.type).toBe(
        event.type === "tool_execution_start"
          ? "tool.start"
          : event.type === "tool_execution_end"
            ? "tool.end"
            : event.type,
      );
    }
  });

  it("projects message_end assistant text + usage", () => {
    const event = {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "hello" }],
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
      },
    } as unknown as AgentHarnessEvent;
    const projected = projectEvent(event);
    expect(projected).toEqual({
      type: "message_end",
      role: "assistant",
      text: "hello",
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
    });
  });

  it("projects message_update text_delta with delta field", () => {
    const event = {
      type: "message_update",
      message: { role: "assistant", content: [] },
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "abc", partial: {} },
    } as unknown as AgentHarnessEvent;
    expect(projectEvent(event)).toEqual({ type: "message_update", delta: "abc" });
  });

  it("projects message_update non-text events with subType", () => {
    const event = {
      type: "message_update",
      message: { role: "assistant", content: [] },
      assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, partial: {} },
    } as unknown as AgentHarnessEvent;
    expect(projectEvent(event)).toEqual({ type: "message_update", subType: "toolcall_start" });
  });

  it("strips Model instances from model_update", () => {
    const fakeModel = { provider: "anthropic", id: "claude-sonnet-4-5", stream: () => {} };
    const event = {
      type: "model_update",
      model: fakeModel,
      previousModel: undefined,
      source: "set",
    } as unknown as AgentHarnessEvent;
    const projected = projectEvent(event);
    expect(projected).toEqual({
      type: "model_update",
      provider: "anthropic",
      modelId: "claude-sonnet-4-5",
      source: "set",
    });
    assertJsonSafe(projected);
    // The stream function must not leak into the projected output.
    const serialized = JSON.stringify(projected);
    expect(serialized).not.toContain("stream");
  });

  it("strips AbortSignal from session_before_compact (hook-only)", () => {
    const event = {
      type: "session_before_compact",
      preparation: {},
      branchEntries: [],
      signal: new AbortController().signal,
    } as unknown as AgentHarnessEvent;
    const projected = projectEvent(event);
    assertJsonSafe(projected);
    expect(projected._raw).toBe("hook");
  });

  it("collapses unknown event types without throwing", () => {
    const event = { type: "totally_unknown_future_event" } as unknown as AgentHarnessEvent;
    const projected = projectEvent(event);
    expect(projected).toEqual({ type: "totally_unknown_future_event", _raw: "unknown" });
    assertJsonSafe(projected);
  });

  it("projects queue_update as counts only", () => {
    const event = {
      type: "queue_update",
      steer: [{ role: "user", content: "a" } as never],
      followUp: [],
      nextTurn: [{ role: "user", content: "b" } as never],
    } as unknown as AgentHarnessEvent;
    expect(projectEvent(event)).toEqual({
      type: "queue_update",
      steer: 1,
      followUp: 0,
      nextTurn: 1,
    });
  });

  it("projects save_point", () => {
    const event = { type: "save_point", hadPendingMutations: true } as unknown as AgentHarnessEvent;
    expect(projectEvent(event)).toEqual({ type: "save_point", hadPendingMutations: true });
  });

  it("projects abort as counts", () => {
    const event = {
      type: "abort",
      clearedSteer: [{ role: "user", content: "x" } as never],
      clearedFollowUp: [] as never[],
    } as unknown as AgentHarnessEvent;
    expect(projectEvent(event)).toEqual({ type: "abort", clearedSteer: 1, clearedFollowUp: 0 });
  });

  it("projects before_agent_start with string systemPrompt", () => {
    const event = {
      type: "before_agent_start",
      prompt: "hello",
      systemPrompt: "you are novi",
      resources: { skills: [] },
    } as unknown as AgentHarnessEvent;
    expect(projectEvent(event)).toEqual({
      type: "before_agent_start",
      prompt: "hello",
      systemPrompt: "you are novi",
    });
  });

  it("projects context with message count", () => {
    const event = {
      type: "context",
      messages: [
        { role: "user", content: "a" } as never,
        { role: "assistant", content: "b" } as never,
      ],
    } as unknown as AgentHarnessEvent;
    expect(projectEvent(event)).toEqual({ type: "context", messageCount: 2 });
  });

  it("projects before_provider_request stripping Model + streamOptions", () => {
    const event = {
      type: "before_provider_request",
      model: { provider: "anthropic", id: "claude-sonnet-4-5", stream: () => {} },
      sessionId: "s1",
      streamOptions: { timeoutMs: 5000, transport: () => {} },
    } as unknown as AgentHarnessEvent;
    const projected = projectEvent(event);
    expect(projected).toEqual({
      type: "before_provider_request",
      provider: "anthropic",
      modelId: "claude-sonnet-4-5",
      sessionId: "s1",
    });
    assertJsonSafe(projected);
  });

  it("projects after_provider_response with status + headers", () => {
    const event = {
      type: "after_provider_response",
      status: 200,
      headers: { "content-type": "application/json" },
    } as unknown as AgentHarnessEvent;
    expect(projectEvent(event)).toEqual({
      type: "after_provider_response",
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  it("emits the exact breaking tool schema and suppresses hook duplicates", () => {
    const projector = new HeadlessEventProjector();
    const start = projector.project({
      type: "tool_execution_start",
      toolCallId: "tc1",
      toolName: "bash",
      args: { command: "pwd" },
    } as AgentHarnessEvent);
    const delta = projector.project({
      type: "tool_execution_update",
      toolCallId: "tc1",
      toolName: "bash",
      args: { command: "pwd" },
      partialResult: {
        content: [{ type: "text", text: "/repo" }],
        details: { sequence: 1 },
      },
    } as AgentHarnessEvent);
    const end = projector.project({
      type: "tool_execution_end",
      toolCallId: "tc1",
      toolName: "bash",
      result: { content: [{ type: "text", text: "/repo" }], details: {} },
      isError: false,
    } as AgentHarnessEvent);

    expect(start).toMatchObject({ type: "tool.start", toolCallId: "tc1" });
    expect(delta).toEqual({
      type: "tool.delta",
      toolCallId: "tc1",
      sequence: 1,
      delta: "/repo",
      at: expect.any(Number),
    });
    expect(end).toMatchObject({
      type: "tool.end",
      toolCallId: "tc1",
      result: { version: 1, status: "success", preview: "/repo" },
    });
    expect(JSON.stringify([start, delta, end])).not.toContain("toolName");
    expect(
      projector.project({ type: "tool_call", toolCallId: "tc1" } as AgentHarnessEvent),
    ).toBeUndefined();
  });

  it("forwards a persisted MCP envelope without inventing a surface payload", () => {
    const envelope = {
      version: 1 as const,
      status: "success" as const,
      data: { mcp: { source: "mcp:demo", tool: "speak", revision: "rev-1" } },
      preview: "stored privately",
      metrics: { startedAt: 1, durationMs: 2, outputBytes: 16, outputLines: 1 },
      truncation: { truncated: false, reasons: [], shownBytes: 16, shownLines: 1 },
      artifacts: [{ kind: "document" as const, path: "/private/content.bin", bytes: 3 }],
    };
    const projected = projectEvent({
      type: "tool_execution_end",
      toolCallId: "mcp-call",
      toolName: "mcp_demo_speak",
      result: { content: [{ type: "text", text: "stored privately" }], details: { envelope } },
      isError: false,
    } as AgentHarnessEvent);

    expect(projected).toEqual({
      type: "tool.end",
      toolCallId: "mcp-call",
      result: envelope,
      at: expect.any(Number),
    });
    expect(JSON.stringify(projected)).not.toContain("toolName");
  });

  it("projects session_compact from compactionEntry", () => {
    const event = {
      type: "session_compact",
      compactionEntry: { firstKeptEntryId: "e1", tokensBefore: 9999, summary: "..." },
      fromHook: false,
    } as unknown as AgentHarnessEvent;
    expect(projectEvent(event)).toEqual({
      type: "session_compact",
      firstKeptEntryId: "e1",
      tokensBefore: 9999,
      fromHook: false,
    });
  });

  it("projects session_tree", () => {
    const event = {
      type: "session_tree",
      newLeafId: "new",
      oldLeafId: "old",
      fromHook: true,
    } as unknown as AgentHarnessEvent;
    expect(projectEvent(event)).toEqual({
      type: "session_tree",
      newLeafId: "new",
      oldLeafId: "old",
      fromHook: true,
    });
  });

  it("projects thinking_level_update", () => {
    const event = {
      type: "thinking_level_update",
      level: "high",
      previousLevel: "medium",
    } as unknown as AgentHarnessEvent;
    expect(projectEvent(event)).toEqual({
      type: "thinking_level_update",
      level: "high",
      previousLevel: "medium",
    });
  });

  it("projects resources_update as skill/template names", () => {
    const event = {
      type: "resources_update",
      resources: {
        skills: [{ name: "s1", description: "d", content: "x", filePath: "/a" }],
        promptTemplates: [{ name: "t1", content: "y" }],
      },
      previousResources: { skills: [], promptTemplates: [] },
    } as unknown as AgentHarnessEvent;
    expect(projectEvent(event)).toEqual({
      type: "resources_update",
      skills: ["s1"],
      promptTemplates: ["t1"],
    });
    assertJsonSafe(projectEvent(event));
  });

  it("projects tools_update", () => {
    const event = {
      type: "tools_update",
      toolNames: ["bash", "read"],
      previousToolNames: ["bash"],
      activeToolNames: ["bash"],
      previousActiveToolNames: [],
      source: "set",
    } as unknown as AgentHarnessEvent;
    expect(projectEvent(event)).toEqual({
      type: "tools_update",
      toolNames: ["bash", "read"],
      activeToolNames: ["bash"],
      source: "set",
    });
  });

  it("projects descriptor metadata and unavailable reasons", () => {
    const catalog = {
      descriptors: [
        {
          name: "web_search",
          label: "Web Search",
          source: { kind: "builtin" as const, id: "builtin" },
          capabilities: ["network.search" as const],
          risk: "network" as const,
          defaultPermission: "allow" as const,
          defaultEnabled: true,
          streaming: "none" as const,
          modes: ["tui" as const, "print" as const, "json" as const, "gateway" as const],
          optional: true,
        },
      ],
      activeToolNames: [],
      availability: [
        {
          name: "web_search",
          source: { kind: "builtin" as const, id: "builtin" },
          status: "unavailable" as const,
          reasonCode: "INITIALIZATION_FAILED" as const,
          reason: "missing BRAVE_API_KEY",
        },
      ],
      diagnostics: ['tool "web_search" unavailable: missing BRAVE_API_KEY'],
    };
    expect(projectToolCatalog(catalog, "bootstrap")).toEqual({
      type: "tools_update",
      source: "bootstrap",
      activeToolNames: [],
      tools: [
        {
          name: "web_search",
          label: "Web Search",
          source: { kind: "builtin", id: "builtin" },
          capabilities: ["network.search"],
          risk: "network",
          modes: ["tui", "print", "json", "gateway"],
          status: "unavailable",
          reasonCode: "INITIALIZATION_FAILED",
          reason: "missing BRAVE_API_KEY",
        },
      ],
      diagnostics: ['tool "web_search" unavailable: missing BRAVE_API_KEY'],
    });

    const event = {
      type: "tools_update",
      toolNames: [],
      previousToolNames: [],
      activeToolNames: [],
      previousActiveToolNames: [],
      source: "set",
    } as unknown as AgentHarnessEvent;
    expect(projectEvent(event, catalog)).toMatchObject({
      type: "tools_update",
      source: "set",
      tools: [{ name: "web_search", status: "unavailable" }],
    });
  });

  it("projects session_before_tree (hook-only) without signal", () => {
    const event = {
      type: "session_before_tree",
      preparation: {},
      signal: new AbortController().signal,
    } as unknown as AgentHarnessEvent;
    const projected = projectEvent(event);
    assertJsonSafe(projected);
    expect(projected._raw).toBe("hook");
  });
});
