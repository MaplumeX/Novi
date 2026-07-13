import * as Type from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core/node";
import type { ExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { WorkspaceScopeGuard } from "../permissions/scope.js";
import { resolveAbsolutePath, textResult, unwrap } from "./shared.js";

const Parameters = Type.Object({
  path: Type.String(),
  content: Type.String(),
});

/**
 * `write_file`: create or overwrite a file. Parent directories are created
 * automatically by `env.writeFile`.
 */
export function createWriteFileTool(
  env: ExecutionEnv,
  scopeGuard?: WorkspaceScopeGuard,
): AgentTool<typeof Parameters> {
  return {
    name: "write_file",
    label: "Write File",
    description: "Create or overwrite a file with the given text content.",
    parameters: Parameters,
    execute: async (toolCallId, params, signal) => {
      await scopeGuard?.assertNativeFileAccess(
        toolCallId,
        "filesystem.write",
        params.path,
        "file",
        signal,
      );
      const abs = await resolveAbsolutePath(env, params.path);
      const res = await env.writeFile(abs, params.content, signal);
      unwrap(res, `write_file failed for "${params.path}"`);
      const bytes = Buffer.byteLength(params.content, "utf8");
      return textResult(`wrote ${bytes} bytes to ${params.path}`, {
        path: params.path,
        bytes,
      });
    },
  };
}
