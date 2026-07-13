import * as Type from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core/node";
import type { ExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { WorkspaceScopeGuard } from "../permissions/scope.js";
import { textResult, truncateWithFooter, unwrap } from "./shared.js";

const Parameters = Type.Object({
  path: Type.Optional(Type.String()),
});

/**
 * `ls`: list the direct children of a directory (defaults to the cwd).
 */
export function createLsTool(
  env: ExecutionEnv,
  scopeGuard?: WorkspaceScopeGuard,
): AgentTool<typeof Parameters> {
  return {
    name: "ls",
    label: "List Directory",
    description: "List direct children of a directory (defaults to the current working directory).",
    parameters: Parameters,
    execute: async (toolCallId, params, signal) => {
      const dir = params.path ?? env.cwd;
      await scopeGuard?.assertNativeFileAccess(
        toolCallId,
        "filesystem.read",
        dir,
        "directory",
        signal,
      );
      const res = await env.listDir(dir, signal);
      const entries = unwrap(res, `ls failed for "${dir}"`);
      const rows = entries
        .map((e) => `${e.kind === "directory" ? "d" : e.kind === "symlink" ? "l" : "-"} ${e.name}`)
        .sort();
      const { text, truncation } = truncateWithFooter(
        rows.length ? rows.join("\n") : "(empty)",
        "head",
      );
      return textResult(text, {
        path: dir,
        entries: entries.map((e) => ({ name: e.name, kind: e.kind })),
        truncation,
      });
    },
  };
}
