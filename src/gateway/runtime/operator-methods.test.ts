import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sessionKeyForLocator } from "../core/routing.js";
import { GatewayMessageService } from "../messages/service.js";
import { GatewayMessageStore } from "../messages/store.js";
import { createInboxRecord } from "../messages/types.js";
import { createMessageControlMethods } from "./operator-methods.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
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
