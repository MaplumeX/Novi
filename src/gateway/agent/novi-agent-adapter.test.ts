import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import type {
  AgentHarness,
  AgentHarnessEvent,
  JsonlSessionMetadata,
} from "@earendil-works/pi-agent-core/node";
import type { CreatedSession, GatewayEnv, HarnessSessionTarget } from "../../bootstrap.js";
import { sessionKeyForLocator } from "../core/routing.js";
import { GatewaySessionStore } from "../core/session-store.js";
import type { GatewaySessionRoute } from "../core/types.js";
import { NoviAgentAdapter } from "./novi-agent-adapter.js";

const paths: string[] = [];

afterEach(async () => {
  await Promise.all(paths.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

function route(): GatewaySessionRoute {
  const locator = {
    channel: "telegram" as const,
    account: "primary",
    chat: { type: "direct" as const, id: "chat-1" },
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

class FakeHarness {
  readonly prompt = vi.fn().mockResolvedValue(undefined);
  readonly steer = vi.fn().mockResolvedValue(undefined);
  readonly followUp = vi.fn().mockResolvedValue(undefined);
  readonly abort = vi.fn().mockResolvedValue(undefined);
  readonly waitForIdle = vi.fn().mockResolvedValue(undefined);
  private readonly subscribers = new Set<(event: AgentHarnessEvent) => void>();

  subscribe(callback: (event: AgentHarnessEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  emit(event: AgentHarnessEvent): void {
    for (const subscriber of this.subscribers) subscriber(event);
  }
}

function created(meta: JsonlSessionMetadata, harness = new FakeHarness()): CreatedSession {
  return {
    harness: harness as unknown as AgentHarness,
    session: { getMetadata: vi.fn().mockResolvedValue(meta) },
    metadata: meta,
    sessionPath: meta.path,
    permissionGate: {},
    toolCatalog: { descriptors: [] },
    permissionStore: {},
  } as unknown as CreatedSession;
}

async function store(): Promise<GatewaySessionStore> {
  const dir = await mkdtemp(path.join(tmpdir(), "novi-adapter-"));
  paths.push(dir);
  return GatewaySessionStore.open(path.join(dir, "gateway-sessions.json"));
}

const env = {} as GatewayEnv;

describe("NoviAgentAdapter", () => {
  it("persists the first session and cold-resumes it after cache eviction", async () => {
    const sessionStore = await store();
    const targets: HarnessSessionTarget[] = [];
    const factory = vi.fn(async (_env: GatewayEnv, target: HarnessSessionTarget) => {
      targets.push(target);
      const meta = target.kind === "resume" ? metadata("s1") : metadata("s1");
      return created(meta);
    });
    const adapter = new NoviAgentAdapter(env, sessionStore, factory);

    await adapter.runTurn({ route: route(), text: "first" });
    expect(sessionStore.getBinding(route())?.session.id).toBe("s1");
    await adapter.closeSession(route());
    await adapter.runTurn({ route: route(), text: "second" });

    expect(targets).toEqual([{ kind: "new" }, { kind: "resume", metadata: metadata("s1") }]);
  });

  it("cold-resumes through a newly loaded store after a process-style restart", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "novi-adapter-restart-"));
    paths.push(dir);
    const file = path.join(dir, "gateway-sessions.json");
    const firstStore = await GatewaySessionStore.open(file);
    const firstAdapter = new NoviAgentAdapter(env, firstStore, async () =>
      created(metadata("persistent")),
    );
    await firstAdapter.runTurn({ route: route(), text: "before restart" });
    await firstAdapter.stop();

    const targets: HarnessSessionTarget[] = [];
    const secondStore = await GatewaySessionStore.open(file);
    const secondAdapter = new NoviAgentAdapter(env, secondStore, async (_env, target) => {
      targets.push(target);
      return created(metadata("persistent"));
    });
    await secondAdapter.runTurn({ route: route(), text: "after restart" });
    expect(targets).toEqual([{ kind: "resume", metadata: metadata("persistent") }]);
  });

  it("deduplicates concurrent first initialization", async () => {
    const sessionStore = await store();
    let release!: (value: CreatedSession) => void;
    const factory = vi.fn(() => new Promise<CreatedSession>((resolve) => (release = resolve)));
    const adapter = new NoviAgentAdapter(env, sessionStore, factory);
    const first = adapter.runTurn({ route: route(), text: "one" });
    const second = adapter.runTurn({ route: route(), text: "two" });
    await vi.waitFor(() => expect(factory).toHaveBeenCalledTimes(1));
    release(created(metadata("shared")));
    await Promise.all([first, second]);
    expect(sessionStore.getBinding(route())?.session.id).toBe("shared");
  });

  it("waits for eviction close before cold-resuming the durable binding", async () => {
    const sessionStore = await store();
    const firstHarness = new FakeHarness();
    let releaseClose!: () => void;
    firstHarness.waitForIdle.mockImplementation(
      () => new Promise<void>((resolve) => (releaseClose = resolve)),
    );
    const factory = vi
      .fn()
      .mockResolvedValueOnce(created(metadata("stable"), firstHarness))
      .mockResolvedValueOnce(created(metadata("stable")));
    const adapter = new NoviAgentAdapter(env, sessionStore, factory);
    await adapter.runTurn({ route: route(), text: "first" });

    const closing = adapter.closeSession(route());
    const later = adapter.runTurn({ route: route(), text: "after eviction" });
    await Promise.resolve();
    expect(factory).toHaveBeenCalledTimes(1);
    releaseClose();
    await Promise.all([closing, later]);
    expect(factory).toHaveBeenNthCalledWith(2, env, {
      kind: "resume",
      metadata: metadata("stable"),
    });
  });

  it("preserves a dangling binding and requires explicit /new", async () => {
    const sessionStore = await store();
    await sessionStore.bind(route(), metadata("missing"));
    const factory = vi.fn(async (_env: GatewayEnv, target: HarnessSessionTarget) => {
      if (target.kind === "resume") throw new Error("ENOENT");
      return created(metadata("replacement"));
    });
    const adapter = new NoviAgentAdapter(env, sessionStore, factory);

    await expect(adapter.runTurn({ route: route(), text: "hello" })).rejects.toThrow(
      /binding was preserved; use \/new/i,
    );
    expect(sessionStore.getBinding(route())?.session.id).toBe("missing");

    await adapter.resetSession(route());
    expect(sessionStore.getBinding(route())?.session.id).toBe("replacement");
    expect(sessionStore.getArchives()[0]?.session.id).toBe("missing");
  });

  it("rejects metadata mismatches without changing the binding", async () => {
    const sessionStore = await store();
    await sessionStore.bind(route(), metadata("expected"));
    const adapter = new NoviAgentAdapter(env, sessionStore, async () =>
      created(metadata("actual")),
    );
    await expect(adapter.runTurn({ route: route(), text: "hello" })).rejects.toThrow(
      /mismatched id/,
    );
    expect(sessionStore.getBinding(route())?.session.id).toBe("expected");
  });

  it("suppresses late output and abort errors from the invalidated generation", async () => {
    const sessionStore = await store();
    const oldHarness = new FakeHarness();
    let rejectPrompt!: (reason: Error) => void;
    oldHarness.prompt.mockImplementation(
      () => new Promise<void>((_resolve, reject) => (rejectPrompt = reject)),
    );
    oldHarness.abort.mockImplementation(async () => {
      oldHarness.emit({ type: "agent_end", messages: [] } as unknown as AgentHarnessEvent);
      rejectPrompt(new Error("aborted"));
    });
    const factory = vi
      .fn()
      .mockResolvedValueOnce(created(metadata("old"), oldHarness))
      .mockResolvedValueOnce(created(metadata("new")));
    const adapter = new NoviAgentAdapter(env, sessionStore, factory);
    const onTurnEnd = vi.fn().mockResolvedValue(undefined);
    const running = adapter.runTurn({ route: route(), text: "hello", callbacks: { onTurnEnd } });
    await vi.waitFor(() => expect(oldHarness.prompt).toHaveBeenCalled());

    await adapter.resetSession(route());
    await expect(running).resolves.toEqual({ text: "" });
    expect(onTurnEnd).not.toHaveBeenCalled();
    expect(sessionStore.getBinding(route())?.session.id).toBe("new");
  });

  it("does not publish a cache entry when the first binding write fails", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "novi-adapter-fail-"));
    paths.push(dir);
    const blocker = path.join(dir, "blocker");
    const sessionStore = await GatewaySessionStore.open(path.join(blocker, "sessions.json"));
    await writeFile(blocker, "block", "utf8");
    const factory = vi.fn().mockResolvedValue(created(metadata("unbound")));
    const adapter = new NoviAgentAdapter(env, sessionStore, factory);

    await expect(adapter.runTurn({ route: route(), text: "hello" })).rejects.toThrow(
      /persist gateway session binding/i,
    );
    expect(sessionStore.getBinding(route())).toBeUndefined();
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("keeps the old binding recoverable when /new rotation fails", async () => {
    const durable = await store();
    await durable.bind(route(), metadata("old"));
    const failingStore = {
      getBinding: (current: GatewaySessionRoute) => durable.getBinding(current),
      bind: vi.fn(),
      rotate: vi.fn().mockRejectedValue(new Error("rename failed")),
    } as unknown as GatewaySessionStore;
    const targets: HarnessSessionTarget[] = [];
    const factory = vi.fn(async (_env: GatewayEnv, target: HarnessSessionTarget) => {
      targets.push(target);
      return created(target.kind === "new" ? metadata("unbound") : metadata("old"));
    });
    const adapter = new NoviAgentAdapter(env, failingStore, factory);

    await expect(adapter.resetSession(route())).rejects.toThrow(/rotate gateway session binding/i);
    expect(durable.getBinding(route())?.session.id).toBe("old");
    await adapter.runTurn({ route: route(), text: "resume old" });
    expect(targets).toEqual([{ kind: "new" }, { kind: "resume", metadata: metadata("old") }]);
  });

  it("passes images through to harness.prompt", async () => {
    const sessionStore = await store();
    const harness = new FakeHarness();
    const factory = vi.fn(async () => created(metadata("img-test"), harness));
    const adapter = new NoviAgentAdapter(env, sessionStore, factory);
    const images = [{ type: "image" as const, data: "base64data", mimeType: "image/png" }];
    await adapter.runTurn({ route: route(), text: "describe this", images });
    expect(harness.prompt).toHaveBeenCalledWith("describe this", { images });
  });

  it("calls harness.prompt without options when images is undefined", async () => {
    const sessionStore = await store();
    const harness = new FakeHarness();
    const factory = vi.fn(async () => created(metadata("no-img"), harness));
    const adapter = new NoviAgentAdapter(env, sessionStore, factory);
    await adapter.runTurn({ route: route(), text: "plain text" });
    expect(harness.prompt).toHaveBeenCalledWith("plain text", undefined);
  });
});
