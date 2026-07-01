import * as Type from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core/node";
import type { ExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { textResult, unwrap } from "./shared.js";

const Parameters = Type.Object({
  command: Type.String(),
  timeout: Type.Optional(Type.Number()),
});

/**
 * `bash`: run a shell command. Non-zero exit code throws (with stdout/stderr in
 * the message) so the harness surfaces `isError` to the model. The harness
 * abort signal is forwarded so Ctrl-C kills the child process.
 */
export function createBashTool(env: ExecutionEnv): AgentTool<typeof Parameters> {
  return {
    name: "bash",
    label: "Bash",
    description: "Execute a shell command and return stdout/stderr. Throws on non-zero exit code.",
    parameters: Parameters,
    execute: async (_toolCallId, params, signal) => {
      const res = await env.exec(params.command, {
        timeout: params.timeout,
        abortSignal: signal,
      });
      // Spawn/shell failure → throw directly.
      const { stdout, stderr, exitCode } = unwrap(res, `bash failed to spawn`);
      if (exitCode !== 0) {
        throw new Error(
          `bash exited with code ${exitCode}\nstdout: ${stdout}\nstderr: ${stderr}`,
        );
      }
      const body = `exit ${exitCode}\n${stdout}${stderr ? `\n[stderr]\n${stderr}` : ""}`;
      return textResult(body, { exitCode, stdout, stderr });
    },
  };
}
