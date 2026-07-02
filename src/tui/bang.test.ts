import { describe, expect, it, vi } from "vitest";
import { parseBang, runBang, type RunBangDeps } from "./bang.js";
import type { ExecutionEnv } from "@earendil-works/pi-agent-core/node";

describe("parseBang", () => {
  it("returns none for regular text", () => {
    expect(parseBang("hello")).toEqual({ kind: "none" });
  });

  it("returns none for slash commands", () => {
    expect(parseBang("/help")).toEqual({ kind: "none" });
  });

  it("parses visible bang (!)", () => {
    expect(parseBang("!ls")).toEqual({
      kind: "visible",
      command: "ls",
      rest: "",
    });
  });

  it("parses hidden bang (!!)", () => {
    expect(parseBang("!!ls")).toEqual({
      kind: "hidden",
      command: "ls",
      rest: "",
    });
  });

  it("parses visible bang with spaces in command", () => {
    expect(parseBang("!echo hello world")).toEqual({
      kind: "visible",
      command: "echo hello world",
      rest: "",
    });
  });

  it("parses visible bang with multi-line rest", () => {
    expect(parseBang("!ls\nexplain this output")).toEqual({
      kind: "visible",
      command: "ls",
      rest: "explain this output",
    });
  });

  it("parses hidden bang with multi-line rest", () => {
    expect(parseBang("!!ls\nsome note")).toEqual({
      kind: "hidden",
      command: "ls",
      rest: "some note",
    });
  });

  it("handles bang with empty command", () => {
    expect(parseBang("!")).toEqual({
      kind: "visible",
      command: "",
      rest: "",
    });
  });

  it("handles double bang with empty command", () => {
    expect(parseBang("!!")).toEqual({
      kind: "hidden",
      command: "",
      rest: "",
    });
  });
});

/** Minimal mock ExecutionEnv for runBang tests. */
function mockEnv(stdout: string, stderr = "", exitCode = 0): ExecutionEnv {
  return {
    exec: vi.fn(async () => ({
      ok: true as const,
      value: { stdout, stderr, exitCode },
    })),
  } as unknown as ExecutionEnv;
}

function mockDeps(env: ExecutionEnv): RunBangDeps {
  return {
    env,
    cwd: "/test",
    onPrompt: vi.fn(),
    print: vi.fn(),
  };
}

describe("runBang", () => {
  it("visible bang sends output to onPrompt", async () => {
    const env = mockEnv("file1\nfile2\n");
    const deps = mockDeps(env);
    await runBang(
      { kind: "visible", command: "ls", rest: "" },
      deps,
    );
    expect(deps.onPrompt).toHaveBeenCalledTimes(1);
    const sent = (deps.onPrompt as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(sent).toContain("/test> $ ls");
    expect(sent).toContain("file1");
    expect(sent).toContain("[exit 0]");
  });

  it("visible bang with rest appends rest after output", async () => {
    const env = mockEnv("done");
    const deps = mockDeps(env);
    await runBang(
      { kind: "visible", command: "echo", rest: "explain this" },
      deps,
    );
    const sent = (deps.onPrompt as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(sent).toContain("explain this");
  });

  it("hidden bang does not call onPrompt", async () => {
    const env = mockEnv("secret output");
    const deps = mockDeps(env);
    await runBang(
      { kind: "hidden", command: "ls", rest: "" },
      deps,
    );
    expect(deps.onPrompt).not.toHaveBeenCalled();
    expect(deps.print).toHaveBeenCalled();
    const msg = (deps.print as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(msg).toContain("exit 0");
  });

  it("surfaces exec failure as notice", async () => {
    const env = {
      exec: vi.fn(async () => ({
        ok: false as const,
        error: new Error("command not found"),
      })),
    } as unknown as ExecutionEnv;
    const deps = mockDeps(env);
    await runBang(
      { kind: "visible", command: "nonexistent", rest: "" },
      deps,
    );
    expect(deps.onPrompt).not.toHaveBeenCalled();
    expect(deps.print).toHaveBeenCalledWith(
      "Bang failed: command not found",
    );
  });
});
