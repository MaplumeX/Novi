import { describe, expect, it, vi } from "vitest";
import type { AgentHarnessEvent } from "@earendil-works/pi-agent-core/node";
import { createEventBridge } from "./event-bridge.js";
import type { AgentProtocolTurnCallbacks } from "../core/types.js";

/**
 * Build a fake `AgentHarness` whose `subscribe` captures the listener so tests
 * can manually emit events. Mirrors the harness mock pattern from
 * `compaction.test.ts`.
 */
function makeHarnessMock(): {
  harness: unknown;
  emit: (event: AgentHarnessEvent) => void;
  unsubscribe: ReturnType<typeof vi.fn>;
} {
  let listener: ((event: AgentHarnessEvent) => void) | null = null;
  const unsubscribe = vi.fn(() => {
    listener = null;
  });
  const subscribe = vi.fn((fn: (event: AgentHarnessEvent) => void) => {
    listener = fn;
    return unsubscribe;
  });
  return {
    harness: { subscribe } as unknown as Parameters<typeof createEventBridge>[0],
    emit: (event: AgentHarnessEvent) => listener?.(event),
    unsubscribe,
  };
}

describe("createEventBridge", () => {
  it("maps turn_start → onTyping", () => {
    const { harness, emit } = makeHarnessMock();
    const onTyping = vi.fn();
    const unsub = createEventBridge(harness as never, { onTyping });
    emit({ type: "turn_start" } as AgentHarnessEvent);
    expect(onTyping).toHaveBeenCalledTimes(1);
    unsub();
  });

  it("maps message_update text_delta → onTextDelta(delta)", () => {
    const { harness, emit } = makeHarnessMock();
    const onTextDelta = vi.fn();
    const unsub = createEventBridge(harness as never, { onTextDelta });
    emit({
      type: "message_update",
      message: { role: "assistant", content: [] } as never,
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "hello",
        partial: {} as never,
      },
    } as AgentHarnessEvent);
    expect(onTextDelta).toHaveBeenCalledWith("hello");
    unsub();
  });

  it("maps message_update thinking_delta → onReasoningDelta(delta)", () => {
    const { harness, emit } = makeHarnessMock();
    const onReasoningDelta = vi.fn();
    const unsub = createEventBridge(harness as never, { onReasoningDelta });
    emit({
      type: "message_update",
      message: { role: "assistant", content: [] } as never,
      assistantMessageEvent: {
        type: "thinking_delta",
        contentIndex: 0,
        delta: "thinking...",
        partial: {} as never,
      },
    } as AgentHarnessEvent);
    expect(onReasoningDelta).toHaveBeenCalledWith("thinking...");
    unsub();
  });

  it("maps tool_execution_start → onToolCall(name, 'running')", () => {
    const { harness, emit } = makeHarnessMock();
    const onToolCall = vi.fn();
    const unsub = createEventBridge(harness as never, { onToolCall });
    emit({
      type: "tool_execution_start",
      toolCallId: "tc1",
      toolName: "bash",
      args: {},
    } as AgentHarnessEvent);
    expect(onToolCall).toHaveBeenCalledWith("bash", "running");
    unsub();
  });

  it("maps tool_execution_end (success) → onToolCall(name, 'done')", () => {
    const { harness, emit } = makeHarnessMock();
    const onToolCall = vi.fn();
    const unsub = createEventBridge(harness as never, { onToolCall });
    emit({
      type: "tool_execution_end",
      toolCallId: "tc1",
      toolName: "bash",
      result: {},
      isError: false,
    } as AgentHarnessEvent);
    expect(onToolCall).toHaveBeenCalledWith("bash", "done");
    unsub();
  });

  it("maps tool_execution_end (error) → onToolCall(name, 'error')", () => {
    const { harness, emit } = makeHarnessMock();
    const onToolCall = vi.fn();
    const unsub = createEventBridge(harness as never, { onToolCall });
    emit({
      type: "tool_execution_end",
      toolCallId: "tc1",
      toolName: "bash",
      result: {},
      isError: true,
    } as AgentHarnessEvent);
    expect(onToolCall).toHaveBeenCalledWith("bash", "error");
    unsub();
  });

  it("buffers message_end (assistant) text and flushes on agent_end", () => {
    const { harness, emit } = makeHarnessMock();
    const onTurnEnd = vi.fn();
    const unsub = createEventBridge(harness as never, { onTurnEnd });
    emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "part1" },
          { type: "text", text: "part2" },
        ],
      } as never,
    } as AgentHarnessEvent);
    // Not yet — agent_end has not fired.
    expect(onTurnEnd).not.toHaveBeenCalled();
    emit({ type: "agent_end", messages: [] } as AgentHarnessEvent);
    expect(onTurnEnd).toHaveBeenCalledWith("part1part2");
    unsub();
  });

  it("keeps only the latest assistant text across a multi-turn run", () => {
    // A tool-call run emits two assistant message_end events: the tool-call
    // narration, then the final reply. Only the final reply should surface.
    const { harness, emit } = makeHarnessMock();
    const onTurnEnd = vi.fn();
    const unsub = createEventBridge(harness as never, { onTurnEnd });
    emit({
      type: "message_end",
      message: { role: "assistant", content: "let me search" } as never,
    } as AgentHarnessEvent);
    emit({
      type: "message_end",
      message: { role: "assistant", content: "final answer" } as never,
    } as AgentHarnessEvent);
    emit({ type: "agent_end", messages: [] } as AgentHarnessEvent);
    expect(onTurnEnd).toHaveBeenCalledTimes(1);
    expect(onTurnEnd).toHaveBeenCalledWith("final answer");
    unsub();
  });

  it("ignores message_end for non-assistant roles", () => {
    const { harness, emit } = makeHarnessMock();
    const onTurnEnd = vi.fn();
    const unsub = createEventBridge(harness as never, { onTurnEnd });
    emit({
      type: "message_end",
      message: { role: "user", content: "hello" } as never,
    } as AgentHarnessEvent);
    emit({ type: "agent_end", messages: [] } as AgentHarnessEvent);
    // No assistant text buffered → onTurnEnd fires with empty string.
    expect(onTurnEnd).toHaveBeenCalledWith("");
    unsub();
  });

  it("ignores message_update sub-types that are not text/thinking delta", () => {
    const { harness, emit } = makeHarnessMock();
    const onTextDelta = vi.fn();
    const onReasoningDelta = vi.fn();
    const unsub = createEventBridge(harness as never, { onTextDelta, onReasoningDelta });
    emit({
      type: "message_update",
      message: { role: "assistant", content: [] } as never,
      assistantMessageEvent: {
        type: "toolcall_start",
        contentIndex: 0,
        partial: {} as never,
      },
    } as AgentHarnessEvent);
    expect(onTextDelta).not.toHaveBeenCalled();
    expect(onReasoningDelta).not.toHaveBeenCalled();
    unsub();
  });

  it("does not fire callbacks for irrelevant event types", () => {
    const { harness, emit } = makeHarnessMock();
    const callbacks: AgentProtocolTurnCallbacks = {
      onTyping: vi.fn(),
      onTextDelta: vi.fn(),
      onReasoningDelta: vi.fn(),
      onToolCall: vi.fn(),
      onTurnEnd: vi.fn(),
    };
    const unsub = createEventBridge(harness as never, callbacks);
    // agent_start / turn_end should not trigger any callback.
    emit({ type: "agent_start" } as AgentHarnessEvent);
    emit({
      type: "turn_end",
      message: { role: "assistant", content: [] } as never,
      toolResults: [],
    } as AgentHarnessEvent);
    expect(callbacks.onTyping).not.toHaveBeenCalled();
    expect(callbacks.onTextDelta).not.toHaveBeenCalled();
    expect(callbacks.onReasoningDelta).not.toHaveBeenCalled();
    expect(callbacks.onToolCall).not.toHaveBeenCalled();
    expect(callbacks.onTurnEnd).not.toHaveBeenCalled();
    // agent_end with no buffered assistant text fires onTurnEnd("").
    emit({ type: "agent_end", messages: [] } as AgentHarnessEvent);
    expect(callbacks.onTurnEnd).toHaveBeenCalledWith("");
    unsub();
  });

  it("returns the unsubscribe function from harness.subscribe", () => {
    const { harness, unsubscribe } = makeHarnessMock();
    const unsub = createEventBridge(harness as never, {});
    unsub();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});