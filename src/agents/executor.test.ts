import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  JsonlSessionRepo,
  NodeExecutionEnv,
} from "@earendil-works/pi-agent-core/node";
import type {
  AgentHarness,
  AgentHarnessEvent,
} from "@earendil-works/pi-agent-core/node";
import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CreatedSession,
  GatewayEnv,
  HarnessSessionOptions,
  HarnessSessionTarget,
} from "../bootstrap.js";
import { getSessionsDir } from "../config.js";
import { terminalDeliveryKey } from "../runs/delivery.js";
import { AgentRunExecutor } from "./executor.js";
import type { AgentRun } from "./types.js";

const roots: string[] = [];
const previousNoviHomes: Array<string | undefined> = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  const previous = previousNoviHomes.pop();
  if (previous === undefined) delete process.env.NOVI_HOME;
  else process.env.NOVI_HOME = previous;
});

describe("AgentRunExecutor", () => {
  it("creates an isolated child, applies its policy, and keeps a bounded transcript result", async () => {
    const state = await setup();
    const seenOptions: HarnessSessionOptions[] = [];
    const onSessionCreated = vi.fn();
    const executor = new AgentRunExecutor(state.gatewayEnv, {
      createSession: async (_gatewayEnv, target, options) => {
        seenOptions.push(options);
        return fakeCreatedSession(state.env, target, "你好🙂overflow");
      },
    });

    const result = await executor.execute(state.run, new AbortController().signal, {
      onSessionCreated,
    });

    expect(result.result).toBe("你好");
    expect(result.resultTruncated).toBe(true);
    expect(result.usage).toMatchObject({ inputTokens: 1, outputTokens: 2 });
    expect(result.childSession.parentSessionPath).toBe(state.run.parent.session.path);
    expect(onSessionCreated).toHaveBeenCalledWith(result.childSession);
    expect(seenOptions[0]).toMatchObject({
      thinkingLevel: "low",
      connectMcp: false,
      activeToolAllowlist: ["read_file"],
      registerUserHooks: false,
      workspace: state.run.workspace.cwd,
    });
    expect(seenOptions[0]?.permissionStore).toBeDefined();
  });

  it("fails explicitly instead of falling back from worktree mode", async () => {
    const state = await setup();
    const executor = new AgentRunExecutor(state.gatewayEnv);
    await expect(
      executor.execute(
        { ...state.run, workspace: { ...state.run.workspace, mode: "worktree" } },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "WORKTREE_UNSUPPORTED", retryable: false });
  });
});

async function setup(): Promise<{
  env: NodeExecutionEnv;
  gatewayEnv: GatewayEnv;
  run: AgentRun;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "novi-agent-executor-"));
  roots.push(root);
  previousNoviHomes.push(process.env.NOVI_HOME);
  process.env.NOVI_HOME = path.join(root, "home");
  const env = new NodeExecutionEnv({ cwd: root, shellEnv: process.env });
  const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: getSessionsDir() });
  const parent = await repo.create({ cwd: root, id: "parent_session" });
  const parentMetadata = await parent.getMetadata();
  const model = { provider: "anthropic", id: "model" } as Model<Api>;
  const gatewayEnv = {
    env,
    cwd: root,
    models: {
      getModel: () => model,
      getAuth: async () => ({ auth: { apiKey: "test" } }),
    },
    resources: { skills: [], promptTemplates: [], diagnostics: [] },
    permissions: {
      rules: [],
      externalWriteAllowlist: [],
      autoApproveAsks: false,
      diagnostics: [],
    },
  } as unknown as GatewayEnv;
  const createdAt = "2026-07-17T00:00:00.000Z";
  const run: AgentRun = {
    version: 1,
    id: "run_1",
    task: "inspect",
    parent: { surface: "tui", session: parentMetadata, generation: "generation_1" },
    rootRunId: "run_1",
    depth: 1,
    profile: "explorer",
    contextMode: "isolated",
    workspace: { cwd: root, mode: "shared" },
    model: { provider: "anthropic", id: "model", thinking: "low" },
    policySnapshot: {
      profile: "explorer",
      writable: false,
      activeToolNames: ["read_file"],
      skillNames: [],
      mcpSources: [],
      permissions: [],
      systemPrompt: "Read only.",
      runTimeoutMs: 1_000,
      maxResultBytes: 7,
    },
    status: "running",
    attempt: 1,
    maxAttempts: 2,
    createdAt,
    queuedAt: createdAt,
    notify: true,
    completion: {
      status: "not_required",
      idempotencyKey: terminalDeliveryKey("agent-run", "run_1"),
      attempt: 0,
    },
  };
  return { env, gatewayEnv, run };
}

async function fakeCreatedSession(
  env: NodeExecutionEnv,
  target: HarnessSessionTarget,
  finalText: string,
): Promise<CreatedSession> {
  if (target.kind !== "resume") throw new Error("expected resume target");
  const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: getSessionsDir() });
  const session = await repo.open(target.metadata as Parameters<typeof repo.open>[0]);
  const metadata = await session.getMetadata();
  let listener: ((event: AgentHarnessEvent) => void) | undefined;
  const harness = {
    subscribe: (next: (event: AgentHarnessEvent) => void) => {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
    prompt: async () => {
      listener?.({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: finalText }],
          usage: {
            input: 1,
            output: 2,
            cacheRead: 0,
            cacheWrite: 0,
            cost: { total: 0.1 },
          },
        },
      } as unknown as AgentHarnessEvent);
    },
    abort: async () => undefined,
    waitForIdle: async () => undefined,
  } as unknown as AgentHarness;
  return {
    harness,
    session,
    metadata,
    sessionPath: metadata.path,
    permissionGate: {} as CreatedSession["permissionGate"],
    toolCatalog: { descriptors: [], activeToolNames: [], availability: [], diagnostics: [] },
    permissionStore: {} as CreatedSession["permissionStore"],
    resolveToolDescriptor: () => undefined,
  };
}
