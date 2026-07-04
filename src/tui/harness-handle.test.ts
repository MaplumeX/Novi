import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { AgentHarness } from "@earendil-works/pi-agent-core/node";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { Models } from "@earendil-works/pi-ai";
import { replayHarnessState } from "./harness-handle.js";
import type { ResolvedSettings } from "../settings.js";

/** Minimal mock: records setter calls, returns canned getter values. */
function makeMockHarness(overrides: Partial<{
  activeTools: Array<{ name: string }>;
  model: unknown;
  thinkingLevel: string;
  streamOptions: unknown;
  steeringMode: string;
  followUpMode: string;
  resources: unknown;
}> = {}): AgentHarness & { calls: Array<[string, ...unknown[]]> } {
  const calls: Array<[string, ...unknown[]]> = [];
  const mock = {
    setTools: async (tools: unknown, active?: string[]) => {
      calls.push(["setTools", tools, active]);
    },
    setModel: async (m: unknown) => { calls.push(["setModel", m]); },
    setThinkingLevel: async (l: unknown) => { calls.push(["setThinkingLevel", l]); },
    setStreamOptions: async (o: unknown) => { calls.push(["setStreamOptions", o]); },
    setSteeringMode: async (m: unknown) => { calls.push(["setSteeringMode", m]); },
    setFollowUpMode: async (m: unknown) => { calls.push(["setFollowUpMode", m]); },
    setResources: async (r: unknown) => { calls.push(["setResources", r]); },
    getActiveTools: () => overrides.activeTools ?? [{ name: "read_file" }, { name: "bash" }],
    getModel: () => overrides.model ?? { id: "test-model", provider: "test" },
    getThinkingLevel: () => overrides.thinkingLevel ?? "medium",
    getStreamOptions: () => overrides.streamOptions ?? { maxRetries: 3 },
    getSteeringMode: () => overrides.steeringMode ?? "one-at-a-time",
    getFollowUpMode: () => overrides.followUpMode ?? "one-at-a-time",
    getResources: () => overrides.resources ?? { skills: [], promptTemplates: [] },
  };
  return Object.assign(mock as unknown as AgentHarness, { calls });
}

/** Build a real Models instance with builtin providers for model-resolve tests. */
function makeModels(): Models {
  return builtinModels();
}

describe("replayHarnessState", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()!();
  });

  async function setup(): Promise<{ env: NodeExecutionEnv; cwd: string; models: Models }> {
    const cwd = await mkdtemp(path.join(tmpdir(), "novi-replay-"));
    const env = new NodeExecutionEnv({ cwd, shellEnv: process.env });
    const models = makeModels();
    cleanups.push(async () => {
      await env.cleanup();
      await rm(cwd, { recursive: true, force: true });
    });
    return { env, cwd, models };
  }

  it("replays tools, model, thinking, streamOptions, and resources (no reload, no resolvedSettings)", async () => {
    const { env, cwd, models } = await setup();
    const oldHarness = makeMockHarness({
      activeTools: [{ name: "bash" }, { name: "read_file" }],
      model: { id: "claude", provider: "anthropic" },
      thinkingLevel: "high",
      streamOptions: { maxRetries: 5, timeoutMs: 60000 },
      resources: { skills: [{ name: "s1" }], promptTemplates: [] },
    });
    const newHarness = makeMockHarness();

    await replayHarnessState(newHarness, oldHarness, env, cwd, "test-session", models, { reloadResources: false });

    // setTools called with built-in tools + active names from old.
    const setToolsCall = newHarness.calls.find((c) => c[0] === "setTools");
    expect(setToolsCall).toBeDefined();
    expect(setToolsCall![2]).toEqual(["bash", "read_file"]);

    // setModel, setThinkingLevel, setStreamOptions replayed from old.
    expect(newHarness.calls.find((c) => c[0] === "setModel")?.[1]).toEqual({ id: "claude", provider: "anthropic" });
    expect(newHarness.calls.find((c) => c[0] === "setThinkingLevel")?.[1]).toBe("high");
    expect(newHarness.calls.find((c) => c[0] === "setStreamOptions")?.[1]).toEqual({ maxRetries: 5, timeoutMs: 60000 });

    // Queue modes replayed from old (defaults: one-at-a-time).
    expect(newHarness.calls.find((c) => c[0] === "setSteeringMode")?.[1]).toBe("one-at-a-time");
    expect(newHarness.calls.find((c) => c[0] === "setFollowUpMode")?.[1]).toBe("one-at-a-time");

    // setResources with old's resources (since reloadResources=false).
    const setResCall = newHarness.calls.find((c) => c[0] === "setResources");
    expect(setResCall?.[1]).toEqual({ skills: [{ name: "s1" }], promptTemplates: [] });
  });

  it("reloads resources from disk when reloadResources=true and returns diagnostics", async () => {
    const { env, cwd, models } = await setup();
    const oldHarness = makeMockHarness({
      resources: { skills: [{ name: "old" }], promptTemplates: [] },
    });
    const newHarness = makeMockHarness();

    const result = await replayHarnessState(newHarness, oldHarness, env, cwd, "test-session", models, { reloadResources: true });

    // setResources with freshly-loaded resources (empty dirs → empty skills).
    const setResCall = newHarness.calls.find((c) => c[0] === "setResources");
    expect(setResCall).toBeDefined();
    expect(setResCall![1]).toEqual({ skills: [], promptTemplates: [] });

    // Returns a diagnostics array (empty for clean dirs).
    expect(result).toEqual({ diagnostics: [] });
  });

  it("skips project resources on reload when trusted=false (gate)", async () => {
    const { env, cwd, models } = await setup();
    // Plant a project skill so it WOULD be loaded if includeProject were true.
    const { mkdir, writeFile } = await import("node:fs/promises");
    const skillsDir = path.join(cwd, ".novi", "skills", "proj-skill");
    await mkdir(skillsDir, { recursive: true });
    await writeFile(
      path.join(skillsDir, "SKILL.md"),
      "---\nname: proj-skill\ndescription: a project skill\n---\n# Proj Skill\n",
    );
    const oldHarness = makeMockHarness();
    const newHarness = makeMockHarness();

    // trusted=false → project layer skipped → skills should be empty.
    await replayHarnessState(newHarness, oldHarness, env, cwd, "test-session", models, {
      reloadResources: true,
      trusted: false,
    });
    const setResCall = newHarness.calls.find((c) => c[0] === "setResources");
    expect(setResCall).toBeDefined();
    expect((setResCall![1] as { skills: { name: string }[] }).skills).toEqual([]);
  });

  it("replays custom queue modes (steeringMode/followUpMode) from old harness", async () => {
    const { env, cwd, models } = await setup();
    const oldHarness = makeMockHarness({
      steeringMode: "all",
      followUpMode: "all",
    });
    const newHarness = makeMockHarness();

    await replayHarnessState(newHarness, oldHarness, env, cwd, "test-session", models, {});

    expect(newHarness.calls.find((c) => c[0] === "setSteeringMode")?.[1]).toBe("all");
    expect(newHarness.calls.find((c) => c[0] === "setFollowUpMode")?.[1]).toBe("all");
  });

  it("returns resource diagnostics when a skill file is corrupt", async () => {
    const { env, cwd, models } = await setup();
    const { mkdir, writeFile } = await import("node:fs/promises");
    // Plant a corrupt skill (invalid front-matter) so loadResources emits a diagnostic.
    const skillsDir = path.join(cwd, ".novi", "skills", "bad-skill");
    await mkdir(skillsDir, { recursive: true });
    await writeFile(
      path.join(skillsDir, "SKILL.md"),
      "---\nname: bad-skill\ndescription: ok\n---\n# Bad\n",
    );
    // Also plant a truly broken file: invalid YAML front-matter.
    const brokenDir = path.join(cwd, ".novi", "skills", "broken-skill");
    await mkdir(brokenDir, { recursive: true });
    await writeFile(
      path.join(brokenDir, "SKILL.md"),
      "---\nname: broken-skill\ndescription: ::: not yaml :::\n  - bad: [unclosed\n---\n# Broken\n",
    );
    const oldHarness = makeMockHarness();
    const newHarness = makeMockHarness();

    const result = await replayHarnessState(newHarness, oldHarness, env, cwd, "test-session", models, {
      reloadResources: true,
    });

    // Diagnostics should be non-empty (the broken skill produced a warning).
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });

  it("re-resolves model/thinking/streamOptions/queue-modes from resolvedSettings (R4)", async () => {
    const { env, cwd, models } = await setup();
    const oldHarness = makeMockHarness({
      model: { id: "old-model", provider: "test" },
      thinkingLevel: "low",
      streamOptions: { maxRetries: 1 },
      steeringMode: "one-at-a-time",
      followUpMode: "one-at-a-time",
    });
    const newHarness = makeMockHarness();

    const rs: ResolvedSettings = {
      defaultProvider: "anthropic",
      defaultModel: "claude-sonnet-4-5",
      defaultThinkingLevel: "high",
      transport: "sse",
      retry: { provider: { timeoutMs: 30000, maxRetries: 7 } },
      steeringMode: "all",
      followUpMode: "all",
      _sources: {},
    };

    await replayHarnessState(newHarness, oldHarness, env, cwd, "test-session", models, {
      reloadResources: false,
      resolvedSettings: rs,
    });

    // model resolved from settings (real anthropic model).
    const setModelCall = newHarness.calls.find((c) => c[0] === "setModel");
    expect(setModelCall).toBeDefined();
    const setModel = setModelCall![1] as { id: string; provider: string };
    expect(setModel.id).toBe("claude-sonnet-4-5");
    expect(setModel.provider).toBe("anthropic");

    // thinking level from settings.
    expect(newHarness.calls.find((c) => c[0] === "setThinkingLevel")?.[1]).toBe("high");

    // stream options from settings (transport + retry fields).
    const streamCall = newHarness.calls.find((c) => c[0] === "setStreamOptions");
    expect(streamCall).toBeDefined();
    const streamOpts = streamCall![1] as Record<string, unknown>;
    expect(streamOpts.transport).toBe("sse");
    expect(streamOpts.timeoutMs).toBe(30000);
    expect(streamOpts.maxRetries).toBe(7);

    // queue modes from settings.
    expect(newHarness.calls.find((c) => c[0] === "setSteeringMode")?.[1]).toBe("all");
    expect(newHarness.calls.find((c) => c[0] === "setFollowUpMode")?.[1]).toBe("all");
  });

  it("falls back to old harness model + diagnostic when resolvedSettings model not found (R4 degrade)", async () => {
    const { env, cwd, models } = await setup();
    const oldModel = { id: "old-model", provider: "test" };
    const oldHarness = makeMockHarness({
      model: oldModel,
    });
    const newHarness = makeMockHarness();

    const rs: ResolvedSettings = {
      defaultProvider: "anthropic",
      defaultModel: "nonexistent-model-xyz",
      _sources: {},
    };

    const result = await replayHarnessState(newHarness, oldHarness, env, cwd, "test-session", models, {
      reloadResources: false,
      resolvedSettings: rs,
    });

    // model falls back to old harness model.
    const setModelCall = newHarness.calls.find((c) => c[0] === "setModel");
    expect(setModelCall).toBeDefined();
    expect(setModelCall![1]).toBe(oldModel);

    // diagnostic warning about the missing model.
    expect(result.diagnostics.length).toBe(1);
    expect(result.diagnostics[0]).toContain("nonexistent-model-xyz");
    expect(result.diagnostics[0]).toContain("not found");
  });

  it("does not re-resolve from settings when resolvedSettings is omitted (R4 /new /resume path)", async () => {
    const { env, cwd, models } = await setup();
    const oldHarness = makeMockHarness({
      model: { id: "claude", provider: "anthropic" },
      thinkingLevel: "high",
      streamOptions: { maxRetries: 5, timeoutMs: 60000 },
      steeringMode: "all",
      followUpMode: "all",
    });
    const newHarness = makeMockHarness();

    await replayHarnessState(newHarness, oldHarness, env, cwd, "test-session", models, {
      reloadResources: false,
    });

    // Everything replayed from old harness.
    expect(newHarness.calls.find((c) => c[0] === "setModel")?.[1]).toEqual({ id: "claude", provider: "anthropic" });
    expect(newHarness.calls.find((c) => c[0] === "setThinkingLevel")?.[1]).toBe("high");
    expect(newHarness.calls.find((c) => c[0] === "setStreamOptions")?.[1]).toEqual({ maxRetries: 5, timeoutMs: 60000 });
    expect(newHarness.calls.find((c) => c[0] === "setSteeringMode")?.[1]).toBe("all");
    expect(newHarness.calls.find((c) => c[0] === "setFollowUpMode")?.[1]).toBe("all");
  });
});