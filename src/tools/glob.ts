import * as Type from "typebox";
import { minimatch } from "minimatch";
import type { AgentTool } from "@earendil-works/pi-agent-core/node";
import type { ExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { WorkspaceScopeGuard } from "../permissions/scope.js";
import { resolveAbsolutePath, visitFiles } from "./shared.js";
import type { ToolExecutionRuntime } from "./runtime/runtime.js";

const Parameters = Type.Object({
  pattern: Type.String(),
  path: Type.Optional(Type.String()),
});

/**
 * `glob`: match file paths under `path` (default cwd) against a glob `pattern`
 * (minimatch syntax, e.g. double-star slash star-dot-ts). Recursively walks the tree via `env.listDir`.
 */
export function createGlobTool(
  env: ExecutionEnv,
  scopeGuard?: WorkspaceScopeGuard,
  runtime?: ToolExecutionRuntime,
): AgentTool<typeof Parameters> {
  return {
    name: "glob",
    label: "Glob",
    description: "Find files under a directory matching a glob pattern (minimatch syntax).",
    parameters: Parameters,
    execute: async (toolCallId, params, signal) => {
      await scopeGuard?.assertNativeFileAccess(
        toolCallId,
        "filesystem.read",
        params.path ?? ".",
        "subtree",
        signal,
      );
      if (!runtime) throw new Error("glob: tool execution runtime is required");
      const budget = runtime.budget;
      const base = await resolveAbsolutePath(env, params.path ?? ".");
      const matched: string[] = [];
      const capture = runtime.createCapture(toolCallId, "glob", "head");
      try {
        const traversal = await visitFiles(
          env,
          base,
          budget,
          async (file) => {
            if (!minimatch(file.relativePath, params.pattern, { dot: true })) return;
            if (matched.length >= budget.resultCount) return false;
            matched.push(file.relativePath);
            await capture.append(`${file.relativePath}\n`);
          },
          signal,
        );
        if (matched.length === 0) await capture.append("(no matches)");
        const captured = await capture.finalize({ partialUpdates: 0, partialDroppedBytes: 0 });
        return {
          content: [{ type: "text", text: captured.text }],
          details: {
            resourceGoverned: true,
            resourceDirection: "head",
            path: base,
            pattern: params.pattern,
            count: matched.length,
            matches: matched,
            traversal,
            resource: captured.metrics,
          },
        };
      } catch (error) {
        await capture.abort();
        throw error;
      }
    },
  };
}
