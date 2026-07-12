import * as Type from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core/node";
import type { ExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { textResult, truncateWithFooter, unwrap } from "./shared.js";

const DEFAULT_TIMEOUT_MS = 120_000; // 2 minutes

const Parameters = Type.Object({
  command: Type.String(),
  timeout: Type.Optional(
    Type.Number({ description: "Timeout in ms. Defaults to 120000 (2 min)." }),
  ),
});

/**
 * Format the accumulated stdout/stderr into a single text body for a partial
 * (streaming) update. stdout first, then an `[stderr]` section if present.
 */
function formatPartial(stdout: string, stderr: string): string {
  let body = stdout;
  if (stderr) body += `\n[stderr]\n${stderr}`;
  return body;
}

/**
 * `bash`: run a shell command. Non-zero exit code throws (with stdout/stderr in
 * the message) so the harness surfaces `isError` to the model. The harness
 * abort signal is forwarded so Ctrl-C kills the child process.
 *
 * When an `onUpdate` callback is provided, stdout/stderr chunks are streamed as
 * partial results (`details: { exitCode: null, streaming: true }`) while the
 * command runs, so consumers (headless JSON mode) can observe progress. The
 * final resolved result carries the complete output with the real exit code.
 *
 * A default 120s timeout is applied when the caller omits `timeout`, so an
 * unbounded command cannot run indefinitely. The model can override by passing
 * a larger (or smaller) `timeout`.
 */
export function createBashTool(env: ExecutionEnv): AgentTool<typeof Parameters> {
  return {
    name: "bash",
    label: "Bash",
    description: "Execute a shell command and return stdout/stderr. Throws on non-zero exit code.",
    parameters: Parameters,
    execute: async (_toolCallId, params, signal, onUpdate) => {
      let stdoutBuf = "";
      let stderrBuf = "";

      const onStdout = (chunk: string) => {
        stdoutBuf += chunk;
        if (onUpdate) {
          onUpdate({
            content: [{ type: "text", text: formatPartial(stdoutBuf, stderrBuf) }],
            details: { exitCode: null, streaming: true },
          });
        }
      };

      const onStderr = (chunk: string) => {
        stderrBuf += chunk;
        if (onUpdate) {
          onUpdate({
            content: [{ type: "text", text: formatPartial(stdoutBuf, stderrBuf) }],
            details: { exitCode: null, streaming: true },
          });
        }
      };

      const timeout = params.timeout ?? DEFAULT_TIMEOUT_MS;
      const res = await env.exec(params.command, {
        timeout,
        abortSignal: signal,
        onStdout,
        onStderr,
      });
      // Spawn/shell failure → throw directly.
      const { stdout, stderr, exitCode } = unwrap(res, `bash failed to spawn`);
      if (exitCode !== 0) {
        throw new Error(`bash exited with code ${exitCode}\nstdout: ${stdout}\nstderr: ${stderr}`);
      }
      const body = `exit ${exitCode}\n${stdout}${stderr ? `\n[stderr]\n${stderr}` : ""}`;
      const { text, truncation } = truncateWithFooter(body, "tail");
      return textResult(text, { exitCode, stdout, stderr, truncation });
    },
  };
}
