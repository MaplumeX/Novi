import type { ExecutionEnv } from "@earendil-works/pi-agent-core/node";

/**
 * Shell bang parsing (`!` / `!!`) for InputBox.
 *
 * - `!command`   → visible:   run the command, send stdout to the model.
 * - `!!command`  → hidden:    run the command, do NOT send output to model.
 * - anything else → none.
 *
 * Multi-line input with a bang on the first line: the command is the first
 * line after the bang prefix; the remaining lines become `rest` (for `!`)
 * and are appended to the prompt after the command output.
 */

export type BangResult =
  | { kind: "none" }
  | { kind: "visible"; command: string; rest: string }
  | { kind: "hidden"; command: string; rest: string };

/** Parse a raw input line into a {@link BangResult}. */
export function parseBang(text: string): BangResult {
  if (text.startsWith("!!")) {
    const after = text.slice(2);
    const newlineIdx = after.indexOf("\n");
    if (newlineIdx === -1) {
      return { kind: "hidden", command: after, rest: "" };
    }
    return {
      kind: "hidden",
      command: after.slice(0, newlineIdx),
      rest: after.slice(newlineIdx + 1),
    };
  }
  if (text.startsWith("!")) {
    const after = text.slice(1);
    const newlineIdx = after.indexOf("\n");
    if (newlineIdx === -1) {
      return { kind: "visible", command: after, rest: "" };
    }
    return {
      kind: "visible",
      command: after.slice(0, newlineIdx),
      rest: after.slice(newlineIdx + 1),
    };
  }
  return { kind: "none" };
}

export interface RunBangDeps {
  env: ExecutionEnv;
  cwd: string;
  /** Send a prompt to the model (used for visible bangs). */
  onPrompt: (text: string) => void;
  /** Surface a notice line to the TUI. */
  print: (text: string) => void;
}

/**
 * Execute a parsed bang.
 *
 * Visible (`!`): run the command, format the output, and send it as a prompt.
 * If `rest` is non-empty, it is appended after the command output.
 *
 * Hidden (`!!`): run the command but only surface a notice — output is not
 * sent to the model.
 *
 * Errors (spawn failure, non-zero exit) are surfaced as notices, not thrown.
 */
export async function runBang(
  parsed: Extract<BangResult, { kind: "visible" | "hidden" }>,
  deps: RunBangDeps,
): Promise<void> {
  const result = await deps.env.exec(parsed.command, { cwd: deps.cwd });
  if (!result.ok) {
    deps.print(`Bang failed: ${result.error.message}`);
    return;
  }
  const { stdout, stderr, exitCode } = result.value;

  if (parsed.kind === "visible") {
    const parts: string[] = [];
    parts.push(`${deps.cwd}> $ ${parsed.command}`);
    if (stdout) parts.push(stdout.replace(/\n$/, ""));
    if (stderr) parts.push(`[stderr]\n${stderr.replace(/\n$/, "")}`);
    parts.push(`[exit ${exitCode}]`);
    const output = parts.join("\n");

    if (parsed.rest.trim()) {
      deps.onPrompt(`${output}\n\n${parsed.rest}`);
    } else {
      deps.onPrompt(output);
    }
  } else {
    deps.print(`!! executed (exit ${exitCode}): output not sent.`);
    if (parsed.rest.trim()) {
      deps.print(`Remaining input after !! was not sent: "${parsed.rest.trim().slice(0, 60)}"`);
    }
  }
}
