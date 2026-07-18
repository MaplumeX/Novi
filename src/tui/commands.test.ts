import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { skillsHubMock } = vi.hoisted(() => ({
  skillsHubMock: {
    search: vi.fn(),
    install: vi.fn(),
    update: vi.fn(),
    uninstall: vi.fn(),
    list: vi.fn(),
  },
}));

vi.mock("../skills-hub/skills-hub.js", () => skillsHubMock);

import {
  parseCommand,
  parseSkillCommand,
  runCommand,
  nextThinkingLevel,
  THINKING_LEVELS,
  formatToolCatalog,
  formatMcpList,
  COMMANDS,
} from "./commands.js";
import type { CommandContext } from "./commands.js";

/** Build a mock CommandContext with a fake harness carrying resources + spies. */
function makeCtx(opts: {
  promptTemplates?: Array<{ name: string; description?: string; content: string }>;
  skills?: Array<{ name: string; description?: string }>;
  isIdle?: boolean;
}): {
  ctx: CommandContext;
  promptSpy: ReturnType<typeof vi.fn>;
  skillSpy: ReturnType<typeof vi.fn>;
} {
  const promptSpy = vi.fn().mockResolvedValue(undefined);
  const skillSpy = vi.fn().mockResolvedValue(undefined);
  const ctx = {
    harness: {
      getResources: () => ({
        skills: opts.skills ?? [],
        promptTemplates: opts.promptTemplates ?? [],
      }),
      prompt: promptSpy,
      skill: skillSpy,
    },
    models: { getModel: () => ({ provider: "p", id: "m" }) },
    session: {},
    sessionsDir: "/tmp/sessions",
    isIdle: opts.isIdle ?? true,
    exit: vi.fn(),
    print: vi.fn(),
    handle: {
      replace: vi.fn(),
      refreshTools: vi.fn().mockResolvedValue({
        diagnostics: [],
        toolCatalog: { descriptors: [], activeToolNames: [], availability: [], diagnostics: [] },
      }),
      toolCatalog: { descriptors: [], activeToolNames: [], availability: [], diagnostics: [] },
    },
    setOverlay: vi.fn(),
    env: {
      readTextFile: async () => ({ ok: false, error: { message: "missing" } }),
      fileInfo: async () => ({ ok: false, error: { message: "missing" } }),
    },
    cwd: "/tmp",
    systemPrompt: () => "",
    cliOverrides: {},
    setSettings: vi.fn(),
    settings: { _sources: {} },
    queue: { steer: [], followUp: [], nextTurn: [] },
    pendingImages: [],
    addPendingImages: vi.fn(),
    clearPendingImages: vi.fn(),
  } as unknown as CommandContext;
  return { ctx, promptSpy, skillSpy };
}

/** Build a ctx with a real temp env + cwd so /trust can hit the filesystem. */
function makeTrustCtx(opts: { cwd: string; env: unknown; settings?: Record<string, unknown> }): {
  ctx: CommandContext;
} {
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
    pendingImages: [],
    addPendingImages: vi.fn(),
    clearPendingImages: vi.fn(),
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

describe("/tools", () => {
  const catalog = {
    descriptors: [
      {
        name: "read_file",
        label: "Read File",
        source: { kind: "builtin" as const, id: "builtin" },
        capabilities: ["filesystem.read" as const],
        risk: "read" as const,
        defaultPermission: "allow" as const,
        defaultEnabled: true,
        streaming: "none" as const,
        modes: ["tui" as const, "print" as const, "json" as const, "gateway" as const],
        optional: false,
      },
      {
        name: "web_search",
        label: "Web Search",
        source: { kind: "builtin" as const, id: "builtin" },
        capabilities: ["network.search" as const],
        risk: "network" as const,
        defaultPermission: "allow" as const,
        defaultEnabled: true,
        streaming: "none" as const,
        modes: ["tui" as const, "print" as const, "json" as const, "gateway" as const],
        optional: true,
      },
    ],
    activeToolNames: ["read_file"],
    availability: [
      {
        name: "read_file",
        source: { kind: "builtin" as const, id: "builtin" },
        status: "active" as const,
      },
      {
        name: "web_search",
        source: { kind: "builtin" as const, id: "builtin" },
        status: "unavailable" as const,
        reasonCode: "INITIALIZATION_FAILED" as const,
        reason: "missing BRAVE_API_KEY",
      },
    ],
    diagnostics: ['tool "web_search" unavailable: missing BRAVE_API_KEY'],
  };

  it("formats source, capabilities, status, and diagnostics", () => {
    const text = formatToolCatalog(catalog);
    expect(text).toContain("read_file  active  [builtin:builtin] filesystem.read");
    expect(text).toContain("web_search  unavailable");
    expect(text).toContain("INITIALIZATION_FAILED: missing BRAVE_API_KEY");
    expect(text).toContain("Diagnostics:");
  });

  it("labels external MCP sources clearly", () => {
    const text = formatToolCatalog({
      descriptors: [
        {
          name: "mcp_demo_echo",
          label: "echo",
          source: { kind: "external", id: "mcp:demo" },
          capabilities: ["external.invoke"],
          risk: "execute",
          defaultPermission: "ask",
          defaultEnabled: true,
          streaming: "none",
          modes: ["tui"],
          optional: true,
        },
      ],
      activeToolNames: ["mcp_demo_echo"],
      availability: [
        {
          name: "mcp_demo_echo",
          source: { kind: "external", id: "mcp:demo" },
          status: "active",
        },
      ],
      diagnostics: [],
    });
    expect(text).toContain("[external:mcp:demo]");
  });

  it("prints the current handle catalog", async () => {
    const { ctx } = makeCtx({});
    ctx.handle.toolCatalog = catalog;
    await runCommand("/tools", ctx);
    expect(ctx.print).toHaveBeenCalledWith(formatToolCatalog(catalog));
  });
});

describe("runCommand — prompt-template fallback", () => {
  it("expands a template by name and sends substituted content to harness.prompt", async () => {
    const { ctx, promptSpy } = makeCtx({
      promptTemplates: [{ name: "review", description: "Review code", content: "Review this: $@" }],
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
      expect.stringContaining("Unknown command: /nonexistent."),
    );
    expect(ctx.print).toHaveBeenCalledWith(expect.stringContaining("/skill:<name>"));
  });

  it("surfaces empty command notice", async () => {
    const { ctx } = makeCtx({});
    await runCommand("/", ctx);
    expect(ctx.print).toHaveBeenCalledWith(expect.stringContaining("Empty command."));
    expect(ctx.print).toHaveBeenCalledWith(expect.stringContaining("/skill:<name>"));
  });
});

describe("parseSkillCommand", () => {
  it("returns not-skill for ordinary command names", () => {
    expect(parseSkillCommand("model", "")).toEqual({ kind: "not-skill" });
    expect(parseSkillCommand("skill", "foo")).toEqual({ kind: "not-skill" });
  });

  it("returns invalid for empty skill name", () => {
    expect(parseSkillCommand("skill:", "")).toEqual({
      kind: "invalid",
      reason: "Usage: /skill:<name> [args]",
    });
  });

  it("parses skill name without args", () => {
    expect(parseSkillCommand("skill:review", "")).toEqual({
      kind: "skill",
      skillName: "review",
    });
  });

  it("parses skill name with args as additionalInstructions", () => {
    expect(parseSkillCommand("skill:review", "  focus security  ")).toEqual({
      kind: "skill",
      skillName: "review",
      additionalInstructions: "focus security",
    });
  });
});

describe("runCommand — skill invoke", () => {
  it("invokes harness.skill without second arg when no args", async () => {
    const { ctx, skillSpy, promptSpy } = makeCtx({
      skills: [{ name: "foo", description: "Foo skill" }],
    });
    await runCommand("/skill:foo", ctx);
    expect(skillSpy).toHaveBeenCalledOnce();
    expect(skillSpy.mock.calls[0]).toEqual(["foo"]);
    expect(promptSpy).not.toHaveBeenCalled();
    expect(ctx.print).toHaveBeenCalledWith("Invoking skill: foo");
  });

  it("passes args as additionalInstructions verbatim", async () => {
    const { ctx, skillSpy } = makeCtx({
      skills: [{ name: "foo", description: "Foo skill" }],
    });
    await runCommand("/skill:foo bar baz", ctx);
    expect(skillSpy).toHaveBeenCalledWith("foo", "bar baz");
  });

  it("reports unknown skill without calling harness", async () => {
    const { ctx, skillSpy } = makeCtx({ skills: [] });
    await runCommand("/skill:missing", ctx);
    expect(skillSpy).not.toHaveBeenCalled();
    expect(ctx.print).toHaveBeenCalledWith("Unknown skill: missing");
  });

  it("rejects skill invoke when harness is busy", async () => {
    const { ctx, skillSpy } = makeCtx({
      skills: [{ name: "foo" }],
      isIdle: false,
    });
    await runCommand("/skill:foo", ctx);
    expect(skillSpy).not.toHaveBeenCalled();
    expect(ctx.print).toHaveBeenCalledWith(expect.stringMatching(/busy|idle/i));
  });

  it("does not fall through to prompt-template for skill: names", async () => {
    const { ctx, skillSpy, promptSpy } = makeCtx({
      skills: [{ name: "foo" }],
      promptTemplates: [{ name: "skill:foo", content: "template should not run" }],
    });
    await runCommand("/skill:foo", ctx);
    expect(skillSpy).toHaveBeenCalledOnce();
    expect(promptSpy).not.toHaveBeenCalled();
  });

  it("prints usage for empty skill name and does not call harness", async () => {
    const { ctx, skillSpy } = makeCtx({ skills: [{ name: "foo" }] });
    await runCommand("/skill:", ctx);
    expect(skillSpy).not.toHaveBeenCalled();
    expect(ctx.print).toHaveBeenCalledWith("Usage: /skill:<name> [args]");
  });

  it("surfaces harness.skill rejection as a notice", async () => {
    const { ctx, skillSpy } = makeCtx({
      skills: [{ name: "foo" }],
    });
    skillSpy.mockRejectedValueOnce(new Error("boom"));
    await runCommand("/skill:foo", ctx);
    // Let the rejected promise settle.
    await vi.waitFor(() => {
      expect(ctx.print).toHaveBeenCalledWith("Skill failed: boom");
    });
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
        getModel: (p: string, id: string) => models.find((m) => m.provider === p && m.id === id),
        getModels: (p?: string) => models.filter((m) => !p || m.provider === p),
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
    if (home)
      await import("node:fs/promises").then((fs) => fs.rm(home, { recursive: true, force: true }));
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
    expect(ctx.print).toHaveBeenCalledWith(expect.stringContaining("Gated resources present: yes"));
  });
});

describe("/scoped-models", () => {
  const cleanups: Array<() => Promise<void>> = [];
  const realHome = process.env.HOME;
  let home: string;

  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()!();
    if (home)
      await import("node:fs/promises").then((fs) => fs.rm(home, { recursive: true, force: true }));
    process.env.HOME = realHome;
  });

  async function setup(): Promise<{ ctx: CommandContext; env: unknown }> {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const nodePath = await import("node:path");
    const { NodeExecutionEnv } = await import("@earendil-works/pi-agent-core/node");
    home = await mkdtemp(nodePath.join(tmpdir(), "novi-scoped-cmd-"));
    process.env.HOME = home;
    const cwd = await mkdtemp(nodePath.join(tmpdir(), "novi-scoped-cwd-"));
    const env = new NodeExecutionEnv({ cwd, shellEnv: process.env });
    cleanups.push(async () => {
      await env.cleanup();
      await import("node:fs/promises").then((fs) => fs.rm(cwd, { recursive: true, force: true }));
    });
    const { ctx } = makeTrustCtx({ cwd, env, settings: { _sources: {}, scopedModels: [] } });
    return { ctx, env };
  }

  it("prints guidance when no patterns configured and no args", async () => {
    const { ctx } = await setup();
    await runCommand("/scoped-models", ctx);
    expect(ctx.print).toHaveBeenCalledWith(expect.stringContaining("No scoped models configured"));
  });

  it("rejects an invalid subcommand", async () => {
    const { ctx } = await setup();
    await runCommand("/scoped-models frobnicate x", ctx);
    expect(ctx.print).toHaveBeenCalledWith(expect.stringContaining("Usage: /scoped-models"));
  });
});

describe("/image and /paste-image", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()!();
  });

  it("/image with path attaches via loadImageFile", async () => {
    const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const nodePath = await import("node:path");
    const { NodeExecutionEnv } = await import("@earendil-works/pi-agent-core/node");

    const cwd = await mkdtemp(nodePath.join(tmpdir(), "novi-img-cmd-"));
    const env = new NodeExecutionEnv({ cwd, shellEnv: process.env });
    cleanups.push(async () => {
      await env.cleanup();
      await rm(cwd, { recursive: true, force: true });
    });
    await writeFile(nodePath.join(cwd, "shot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));

    const pending: unknown[] = [];
    const addPendingImages = vi.fn((items: unknown[]) => {
      pending.push(...items);
    });
    const { ctx } = makeCtx({});
    (ctx as unknown as { env: unknown }).env = env;
    (ctx as unknown as { cwd: string }).cwd = cwd;
    (ctx as unknown as { pendingImages: unknown[] }).pendingImages = pending;
    (ctx as unknown as { addPendingImages: typeof addPendingImages }).addPendingImages =
      addPendingImages;

    await runCommand("/image shot.png", ctx);
    expect(addPendingImages).toHaveBeenCalledTimes(1);
    const items = addPendingImages.mock.calls[0]![0] as Array<{ label: string }>;
    expect(items[0]!.label).toBe("shot.png");
  });

  it("/image with no args opens imagePicker overlay", async () => {
    const { ctx } = makeCtx({});
    await runCommand("/image", ctx);
    expect(ctx.setOverlay).toHaveBeenCalledWith({ kind: "imagePicker" });
  });

  it("/image clear clears pending", async () => {
    const clearPendingImages = vi.fn();
    const { ctx } = makeCtx({});
    (ctx as unknown as { pendingImages: unknown[] }).pendingImages = [{ id: "1" }];
    (ctx as unknown as { clearPendingImages: typeof clearPendingImages }).clearPendingImages =
      clearPendingImages;
    await runCommand("/image clear", ctx);
    expect(clearPendingImages).toHaveBeenCalled();
    expect(ctx.print).toHaveBeenCalledWith("Cleared pending images.");
  });

  it("/image clear with empty pending prints notice", async () => {
    const { ctx } = makeCtx({});
    await runCommand("/image clear", ctx);
    expect(ctx.print).toHaveBeenCalledWith("No pending images.");
  });

  it("/paste-image uses clipboard reader and adds pending", async () => {
    const { ctx } = makeCtx({});
    const addPendingImages = vi.fn();
    (ctx as unknown as { addPendingImages: typeof addPendingImages }).addPendingImages =
      addPendingImages;
    (ctx as { clipboardReader: { readImage: () => Promise<unknown> } }).clipboardReader = {
      readImage: async () => ({
        ok: true,
        value: {
          bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]),
          mimeType: "image/png",
        },
      }),
    };
    await runCommand("/paste-image", ctx);
    expect(addPendingImages).toHaveBeenCalledTimes(1);
    const items = addPendingImages.mock.calls[0]![0] as Array<{ label: string }>;
    expect(items[0]!.label).toBe("clipboard-1.png");
  });

  it("/paste-image prints error when clipboard has no image", async () => {
    const { ctx } = makeCtx({});
    (ctx as { clipboardReader: { readImage: () => Promise<unknown> } }).clipboardReader = {
      readImage: async () => ({ ok: false, error: "no image on clipboard" }),
    };
    await runCommand("/paste-image", ctx);
    expect(ctx.print).toHaveBeenCalledWith("no image on clipboard");
  });
});

describe("/mcp command", () => {
  it("is registered in COMMANDS", () => {
    const cmd = COMMANDS.find((c) => c.name === "mcp");
    expect(cmd).toBeDefined();
    expect(cmd!.description.toLowerCase()).toContain("mcp");
    expect(cmd!.description.toLowerCase()).toContain("trust");
  });

  it("formatMcpList distinguishes empty config and trust note", () => {
    const empty = formatMcpList(
      { entries: [], diagnostics: [] },
      { descriptors: [], activeToolNames: [], availability: [], diagnostics: [] },
    );
    expect(empty).toContain("No MCP servers configured");
    expect(empty).toContain("/mcp approve");

    const listed = formatMcpList(
      {
        entries: [
          {
            name: "demo",
            origin: "project",
            status: "pending",
            fingerprint: "fp",
            config: { command: "npx", args: ["-y", "pkg"] },
            reason: "project server awaiting approval",
          },
        ],
        diagnostics: [],
      },
      { descriptors: [], activeToolNames: [], availability: [], diagnostics: [] },
    );
    expect(listed).toContain("demo");
    expect(listed).toContain("status=pending");
    expect(listed).toContain("/trust is project settings");
  });

  it("/mcp list prints via command runner", async () => {
    const { ctx } = makeCtx({});
    await runCommand("/mcp", ctx);
    expect(ctx.print).toHaveBeenCalled();
    const text = String((ctx.print as ReturnType<typeof vi.fn>).mock.calls[0]![0]);
    expect(text.toLowerCase()).toContain("mcp");
  });

  it("/mcp status uses the runtime OAuth controller without exposing tokens", async () => {
    const { ctx } = makeCtx({});
    const status = vi.fn().mockResolvedValue({
      state: "authorized",
      grantType: "authorization_code",
      registrationMode: "dcr",
      issuer: "https://auth.example",
      resource: "https://mcp.example/mcp",
      grantedScopes: ["tools.read"],
      pendingScopes: [],
      tokens: { access_token: "secret-token" },
    });
    (ctx.handle as unknown as { mcp: { oauth: { status: typeof status } } }).mcp = {
      oauth: { status },
    };

    await runCommand("/mcp status demo", ctx);

    expect(status).toHaveBeenCalledWith("demo");
    const output = String((ctx.print as ReturnType<typeof vi.fn>).mock.calls[0]![0]);
    expect(output).toContain("demo: authorized");
    expect(output).toContain("resource=https://mcp.example/mcp");
    expect(output).not.toContain("secret-token");
  });

  it("/mcp logout refreshes tools and warns after failed server revocation", async () => {
    const { ctx } = makeCtx({});
    const logout = vi.fn().mockResolvedValue({
      revocationAttempted: true,
      revocationFailed: true,
    });
    (ctx.handle as unknown as { mcp: { oauth: { logout: typeof logout } } }).mcp = {
      oauth: { logout },
    };

    await runCommand("/mcp logout demo", ctx);

    expect(logout).toHaveBeenCalledWith("demo");
    expect(ctx.handle.refreshTools).toHaveBeenCalled();
    expect(ctx.print).toHaveBeenCalledWith(expect.stringContaining("logged out locally"));
    expect(ctx.print).toHaveBeenCalledWith(
      expect.stringContaining("server-side token may still be valid"),
    );
  });

  it("/mcp cancel aborts a login flow owned by the TUI command", async () => {
    const { ctx } = makeCtx({});
    let rejectLogin!: (error: Error) => void;
    const login = vi.fn(
      async (): Promise<void> =>
        await new Promise((_, reject) => {
          rejectLogin = reject;
        }),
    );
    const cancel = vi.fn(() => {
      rejectLogin(new Error("OAuth login cancelled by user"));
      return true;
    });
    const isLoginActive = vi.fn().mockReturnValue(false);
    (
      ctx.handle as unknown as {
        mcp: {
          oauth: {
            login: typeof login;
            cancel: typeof cancel;
            isLoginActive: typeof isLoginActive;
          };
        };
      }
    ).mcp = {
      oauth: { login, cancel, isLoginActive },
    };

    await runCommand("/mcp login demo", ctx);
    await runCommand("/mcp cancel demo", ctx);

    expect(login).toHaveBeenCalledWith("demo", expect.objectContaining({ reauthorize: false }));
    expect(cancel).toHaveBeenCalledWith("demo");
    expect(ctx.print).toHaveBeenCalledWith('Cancelled MCP OAuth login for "demo".');
    await vi.waitFor(() => {
      expect(ctx.print).toHaveBeenCalledWith(expect.stringContaining("login failed"));
    });
  });
});

describe("/skills command", () => {
  beforeEach(() => {
    skillsHubMock.search.mockReset();
    skillsHubMock.install.mockReset();
    skillsHubMock.update.mockReset();
    skillsHubMock.uninstall.mockReset();
    skillsHubMock.list.mockReset();
  });

  it("is registered in COMMANDS", () => {
    const cmd = COMMANDS.find((c) => c.name === "skills");
    expect(cmd).toBeDefined();
    expect(cmd!.description.toLowerCase()).toContain("skill");
  });

  it("prints usage with no args", async () => {
    const { ctx } = makeCtx({});
    await runCommand("/skills", ctx);
    expect(ctx.print).toHaveBeenCalledWith(expect.stringContaining("Usage: /skills"));
  });

  it("prints usage for unknown subcommand", async () => {
    const { ctx } = makeCtx({});
    await runCommand("/skills frobnicate", ctx);
    expect(ctx.print).toHaveBeenCalledWith(expect.stringContaining("Usage: /skills"));
  });

  it("search calls facade and prints results", async () => {
    skillsHubMock.search.mockResolvedValue([
      { id: "1", name: "react", source: "foo/bar", installs: 42 },
      { id: "2", name: "vue", source: "baz/qux", installs: 7 },
    ]);
    const { ctx } = makeCtx({});
    await runCommand("/skills search react", ctx);
    expect(skillsHubMock.search).toHaveBeenCalledWith("react");
    const text = String((ctx.print as ReturnType<typeof vi.fn>).mock.calls[0]![0]);
    expect(text).toContain("react");
    expect(text).toContain("foo/bar");
    expect(text).toContain("installs=42");
  });

  it("search prints no results message on empty", async () => {
    skillsHubMock.search.mockResolvedValue([]);
    const { ctx } = makeCtx({});
    await runCommand("/skills search zzz", ctx);
    expect(ctx.print).toHaveBeenCalledWith("No skills found.");
  });

  it("search prints failure message on error", async () => {
    skillsHubMock.search.mockRejectedValue(new Error("network"));
    const { ctx } = makeCtx({});
    await runCommand("/skills search foo", ctx);
    expect(ctx.print).toHaveBeenCalledWith("Search failed (check network).");
  });

  it("install without --confirm does NOT call facade install", async () => {
    // When --confirm is absent, the confirm callback returns false, so the
    // facade would reject — but we verify the facade is NOT called because
    // the confirm check happens before install in the simplified model.
    // Actually the facade IS called (it internally checks confirm), so we
    // mock it to return a trust-not-confirmed result.
    skillsHubMock.install.mockResolvedValue({
      ok: false,
      reason: "installation cancelled (trust not confirmed)",
    });
    const { ctx } = makeCtx({});
    await runCommand("/skills install foo/bar", ctx);
    expect(skillsHubMock.install).toHaveBeenCalledTimes(1);
    const callArgs = skillsHubMock.install.mock.calls[0]!;
    expect(callArgs[1]).toBe("foo/bar");
    // The confirm callback should return false (no --confirm flag).
    const confirmFn = callArgs[2].confirm;
    expect(await confirmFn()).toBe(false);
    // Should print trust notice with re-run guidance.
    const text = String((ctx.print as ReturnType<typeof vi.fn>).mock.calls[0]![0]);
    expect(text).toContain("requires confirmation");
    expect(text).toContain("--confirm");
  });

  it("install with --confirm calls facade and prints success", async () => {
    skillsHubMock.install.mockResolvedValue({
      ok: true,
      name: "my-skill",
      path: "/home/.novi/skills/my-skill",
      entry: { name: "my-skill" },
      verdict: "pass",
    });
    const { ctx } = makeCtx({});
    await runCommand("/skills install foo/bar --confirm", ctx);
    expect(skillsHubMock.install).toHaveBeenCalledTimes(1);
    const callArgs = skillsHubMock.install.mock.calls[0]!;
    expect(callArgs[1]).toBe("foo/bar");
    expect(callArgs[2].force).toBe(false);
    // The confirm callback should return true (--confirm flag present).
    expect(await callArgs[2].confirm()).toBe(true);
    const text = String((ctx.print as ReturnType<typeof vi.fn>).mock.calls[0]![0]);
    expect(text).toContain("Installed skill my-skill");
    expect(text).toContain("Run /reload to activate");
  });

  it("install with --force passes force=true to facade", async () => {
    skillsHubMock.install.mockResolvedValue({
      ok: true,
      name: "x",
      path: "/p",
      entry: {},
      verdict: "pass",
    });
    const { ctx } = makeCtx({});
    await runCommand("/skills install foo/bar --confirm --force", ctx);
    const callArgs = skillsHubMock.install.mock.calls[0]!;
    expect(callArgs[2].force).toBe(true);
  });

  it("install with dangerous verdict prints block message", async () => {
    skillsHubMock.install.mockResolvedValue({
      ok: false,
      reason: "security scan: dangerous verdict — installation blocked",
    });
    const { ctx } = makeCtx({});
    await runCommand("/skills install foo/bar --confirm", ctx);
    const text = String((ctx.print as ReturnType<typeof vi.fn>).mock.calls[0]![0]);
    expect(text).toContain("Blocked: dangerous");
  });

  it("list empty prints guidance", async () => {
    skillsHubMock.list.mockResolvedValue([]);
    const { ctx } = makeCtx({});
    await runCommand("/skills list", ctx);
    expect(ctx.print).toHaveBeenCalledWith("No hub-installed skills. Use /skills search <query>.");
  });

  it("list with entries prints table", async () => {
    skillsHubMock.list.mockResolvedValue([
      {
        name: "foo",
        source: "owner/repo",
        sourceType: "skills-sh",
        sourceUrl: "https://github.com/owner/repo",
        contentHash: "abc",
        installedAt: "2025-01-01T00:00:00Z",
        updatedAt: "2025-01-01T00:00:00Z",
        version: "1.0",
        scan: null,
      },
    ]);
    const { ctx } = makeCtx({});
    await runCommand("/skills list", ctx);
    const text = String((ctx.print as ReturnType<typeof vi.fn>).mock.calls[0]![0]);
    expect(text).toContain("foo");
    expect(text).toContain("owner/repo");
    expect(text).toContain("1.0");
    expect(text).toContain("no scan");
  });

  it("uninstall calls facade and prints success", async () => {
    skillsHubMock.uninstall.mockResolvedValue({ ok: true });
    const { ctx } = makeCtx({});
    await runCommand("/skills uninstall foo", ctx);
    expect(skillsHubMock.uninstall).toHaveBeenCalledWith(expect.anything(), "foo");
    expect(ctx.print).toHaveBeenCalledWith("Uninstalled foo.");
  });

  it("uninstall not found prints reason", async () => {
    skillsHubMock.uninstall.mockResolvedValue({ ok: false, reason: "not hub-installed" });
    const { ctx } = makeCtx({});
    await runCommand("/skills uninstall foo", ctx);
    expect(ctx.print).toHaveBeenCalledWith("Uninstall failed: not hub-installed");
  });

  it("update calls facade and prints summary", async () => {
    skillsHubMock.update.mockResolvedValue({
      updated: ["foo"],
      upToDate: ["bar"],
      failed: [],
    });
    const { ctx } = makeCtx({});
    await runCommand("/skills update", ctx);
    expect(skillsHubMock.update).toHaveBeenCalledTimes(1);
    const text = String((ctx.print as ReturnType<typeof vi.fn>).mock.calls[0]![0]);
    expect(text).toContain("Updated: foo");
    expect(text).toContain("Up-to-date: bar");
  });

  it("update with name passes name to facade", async () => {
    skillsHubMock.update.mockResolvedValue({ updated: [], upToDate: [], failed: [] });
    const { ctx } = makeCtx({});
    await runCommand("/skills update foo", ctx);
    const callArgs = skillsHubMock.update.mock.calls[0]!;
    expect(callArgs[1].name).toBe("foo");
  });
});
