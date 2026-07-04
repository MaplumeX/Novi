import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runHookScript } from "../runner.js";
import type { RegisterHooksDeps } from "../types.js";

let tmp: string;
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

async function makeTmp(): Promise<string> {
  tmp = await mkdtemp(path.join(tmpdir(), "novi-runner-"));
  return tmp;
}

/** Write an executable shell script that reads stdin and produces a given output. */
async function makeScript(name: string, body: string): Promise<{ command: string; args?: string[] }> {
  const dir = await makeTmp();
  const scriptPath = path.join(dir, name);
  await writeFile(scriptPath, body, "utf8");
  await chmod(scriptPath, 0o755);
  cleanups.push(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });
  return { command: scriptPath };
}

const deps: RegisterHooksDeps = { env: undefined, cwd: "/test", sessionId: "sess-1" };

const toolCallEvent = {
  type: "tool_call",
  toolCallId: "tc-1",
  toolName: "Bash",
  input: { command: "echo hi" },
};

describe("runHookScript", () => {
  it("returns undefined for empty stdout + exit 0 (no-op)", async () => {
    const handler = await makeScript("noop.sh", "#!/bin/sh\nexit 0\n");
    const result = await runHookScript(handler, toolCallEvent, "tool_call", deps);
    expect(result).toBeUndefined();
  });

  it("parses stdout result and converts snake_case to camelCase for tool_call", async () => {
    const handler = await makeScript(
      "block.sh",
      '#!/bin/sh\ncat > /dev/null\necho \'{"result":{"block":true,"reason":"destructive"}}\'\n',
    );
    const result = await runHookScript(handler, toolCallEvent, "tool_call", deps);
    expect(result).toEqual({ block: true, reason: "destructive" });
  });

  it("parses tool_result result with is_error → isError conversion", async () => {
    const handler = await makeScript(
      "rewrite.sh",
      '#!/bin/sh\ncat > /dev/null\necho \'{"result":{"is_error":true,"content":[{"type":"text","text":"blocked"}]}}\'\n',
    );
    const result = await runHookScript(
      handler,
      { type: "tool_result", toolCallId: "tc-1", toolName: "Bash", input: {}, content: [], details: null, isError: false },
      "tool_result",
      deps,
    );
    expect(result).toEqual({ isError: true, content: [{ type: "text", text: "blocked" }] });
  });

  it("parses before_agent_start result with system_prompt → systemPrompt", async () => {
    const handler = await makeScript(
      "inject.sh",
      '#!/bin/sh\ncat > /dev/null\necho \'{"result":{"system_prompt":"injected"}}\'\n',
    );
    const result = await runHookScript(
      handler,
      { type: "before_agent_start", prompt: "hi", systemPrompt: "old" },
      "before_agent_start",
      deps,
    );
    expect(result).toEqual({ systemPrompt: "injected" });
  });

  it("parses session_before_compact result with cancel", async () => {
    const handler = await makeScript(
      "cancel.sh",
      '#!/bin/sh\ncat > /dev/null\necho \'{"result":{"cancel":true}}\'\n',
    );
    const result = await runHookScript(
      handler,
      { type: "session_before_compact", preparation: {} },
      "session_before_compact",
      deps,
    );
    expect(result).toEqual({ cancel: true });
  });

  it("returns undefined for non-JSON stdout + exit 0", async () => {
    const handler = await makeScript(
      "badjson.sh",
      '#!/bin/sh\ncat > /dev/null\necho "not json"\n',
    );
    const result = await runHookScript(handler, toolCallEvent, "tool_call", deps);
    expect(result).toBeUndefined();
  });

  it("exit 2 + tool_call → auto block with reason from stderr", async () => {
    const handler = await makeScript(
      "block2.sh",
      '#!/bin/sh\ncat > /dev/null\necho "forbidden" >&2\nexit 2\n',
    );
    const result = await runHookScript(handler, toolCallEvent, "tool_call", deps);
    expect(result).toEqual({ block: true, reason: "forbidden" });
  });

  it("exit 2 + non-tool_call event → undefined (no-op)", async () => {
    const handler = await makeScript(
      "block2b.sh",
      '#!/bin/sh\ncat > /dev/null\necho "forbidden" >&2\nexit 2\n',
    );
    const result = await runHookScript(
      handler,
      { type: "session_before_compact", preparation: {} },
      "session_before_compact",
      deps,
    );
    expect(result).toBeUndefined();
  });

  it("exit 2 + tool_call with empty stderr → default reason", async () => {
    const handler = await makeScript(
      "block2c.sh",
      "#!/bin/sh\ncat > /dev/null\nexit 2\n",
    );
    const result = await runHookScript(handler, toolCallEvent, "tool_call", deps);
    expect(result).toEqual({ block: true, reason: `blocked by hook "${handler.command}"` });
  });

  it("non-zero exit (non-2) → undefined (no-op)", async () => {
    const handler = await makeScript(
      "fail.sh",
      "#!/bin/sh\ncat > /dev/null\nexit 1\n",
    );
    const result = await runHookScript(handler, toolCallEvent, "tool_call", deps);
    expect(result).toBeUndefined();
  });

  it("timeout → undefined (no-op)", async () => {
    const handler = await makeScript(
      "slow.sh",
      "#!/bin/sh\ncat > /dev/null\nsleep 5\necho '{}'\n",
    );
    const result = await runHookScript(
      { ...handler, timeoutMs: 200 },
      toolCallEvent,
      "tool_call",
      deps,
    );
    expect(result).toBeUndefined();
  }, 10_000);

  it("result without a .result field → undefined", async () => {
    const handler = await makeScript(
      "noresult.sh",
      '#!/bin/sh\ncat > /dev/null\necho \'{"foo":"bar"}\'\n',
    );
    const result = await runHookScript(handler, toolCallEvent, "tool_call", deps);
    expect(result).toBeUndefined();
  });
});