import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { GatewayApp } from "./gateway-app.js";
import { GatewaySessionManager } from "./session-manager.js";
import { createCommandRegistry } from "./commands.js";
import { PairingStore } from "./pairing-store.js";
import type {
  AgentProtocolAdapter,
  AgentProtocolTurnInput,
  ChannelAdapter,
  ChannelMessage,
} from "./types.js";
import type { ResolvedGatewayConfig } from "../config.js";
import { GatewayMessageStore } from "../messages/store.js";

const paths: string[] = [];
afterEach(async () => {
  await Promise.all(paths.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

function config(dmPolicy: ResolvedGatewayConfig["security"]["dmPolicy"]): ResolvedGatewayConfig {
  return {
    queue: { mode: "steer", byChannel: {} },
    stream: { editIntervalMs: 1000 },
    session: { idleTimeoutMs: 1, maxConcurrent: 1 },
    security: {
      allowlist: new Set(["legacy"]),
      adminAllowlist: new Set(["admin"]),
      dmPolicy,
      groupPolicy: "disabled",
      pairing: { ttlMs: 1000, maxPending: 3 },
    },
    telegram: {
      groups: {
        allowlist: new Set(),
        requireMention: true,
        mentionPatterns: [],
        ignoredThreadIds: new Set(),
        senderAllowlist: new Set(),
      },
    },
    channels: [],
    delivery: {
      rateLimit: { accountPerSecond: 25, directPerSecond: 1, groupPerMinute: 20 },
    },
    automation: {
      timezone: "UTC",
      allowedTools: ["read_file", "ls", "glob", "grep", "web_search", "fetch_content"],
      minCronIntervalMs: 300_000,
      runTimeoutMs: 120_000,
      maxExecutionRetries: 1,
      maxDeliveryRetries: 3,
      maxConcurrentLlmRuns: 2,
      dailyTokenLimit: 200_000,
      dailyCostUsd: 1,
      retentionDays: 30,
      maxRunsPerJob: 100,
      maxResultBytes: 65_536,
    },
    heartbeat: { enabled: false, everyMs: 1_800_000 },
    operations: {
      alertCooldownMs: 3_600_000,
      backlogRecords: 100,
      backlogAgeMs: 900_000,
      channelDownMs: 300_000,
    },
  };
}
function agent(): AgentProtocolAdapter {
  return {
    runTurn: vi.fn(),
    steer: vi.fn(),
    followUp: vi.fn(),
    abort: vi.fn(),
    resetSession: vi.fn(),
    appendScheduledDelivery: vi.fn(),
    closeSession: vi.fn(),
    stop: vi.fn(),
  };
}
function channel(): ChannelAdapter {
  return {
    id: "tg",
    type: "telegram",
    capabilities: { chatTypes: ["direct"] },
    textChunkLimit: 4096,
    start: vi.fn(),
    stop: vi.fn(),
    send: vi.fn(),
  };
}
function message(): ChannelMessage {
  return {
    id: "m",
    remoteChatId: "chat",
    chatType: "direct",
    senderId: "paired",
    text: "hello",
    timestamp: new Date(),
  };
}

describe("GatewayApp DM authorization", () => {
  it("does not let a pairing approval bypass dmPolicy=allowlist", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "novi-gateway-app-"));
    paths.push(dir);
    const store = new PairingStore(path.join(dir, "pairing.json"));
    const requested = await store.request("tg", "paired", 1000, 3);
    await store.approve("tg", requested.code!);
    const app = new GatewayApp({
      channels: [],
      agent: agent(),
      sessionManager: new GatewaySessionManager({
        agent: agent(),
        idleTimeoutMs: 1,
        maxConcurrentSessions: 1,
        queueMode: "steer",
      }),
      queueMode: "steer",
      config: config("allowlist"),
      commands: createCommandRegistry(),
      pairingStore: store,
    });
    const allowed = await (
      app as unknown as {
        isAuthorized(channel: ChannelAdapter, msg: ChannelMessage): Promise<boolean>;
      }
    ).isAuthorized(channel(), message());
    expect(allowed).toBe(false);
  });

  it("lets a dedicated administrator approve pairing without granting a normal turn", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "novi-gateway-app-"));
    paths.push(dir);
    const store = new PairingStore(path.join(dir, "pairing.json"));
    const requested = await store.request("tg", "paired", 1000, 3);
    const adapter = agent();
    const outbound = channel();
    const app = new GatewayApp({
      channels: [],
      agent: adapter,
      sessionManager: new GatewaySessionManager({
        agent: adapter,
        idleTimeoutMs: 1,
        maxConcurrentSessions: 1,
        queueMode: "steer",
      }),
      queueMode: "steer",
      config: config("pairing"),
      commands: createCommandRegistry(),
      pairingStore: store,
    });
    await app.onInbound(outbound, {
      ...message(),
      id: "admin-approve",
      senderId: "admin",
      text: `/pair approve ${requested.code}`,
    });
    expect(outbound.send).toHaveBeenCalledWith({ chatId: "chat" }, "Pairing approved.");
    expect(adapter.runTurn).not.toHaveBeenCalled();
    const allowed = await (
      app as unknown as {
        isAuthorized(channel: ChannelAdapter, msg: ChannelMessage): Promise<boolean>;
      }
    ).isAuthorized(outbound, { ...message(), senderId: "admin" });
    expect(allowed).toBe(false);
  });

  it("atomically reloads only policy fields", () => {
    const adapter = agent();
    const app = new GatewayApp({
      channels: [],
      agent: adapter,
      sessionManager: new GatewaySessionManager({
        agent: adapter,
        idleTimeoutMs: 1,
        maxConcurrentSessions: 1,
        queueMode: "steer",
      }),
      queueMode: "steer",
      config: config("pairing"),
      commands: createCommandRegistry(),
    });
    expect(app.reloadPolicy(config("open"))).toBe(true);
    const restartRequired = config("open");
    restartRequired.stream.editIntervalMs = 2000;
    expect(app.reloadPolicy(restartRequired)).toBe(false);
  });

  it("does not allow an administrator to approve pairing from a disabled group", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "novi-gateway-app-"));
    paths.push(dir);
    const store = new PairingStore(path.join(dir, "pairing.json"));
    const approve = vi.spyOn(store, "approve");
    const adapter = agent();
    const outbound = channel();
    const app = new GatewayApp({
      channels: [],
      agent: adapter,
      sessionManager: new GatewaySessionManager({
        agent: adapter,
        idleTimeoutMs: 1,
        maxConcurrentSessions: 1,
        queueMode: "steer",
      }),
      queueMode: "steer",
      config: config("pairing"),
      commands: createCommandRegistry(),
      pairingStore: store,
    });
    await app.onInbound(outbound, {
      ...message(),
      id: "group-approve",
      chatType: "group",
      senderId: "admin",
      text: "/pair approve CODE",
    });
    expect(approve).not.toHaveBeenCalled();
    expect(outbound.send).not.toHaveBeenCalled();
  });

  it("never routes group pairing approval text to the agent even when groups are open", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "novi-gateway-app-"));
    paths.push(dir);
    const store = new PairingStore(path.join(dir, "pairing.json"));
    const adapter = agent();
    const outbound = channel();
    const resolved = config("pairing");
    resolved.security.groupPolicy = "open";
    resolved.telegram.groups.requireMention = false;
    const app = new GatewayApp({
      channels: [],
      agent: adapter,
      sessionManager: new GatewaySessionManager({
        agent: adapter,
        idleTimeoutMs: 1,
        maxConcurrentSessions: 1,
        queueMode: "steer",
      }),
      queueMode: "steer",
      config: resolved,
      commands: createCommandRegistry(),
      pairingStore: store,
    });
    await app.onInbound(outbound, {
      ...message(),
      id: "open-group-approve",
      chatType: "group",
      senderId: "admin",
      text: "/pair approve CODE",
    });
    expect(adapter.runTurn).not.toHaveBeenCalled();
    expect(outbound.send).not.toHaveBeenCalled();
  });
});

describe("GatewayApp durable ingress", () => {
  it("persists before Agent dispatch and deduplicates a redelivered update", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "novi-gateway-durable-"));
    paths.push(dir);
    const messageStore = await GatewayMessageStore.open(path.join(dir, "messages"));
    const pairingStore = new PairingStore(path.join(dir, "pairing.json"));
    const baseAgent = agent();
    const runTurn = vi.fn(async (input: AgentProtocolTurnInput) => {
      expect(messageStore.listInbox()).toEqual([expect.objectContaining({ status: "processing" })]);
      await input.callbacks?.onTurnEnd?.("done");
      return { text: "done" };
    });
    const adapter = { ...baseAgent, runTurn };
    const outbound = channel();
    vi.mocked(outbound.send).mockImplementation(async () => {
      expect(messageStore.listOutbox()).toEqual([
        expect.objectContaining({ status: "sending", text: "done" }),
      ]);
      return { messageIds: ["telegram-42"] };
    });
    const resolved = config("open");
    const sessionManager = new GatewaySessionManager({
      agent: adapter,
      idleTimeoutMs: 60_000,
      maxConcurrentSessions: 1,
      queueMode: "steer",
    });
    const app = new GatewayApp({
      channels: [outbound],
      agent: adapter,
      sessionManager,
      queueMode: "steer",
      config: resolved,
      commands: createCommandRegistry(),
      pairingStore,
      messageStore,
    });
    const inbound = { ...message(), metadata: { updateId: 42 } };

    await app.start();
    await app.onInbound(outbound, inbound);
    await vi.waitFor(() => expect(runTurn).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(messageStore.listInbox()[0]?.status).toBe("completed"));
    await vi.waitFor(() => expect(messageStore.listOutbox()[0]?.status).toBe("delivered"));
    await app.onInbound(outbound, inbound);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await app.stop();

    expect(runTurn).toHaveBeenCalledTimes(1);
    expect(messageStore.listInbox()).toHaveLength(1);
  });

  it("queues operations alerts durably and excludes their failures from alert faults", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "novi-gateway-alert-"));
    paths.push(dir);
    const messageStore = await GatewayMessageStore.open(path.join(dir, "messages"));
    const adapter = agent();
    const outbound = channel();
    const app = new GatewayApp({
      channels: [outbound],
      agent: adapter,
      sessionManager: new GatewaySessionManager({
        agent: adapter,
        idleTimeoutMs: 1,
        maxConcurrentSessions: 1,
        queueMode: "steer",
      }),
      queueMode: "steer",
      config: config("open"),
      commands: createCommandRegistry(),
      messageStore,
    });
    await app.enqueueOperationAlert(
      {
        channel: "telegram",
        account: "tg",
        chat: { type: "direct", id: "chat" },
      },
      "alert-source",
      "Gateway alert",
    );
    const [record] = messageStore.listOutbox();
    expect(record).toMatchObject({
      source: { kind: "system", purpose: "alert" },
      status: "pending",
      suppressAlerts: true,
    });
    await messageStore.updateOutbox(record!.id, (current) => ({
      ...current,
      status: "sending",
      attempt: 1,
      startedAt: new Date().toISOString(),
    }));
    await messageStore.updateOutbox(record!.id, (current) => ({
      ...current,
      status: "delivery_failed",
      finishedAt: new Date().toISOString(),
      error: { code: "CHANNEL_SEND_FAILED", message: "failed", retryable: false },
    }));
    expect(app.runtimeComponents().messages?.exhaustedCount).toBe(0);
  });
});
