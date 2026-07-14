import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import type { JsonlSessionMetadata } from "@earendil-works/pi-agent-core/node";
import { GatewaySessionStore } from "./session-store.js";
import { sessionKeyForLocator } from "./routing.js";
import type { GatewaySessionRoute } from "./types.js";

const paths: string[] = [];

afterEach(async () => {
  await Promise.all(paths.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

function route(chatId: string): GatewaySessionRoute {
  const locator = {
    channel: "telegram" as const,
    account: "primary",
    chat: { type: "direct" as const, id: chatId },
  };
  return { key: sessionKeyForLocator(locator), locator };
}

function metadata(id: string): JsonlSessionMetadata {
  return {
    id,
    createdAt: "2026-07-14T00:00:00.000Z",
    cwd: "/workspace",
    path: `/sessions/${id}.jsonl`,
  };
}

async function storePath(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "novi-session-store-"));
  paths.push(dir);
  return path.join(dir, "gateway-sessions.json");
}

describe("GatewaySessionStore", () => {
  it("treats a missing file as empty and round-trips a binding", async () => {
    const file = await storePath();
    const first = await GatewaySessionStore.open(file);
    expect(first.getBinding(route("one"))).toBeUndefined();
    await first.bind(route("one"), metadata("s1"));

    const reopened = await GatewaySessionStore.open(file);
    expect(reopened.getBinding(route("one"))?.session).toEqual(metadata("s1"));
    expect((await readFile(file, "utf8")).endsWith("\n")).toBe(true);
  });

  it("allows multiple locators to reference the same session metadata", async () => {
    const store = await GatewaySessionStore.open(await storePath());
    await store.bind(route("one"), metadata("shared"));
    await store.bind(route("two"), metadata("shared"));
    expect(store.getBinding(route("one"))?.session.id).toBe("shared");
    expect(store.getBinding(route("two"))?.session.id).toBe("shared");
  });

  it("rotates the binding and appends a lightweight archive record", async () => {
    const store = await GatewaySessionStore.open(await storePath());
    await store.bind(route("one"), metadata("old"));
    await store.rotate(route("one"), metadata("new"));
    expect(store.getBinding(route("one"))?.session.id).toBe("new");
    expect(store.getArchives()).toEqual([
      expect.objectContaining({ session: metadata("old"), reason: "new" }),
    ]);
  });

  it.each([
    ["invalid JSON", "{"],
    ["unknown version", JSON.stringify({ version: 2, bindings: {}, archives: [] })],
    ["invalid fields", JSON.stringify({ version: 1, bindings: [], archives: [] })],
  ])("rejects %s without replacing the file", async (_label, contents) => {
    const file = await storePath();
    await writeFile(file, contents, "utf8");
    await expect(GatewaySessionStore.open(file)).rejects.toThrow();
    expect(await readFile(file, "utf8")).toBe(contents);
  });

  it("rejects a binding whose key does not match its locator", async () => {
    const file = await storePath();
    const now = "2026-07-14T00:00:00.000Z";
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        bindings: {
          wrong: {
            locator: route("one").locator,
            session: metadata("s1"),
            boundAt: now,
            updatedAt: now,
          },
        },
        archives: [],
      }),
      "utf8",
    );
    await expect(GatewaySessionStore.open(file)).rejects.toThrow(/does not match/);
  });

  it("does not publish an in-memory binding when persistence fails", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "novi-session-store-fail-"));
    paths.push(dir);
    const blocker = path.join(dir, "not-a-directory");
    const store = await GatewaySessionStore.open(path.join(blocker, "sessions.json"));
    await writeFile(blocker, "block", "utf8");
    await expect(store.bind(route("one"), metadata("s1"))).rejects.toThrow();
    expect(store.getBinding(route("one"))).toBeUndefined();
  });
});
