import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sessionKeyForLocator } from "../core/routing.js";
import { GatewayMessageService } from "../messages/service.js";
import { GatewayMessageStore } from "../messages/store.js";
import { createInboxRecord } from "../messages/types.js";
import { createAgentControlMethods, createMessageControlMethods } from "./operator-methods.js";
import type { AgentRunRuntime } from "../../agents/runtime.js";
import type { AgentRun } from "../../agents/types.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("agent control methods", () => {
  it("lists bounded summaries and mutates by the persisted owner", async () => {
    const run = {
      id: "run_1",
      task: "secret task body",
      result: "secret result body",
      profile: "explorer",
      status: "succeeded",
      depth: 1,
      attempt: 1,
      createdAt: "2026-07-17T00:00:00.000Z",
      parent: {
        surface: "gateway",
        generation: "parent_1",
        session: { id: "parent_1" },
      },
      completion: { status: "delivered" },
    } as AgentRun;
    const manager = {
      listAll: vi.fn().mockResolvedValue([run]),
      cancel: vi.fn().mockResolvedValue(run),
      retry: vi.fn().mockResolvedValue({ ...run, id: "run_2", status: "queued" }),
    };
    const runtime = {
      manager,
      getStats: vi.fn().mockResolvedValue({ total: 1, queued: 0, running: 0 }),
    } as unknown as AgentRunRuntime;
    const methods = createAgentControlMethods(runtime);

    const listed = await methods["agents.list"]!(undefined, {
      version: 1,
      id: "list",
      method: "agents.list",
    });
    expect(listed).toMatchObject({
      runs: [{ id: "run_1", parentSessionId: "parent_1", surface: "gateway" }],
    });
    expect(JSON.stringify(listed)).not.toContain("secret task body");
    expect(JSON.stringify(listed)).not.toContain("secret result body");

    await methods["agents.cancel"]!(
      { id: "run_1" },
      { version: 1, id: "cancel", method: "agents.cancel" },
    );
    expect(manager.cancel).toHaveBeenCalledWith(
      { parentSessionId: "parent_1", generation: "parent_1" },
      "run_1",
    );
  });
});

describe("message control methods", () => {
  it("lists body-free summaries and rejects malformed ids", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "novi-operator-"));
    roots.push(root);
    const store = await GatewayMessageStore.open(root);
    const locator = {
      channel: "telegram" as const,
      account: "primary",
      chat: { type: "direct" as const, id: "42" },
    };
    await store.createInbox(
      createInboxRecord({
        identity: { channel: "telegram", account: "primary", nativeUpdateId: "one" },
        route: { key: sessionKeyForLocator(locator), locator },
        message: {
          nativeMessageId: "message-1",
          senderId: "42",
          text: "secret message body",
          timestamp: "2026-07-15T00:00:00.000Z",
        },
      }),
    );
    const methods = createMessageControlMethods(new GatewayMessageService(store));

    const result = await methods["messages.list"]!(undefined, {
      version: 1,
      id: "list",
      method: "messages.list",
    });
    expect(result).toMatchObject({ records: [{ kind: "inbox", status: "received" }] });
    expect(JSON.stringify(result)).not.toContain("secret message body");
    await expect(
      methods["messages.retry"]!(
        { id: "bad" },
        { version: 1, id: "retry", method: "messages.retry" },
      ),
    ).rejects.toMatchObject({ controlMethodFailure: { code: "INVALID_PARAMS" } });
  });
});
