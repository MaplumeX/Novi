import { opendir } from "node:fs/promises";
import * as Type from "typebox";
import type { AgentTool, ExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { WorkspaceScopeGuard } from "../permissions/scope.js";
import { resolveAbsolutePath } from "./shared.js";
import type { ToolExecutionRuntime } from "./runtime/runtime.js";

const Parameters = Type.Object({ path: Type.Optional(Type.String()) });

/** Stream a direct directory listing while retaining at most resultCount rows. */
export function createLsTool(
  env: ExecutionEnv,
  scopeGuard?: WorkspaceScopeGuard,
  runtime?: ToolExecutionRuntime,
): AgentTool<typeof Parameters> {
  return {
    name: "ls",
    label: "List Directory",
    description: "List bounded direct children of a directory.",
    parameters: Parameters,
    execute: async (toolCallId, params, signal) => {
      const target = params.path ?? env.cwd;
      await scopeGuard?.assertNativeFileAccess(
        toolCallId,
        "filesystem.read",
        target,
        "directory",
        signal,
      );
      if (!runtime) throw new Error("ls: tool execution runtime is required");
      const budget = runtime.budget;
      const absolute = await resolveAbsolutePath(env, target);
      const entries: Array<{ name: string; kind: "directory" | "file" | "symlink" }> = [];
      let visited = 0;
      let reason: "file_limit" | "result_limit" | undefined;
      const directory = await opendir(absolute);
      try {
        for await (const entry of directory) {
          if (signal?.aborted) throw new Error("ls aborted");
          if (visited >= budget.traversalFiles) {
            reason = "file_limit";
            break;
          }
          visited += 1;
          if (entries.length >= budget.resultCount) {
            reason = "result_limit";
            break;
          }
          entries.push({
            name: entry.name,
            kind: entry.isDirectory() ? "directory" : entry.isSymbolicLink() ? "symlink" : "file",
          });
        }
      } finally {
        await directory.close().catch(() => undefined);
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      const rows = entries.map(
        (entry) =>
          `${entry.kind === "directory" ? "d" : entry.kind === "symlink" ? "l" : "-"} ${entry.name}`,
      );
      const capture = runtime.createCapture(toolCallId, "ls", "head");
      try {
        if (rows.length === 0) await capture.append("(empty)");
        else for (const row of rows) await capture.append(`${row}\n`);
        const captured = await capture.finalize({ partialUpdates: 0, partialDroppedBytes: 0 });
        return {
          content: [{ type: "text", text: captured.text }],
          details: {
            resourceGoverned: true,
            resourceDirection: "head",
            path: absolute,
            entries,
            traversal: { visited, truncated: reason !== undefined, reason },
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
