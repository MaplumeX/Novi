import { describe, expect, it, vi } from "vitest";
import { parseCommand, runCommand, COMMANDS, nextThinkingLevel, THINKING_LEVELS } from "./commands.js";
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
    queue: { steer: [], followUp: [], nextTurn: [] },
  } as unknown as CommandContext;
  return { ctx, promptSpy };
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
    expect(parseCommand("/thinking   high")).toEqual({
      name: "thinking",
      args: "high",
    });
  });

  it("preserves spaces inside multi-word args", () => {
    expect(parseCommand("/goto  some entry id here")).toEqual({
      name: "goto",
      args: "some entry id here",
    });
  });

  it("handles leading whitespace and multiple slashes", () => {
    expect(parseCommand("  //help")).toEqual({ name: "help", args: "" });
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

  it("parses /goto with an id", () => {
    expect(parseCommand("/goto abc123")).toEqual({ name: "goto", args: "abc123" });
  });

  it("parses /tree with no arguments", () => {
    expect(parseCommand("/tree")).toEqual({ name: "tree", args: "" });
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
      promptTemplates: [{ name: "help", content: "should not be used" }],
    });
    await runCommand("/help", ctx);
    expect(promptSpy).not.toHaveBeenCalled();
    // /help prints the command list; verify it did run.
    expect(ctx.print).toHaveBeenCalled();
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
    expect(ctx.print).toHaveBeenCalledWith("Unknown command: /nonexistent. Try /help.");
  });

  it("surfaces empty command notice", async () => {
    const { ctx } = makeCtx({});
    await runCommand("/", ctx);
    expect(ctx.print).toHaveBeenCalledWith("Empty command. Try /help.");
  });
});

describe("runCommand — /templates", () => {
  it("lists name and description of loaded templates", async () => {
    const { ctx } = makeCtx({
      promptTemplates: [
        { name: "review", description: "Review code", content: "x" },
        { name: "test", description: "Run tests", content: "y" },
      ],
    });
    await runCommand("/templates", ctx);
    expect(ctx.print).toHaveBeenCalledWith(
      "Prompt templates:\n  /review — Review code\n  /test — Run tests",
    );
  });

  it("omits description separator when template has no description", async () => {
    const { ctx } = makeCtx({
      promptTemplates: [{ name: "plain", content: "z" }],
    });
    await runCommand("/templates", ctx);
    expect(ctx.print).toHaveBeenCalledWith("Prompt templates:\n  /plain");
  });

  it("reports when no templates are loaded", async () => {
    const { ctx } = makeCtx({ promptTemplates: [] });
    await runCommand("/templates", ctx);
    expect(ctx.print).toHaveBeenCalledWith("No prompt templates loaded.");
  });

  it("/templates is registered in COMMANDS", () => {
    expect(COMMANDS.find((c) => c.name === "templates")).toBeDefined();
  });
});
