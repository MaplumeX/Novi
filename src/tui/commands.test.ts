import { afterEach, describe, expect, it, vi } from "vitest";
import { parseCommand, runCommand, nextThinkingLevel, THINKING_LEVELS } from "./commands.js";
import type { CommandContext } from "./commands.js";

/** Build a mock CommandContext with a fake harness carrying promptTemplates + prompt spy. */
function makeCtx(opts: {
  promptTemplates?: Array<{ name: string; description?: string; content: string }>;
  isIdle?: boolean;
}): { ctx: CommandContext; promptSpy: ReturnType<typeof vi.fn> } {
  const promptSpy = vi.fn().mockResolvedValue(undefined);
  const ctx = {
    harness: {
      getResources: () => ({
        skills: [],
        promptTemplates: opts.promptTemplates ?? [],
      }),
      prompt: promptSpy,
    },
    models: { getModel: () => ({ provider: "p", id: "m" }) },
    session: {},
    sessionsDir: "/tmp/sessions",
    isIdle: opts.isIdle ?? true,
    exit: vi.fn(),
    print: vi.fn(),
    handle: { replace: vi.fn() },
    setOverlay: vi.fn(),
    env: {},
    cwd: "/tmp",
    systemPrompt: () => "",
    cliOverrides: {},
    setSettings: vi.fn(),
    settings: { _sources: {} },
    queue: { steer: [], followUp: [], nextTurn: [] },
  } as unknown as CommandContext;
  return { ctx, promptSpy };
}

/** Build a ctx with a real temp env + cwd so /trust can hit the filesystem. */
function makeTrustCtx(opts: {
  cwd: string;
  env: unknown;
  settings?: Record<string, unknown>;
}): { ctx: CommandContext } {
  const ctx = {
    harness: {
      getResources: () => ({ skills: [], promptTemplates: [] }),
    },
    models: {},
    session: {},
    sessionsDir: "/tmp/sessions",
    isIdle: true,
    exit: vi.fn(),
    print: vi.fn(),
    handle: { replace: vi.fn() },
    setOverlay: vi.fn(),
    env: opts.env,
    cwd: opts.cwd,
    systemPrompt: () => "",
    cliOverrides: {},
    setSettings: vi.fn(),
    settings: opts.settings ?? { _sources: { defaultProjectTrust: "default" } },
    queue: { steer: [], followUp: [], nextTurn: [] },
  } as unknown as CommandContext;
  return { ctx };
}

describe("parseCommand", () => {
  it("parses a command with an argument", () => {
    expect(parseCommand("/model anthropic/claude-x")).toEqual({
      name: "model",
      args: "anthropic/claude-x",
    });
  });

  it("parses a bare command with no argument", () => {
    expect(parseCommand("/quit")).toEqual({ name: "quit", args: "" });
  });

  it("collapses extra whitespace in args", () => {
    expect(parseCommand("/model   high")).toEqual({
      name: "model",
      args: "high",
    });
  });

  it("preserves spaces inside multi-word args", () => {
    expect(parseCommand("/compact  keep it  short")).toEqual({
      name: "compact",
      args: "keep it  short",
    });
  });

  it("handles leading whitespace and multiple slashes", () => {
    expect(parseCommand("  //quit")).toEqual({ name: "quit", args: "" });
  });

  it("returns empty name for a slash-only input", () => {
    expect(parseCommand("/")).toEqual({ name: "", args: "" });
    expect(parseCommand("   ")).toEqual({ name: "", args: "" });
  });

  it("parses /compact with multi-word instructions", () => {
    expect(parseCommand("/compact keep it short")).toEqual({
      name: "compact",
      args: "keep it short",
    });
  });

  it("parses /compact with no arguments", () => {
    expect(parseCommand("/compact")).toEqual({ name: "compact", args: "" });
  });
});

describe("nextThinkingLevel", () => {
  it("cycles through every level in order", () => {
    const cycle = THINKING_LEVELS.map((_, i) =>
      Array.from({ length: THINKING_LEVELS.length }, (_, n) =>
        nextThinkingLevel(THINKING_LEVELS[(i + n) % THINKING_LEVELS.length]!),
      ),
    );
    // Starting from each level, stepping once should land on the next level.
    for (let i = 0; i < THINKING_LEVELS.length; i++) {
      const start = THINKING_LEVELS[i]!;
      const expected = THINKING_LEVELS[(i + 1) % THINKING_LEVELS.length]!;
      expect(nextThinkingLevel(start)).toBe(expected);
    }
    void cycle;
  });

  it("wraps from xhigh back to off", () => {
    expect(nextThinkingLevel("xhigh")).toBe("off");
  });

  it("goes off → minimal → low → medium → high → xhigh → off", () => {
    let level = nextThinkingLevel("off");
    expect(level).toBe("minimal");
    level = nextThinkingLevel(level);
    expect(level).toBe("low");
    level = nextThinkingLevel(level);
    expect(level).toBe("medium");
    level = nextThinkingLevel(level);
    expect(level).toBe("high");
    level = nextThinkingLevel(level);
    expect(level).toBe("xhigh");
    level = nextThinkingLevel(level);
    expect(level).toBe("off");
  });

  it("falls back to off for an unknown level", () => {
    expect(nextThinkingLevel("bogus" as never)).toBe("off");
  });
});

describe("runCommand — prompt-template fallback", () => {
  it("expands a template by name and sends substituted content to harness.prompt", async () => {
    const { ctx, promptSpy } = makeCtx({
      promptTemplates: [
        { name: "review", description: "Review code", content: "Review this: $@" },
      ],
    });
    await runCommand("/review foo bar", ctx);
    expect(promptSpy).toHaveBeenCalledOnce();
    expect(promptSpy).toHaveBeenCalledWith("Review this: foo bar");
    expect(ctx.print).toHaveBeenCalledWith("Expanding template: review");
  });

  it("substitutes positional args ($1)", async () => {
    const { ctx, promptSpy } = makeCtx({
      promptTemplates: [{ name: "greet", content: "Hello $1" }],
    });
    await runCommand("/greet world", ctx);
    expect(promptSpy).toHaveBeenCalledWith("Hello world");
  });

  it("expands a template with no args", async () => {
    const { ctx, promptSpy } = makeCtx({
      promptTemplates: [{ name: "summarize", content: "Summarize the session." }],
    });
    await runCommand("/summarize", ctx);
    expect(promptSpy).toHaveBeenCalledWith("Summarize the session.");
  });

  it("expands a template with $1 placeholder but no arg → empty substitution", async () => {
    // substituteArgs replaces $1 with empty string when the arg is absent
    // (the library does not support ${1:-default} syntax).
    const { ctx, promptSpy } = makeCtx({
      promptTemplates: [{ name: "greet", content: "Hello $1" }],
    });
    await runCommand("/greet", ctx);
    expect(promptSpy).toHaveBeenCalledWith("Hello ");
  });

  it("parses shell-style quoted args", async () => {
    const { ctx, promptSpy } = makeCtx({
      promptTemplates: [{ name: "echo", content: "Echo: $1 | All: $@" }],
    });
    await runCommand('/echo "multi word" baz', ctx);
    expect(promptSpy).toHaveBeenCalledWith("Echo: multi word | All: multi word baz");
  });

  it("builtin commands take priority over same-name templates", async () => {
    const { ctx, promptSpy } = makeCtx({
      promptTemplates: [{ name: "quit", content: "should not be used" }],
    });
    await runCommand("/quit", ctx);
    expect(promptSpy).not.toHaveBeenCalled();
    // /quit calls ctx.exit(); verify it did run.
    expect(ctx.exit).toHaveBeenCalled();
  });

  it("rejects template expansion when harness is busy", async () => {
    const { ctx, promptSpy } = makeCtx({
      promptTemplates: [{ name: "review", content: "hi" }],
      isIdle: false,
    });
    await runCommand("/review", ctx);
    expect(promptSpy).not.toHaveBeenCalled();
    expect(ctx.print).toHaveBeenCalledWith("Harness is busy; /review requires idle.");
  });

  it("still reports unknown for non-existent command/template", async () => {
    const { ctx, promptSpy } = makeCtx({ promptTemplates: [] });
    await runCommand("/nonexistent", ctx);
    expect(promptSpy).not.toHaveBeenCalled();
    expect(ctx.print).toHaveBeenCalledWith(
      "Unknown command: /nonexistent. Try /quit /model /session /new /resume /name /compact /settings /trust /reload.",
    );
  });

  it("surfaces empty command notice", async () => {
    const { ctx } = makeCtx({});
    await runCommand("/", ctx);
    expect(ctx.print).toHaveBeenCalledWith(
      "Empty command. Try /quit /model /session /new /resume /name /compact /settings /trust /reload.",
    );
  });
});

describe("runCommand — /model", () => {
  function makeModelCtx(opts: {
    current?: { provider: string; id: string };
    models?: Array<{ provider: string; id: string }>;
    providers?: Array<{ id: string }>;
    authed?: Set<string>;
  }): { ctx: CommandContext; setModelSpy: ReturnType<typeof vi.fn> } {
    const current = opts.current ?? { provider: "anthropic", id: "claude-x" };
    const models = opts.models ?? [
      { provider: "anthropic", id: "claude-x" },
      { provider: "anthropic", id: "claude-y" },
    ];
    const providers = opts.providers ?? [{ id: "anthropic" }];
    const authed = opts.authed ?? new Set(["anthropic"]);
    const setModelSpy = vi.fn().mockResolvedValue(undefined);
    const ctx = {
      harness: {
        getModel: () => current,
        setModel: setModelSpy,
        getResources: () => ({ skills: [], promptTemplates: [] }),
      },
      models: {
        getModel: (p: string, id: string) =>
          models.find((m) => m.provider === p && m.id === id),
        getModels: (p?: string) =>
          models.filter((m) => !p || m.provider === p),
        getProviders: () => providers,
        getAuth: async (model: { provider: string }) =>
          authed.has(model.provider) ? { ok: true } : undefined,
      },
      session: {},
      sessionsDir: "/tmp/sessions",
      isIdle: true,
      exit: vi.fn(),
      print: vi.fn(),
      handle: { replace: vi.fn() },
      setOverlay: vi.fn(),
      env: {},
      cwd: "/tmp",
      systemPrompt: () => "",
      cliOverrides: {},
      setSettings: vi.fn(),
      settings: { _sources: {} },
      queue: { steer: [], followUp: [], nextTurn: [] },
    } as unknown as CommandContext;
    return { ctx, setModelSpy };
  }

  it("opens the model picker overlay when no args", async () => {
    const { ctx } = makeModelCtx({});
    await runCommand("/model", ctx);
    expect(ctx.setOverlay).toHaveBeenCalledWith({
      kind: "modelPicker",
      models: [
        { provider: "anthropic", id: "claude-x" },
        { provider: "anthropic", id: "claude-y" },
      ],
      currentIndex: 0,
    });
  });

  it("filters out unconfigured providers from the picker", async () => {
    const { ctx } = makeModelCtx({
      models: [
        { provider: "anthropic", id: "claude-x" },
        { provider: "openai", id: "gpt-5" },
      ],
      providers: [{ id: "anthropic" }, { id: "openai" }],
      authed: new Set(["anthropic"]),
    });
    await runCommand("/model", ctx);
    expect(ctx.setOverlay).toHaveBeenCalledWith({
      kind: "modelPicker",
      models: [{ provider: "anthropic", id: "claude-x" }],
      currentIndex: 0,
    });
  });

  it("switches within current provider when given a bare modelId", async () => {
    const { ctx, setModelSpy } = makeModelCtx({});
    await runCommand("/model claude-y", ctx);
    expect(setModelSpy).toHaveBeenCalledWith({ provider: "anthropic", id: "claude-y" });
    expect(ctx.print).toHaveBeenCalledWith("Switched to anthropic/claude-y.");
  });

  it("switches across providers with provider/modelId", async () => {
    const { ctx, setModelSpy } = makeModelCtx({
      models: [
        { provider: "anthropic", id: "claude-x" },
        { provider: "openai", id: "gpt-5" },
      ],
    });
    await runCommand("/model openai/gpt-5", ctx);
    expect(setModelSpy).toHaveBeenCalledWith({ provider: "openai", id: "gpt-5" });
    expect(ctx.print).toHaveBeenCalledWith("Switched to openai/gpt-5.");
  });

  it("reports not found for an unknown model in current provider", async () => {
    const { ctx, setModelSpy } = makeModelCtx({});
    await runCommand("/model nope", ctx);
    expect(setModelSpy).not.toHaveBeenCalled();
    expect(ctx.print).toHaveBeenCalledWith("Model not found: anthropic/nope");
  });
});

describe("/trust", () => {
  const cleanups: Array<() => Promise<void>> = [];
  const realHome = process.env.HOME;
  let home: string;

  // NOTE: hooking afterEach/import per-test below; define helpers here.

  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()!();
    if (home) await import("node:fs/promises").then((fs) => fs.rm(home, { recursive: true, force: true }));
    process.env.HOME = realHome;
  });

  it("saves always with cwd + parent hint in the message", async () => {
    const { mkdtemp, rm, mkdir, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const nodePath = await import("node:path");
    const { NodeExecutionEnv } = await import("@earendil-works/pi-agent-core/node");
    const { loadTrust } = await import("../trust.js");

    home = await mkdtemp(nodePath.join(tmpdir(), "novi-trust-cmd-"));
    process.env.HOME = home;
    const cwd = await mkdtemp(nodePath.join(tmpdir(), "novi-trust-cwd-"));
    // Create a gated resource so the no-arg status path is meaningful too.
    await mkdir(nodePath.join(cwd, ".novi"), { recursive: true });
    await writeFile(nodePath.join(cwd, ".novi", "settings.json"), "{}");
    const env = new NodeExecutionEnv({ cwd, shellEnv: process.env });
    cleanups.push(async () => {
      await env.cleanup();
      await rm(cwd, { recursive: true, force: true });
    });

    const { ctx } = makeTrustCtx({ cwd, env });
    await runCommand("/trust always", ctx);
    expect(ctx.print).toHaveBeenCalledWith(
      expect.stringContaining("Restart Novi for it to take effect."),
    );
    const db = await loadTrust(env);
    expect(db[nodePath.resolve(cwd)]).toBe("always");
    expect(db[nodePath.dirname(nodePath.resolve(cwd))]).toBe("always");
  });

  it("saves never for cwd only (not parent)", async () => {
    const { mkdtemp, rm, mkdir, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const nodePath = await import("node:path");
    const { NodeExecutionEnv } = await import("@earendil-works/pi-agent-core/node");
    const { loadTrust } = await import("../trust.js");

    home = await mkdtemp(nodePath.join(tmpdir(), "novi-trust-cmd-"));
    process.env.HOME = home;
    const cwd = await mkdtemp(nodePath.join(tmpdir(), "novi-trust-cwd-"));
    await mkdir(nodePath.join(cwd, ".novi"), { recursive: true });
    await writeFile(nodePath.join(cwd, ".novi", "settings.json"), "{}");
    const env = new NodeExecutionEnv({ cwd, shellEnv: process.env });
    cleanups.push(async () => {
      await env.cleanup();
      await rm(cwd, { recursive: true, force: true });
    });

    const { ctx } = makeTrustCtx({ cwd, env });
    await runCommand("/trust never", ctx);
    const db = await loadTrust(env);
    expect(db[nodePath.resolve(cwd)]).toBe("never");
    expect(db[nodePath.dirname(nodePath.resolve(cwd))]).toBeUndefined();
  });

  it("rejects an invalid argument", async () => {
    const { ctx } = makeTrustCtx({ cwd: "/tmp", env: {} });
    await runCommand("/trust maybe", ctx);
    expect(ctx.print).toHaveBeenCalledWith("Usage: /trust [always|never]. Default is always.");
  });

  it("shows the current status with no argument", async () => {
    const { mkdtemp, rm, mkdir, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const nodePath = await import("node:path");
    const { NodeExecutionEnv } = await import("@earendil-works/pi-agent-core/node");

    home = await mkdtemp(nodePath.join(tmpdir(), "novi-trust-cmd-"));
    process.env.HOME = home;
    const cwd = await mkdtemp(nodePath.join(tmpdir(), "novi-trust-cwd-"));
    await mkdir(nodePath.join(cwd, ".novi"), { recursive: true });
    await writeFile(nodePath.join(cwd, ".novi", "settings.json"), "{}");
    const env = new NodeExecutionEnv({ cwd, shellEnv: process.env });
    cleanups.push(async () => {
      await env.cleanup();
      await rm(cwd, { recursive: true, force: true });
    });

    const { ctx } = makeTrustCtx({ cwd, env });
    await runCommand("/trust", ctx);
    expect(ctx.print).toHaveBeenCalledWith(
      expect.stringContaining("Gated resources present: yes"),
    );
  });
});
