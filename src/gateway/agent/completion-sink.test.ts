import { describe, expect, it, vi } from "vitest";
import { terminalDeliveryKey } from "../../runs/delivery.js";
import type { AgentRun } from "../../agents/types.js";
import { completionPayload } from "../../agents/completion.js";
import { sessionKeyForLocator } from "../core/routing.js";
import type { ChannelAdapter, GatewaySessionRoute } from "../core/types.js";
import type { GatewaySessionManager } from "../core/session-manager.js";
import type { NoviAgentAdapter } from "./novi-agent-adapter.js";
import { GatewayAgentCompletionSink } from "./completion-sink.js";

describe("GatewayAgentCompletionSink", () => {
  it("serializes synthesis through the route lane and hands final text to durable delivery", async () => {
    const run = agentRun();
    const payload = completionPayload(run);
    const sessionManager = {
      enqueueSystemOperation: vi.fn(async (_route, operation) => operation()),
    } as unknown as GatewaySessionManager;
    const agent = {
      runAgentCompletion: vi.fn().mockResolvedValue({ parentEntryId: "entry_1", text: "summary" }),
    } as unknown as NoviAgentAdapter;
    const outbound = channel();
    const durable = vi.fn().mockResolvedValue(undefined);
    const sink = new GatewayAgentCompletionSink(sessionManager, agent, [outbound]);
    sink.setFinalDelivery(durable);

    await expect(sink.deliver(run, payload)).resolves.toEqual({ parentEntryId: "entry_1" });
    expect(sessionManager.enqueueSystemOperation).toHaveBeenCalledWith(
      run.parent.route,
      expect.any(Function),
    );
    expect(durable).toHaveBeenCalledWith(outbound, run, payload, "summary");
    expect(outbound.send).not.toHaveBeenCalled();
  });

  it("rejects a non-canonical persisted parent route", async () => {
    const run = agentRun();
    run.parent.route = { ...run.parent.route!, key: "forged" };
    const sink = new GatewayAgentCompletionSink(
      {} as GatewaySessionManager,
      {} as NoviAgentAdapter,
      [channel()],
    );
    await expect(sink.deliver(run, completionPayload(run))).rejects.toMatchObject({
      code: "PARENT_ROUTE_UNAVAILABLE",
      retryable: false,
    });
  });
});

function route(): GatewaySessionRoute {
  const locator = {
    channel: "telegram" as const,
    account: "primary",
    chat: { type: "direct" as const, id: "chat-1" },
  };
  return { key: sessionKeyForLocator(locator), locator };
}

function channel(): ChannelAdapter {
  return {
    id: "primary",
    type: "telegram",
    capabilities: { chatTypes: ["direct"] },
    textChunkLimit: 4096,
    start: vi.fn(),
    stop: vi.fn(),
    send: vi.fn().mockResolvedValue({ messageIds: ["message_1"] }),
  };
}

function agentRun(): AgentRun {
  const createdAt = "2026-07-17T00:00:00.000Z";
  return {
    version: 1,
    id: "run_1",
    task: "inspect",
    parent: {
      surface: "gateway",
      generation: "parent_1",
      route: route(),
      session: {
        id: "parent_1",
        createdAt,
        cwd: "/workspace",
        path: "/sessions/parent_1.jsonl",
      },
    },
    rootRunId: "run_1",
    depth: 1,
    profile: "explorer",
    contextMode: "isolated",
    workspace: { cwd: "/workspace", mode: "shared" },
    model: { provider: "anthropic", id: "model", thinking: "low" },
    policySnapshot: {
      profile: "explorer",
      writable: false,
      activeToolNames: [],
      skillNames: [],
      mcpSources: [],
      permissions: [],
      systemPrompt: "Read only.",
      runTimeoutMs: 1_000,
      maxResultBytes: 1_024,
    },
    status: "succeeded",
    attempt: 1,
    maxAttempts: 2,
    createdAt,
    queuedAt: createdAt,
    result: "child result",
    notify: true,
    completion: {
      status: "pending",
      idempotencyKey: terminalDeliveryKey("agent-run", "run_1"),
      attempt: 0,
    },
  };
}
