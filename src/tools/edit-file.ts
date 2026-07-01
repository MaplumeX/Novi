import * as Type from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core/node";
import type { ExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { resolveAbsolutePath, textResult, unwrap } from "./shared.js";

const Parameters = Type.Object({
  path: Type.String(),
  oldText: Type.String(),
  newText: Type.String(),
});

/**
 * `edit_file`: exact text replacement. `oldText` must match exactly once in the
 * file; 0 matches or >1 matches both throw so edits stay unambiguous.
 */
export function createEditFileTool(env: ExecutionEnv): AgentTool<typeof Parameters> {
  return {
    name: "edit_file",
    label: "Edit File",
    description: "Replace the single unique occurrence of `oldText` with `newText` in a file.",
    parameters: Parameters,
    execute: async (_toolCallId, params, signal) => {
      const abs = await resolveAbsolutePath(env, params.path);
      const readRes = await env.readTextFile(abs, signal);
      const text = unwrap(readRes, `edit_file failed to read "${params.path}"`);

      const count = text.split(params.oldText).length - 1;
      if (count === 0) {
        throw new Error(
          `edit_file: oldText not found in "${params.path}".`,
        );
      }
      if (count > 1) {
        throw new Error(
          `edit_file: oldText matches ${count} times in "${params.path}", must be unique.`,
        );
      }
      const next = text.replace(params.oldText, params.newText);
      const writeRes = await env.writeFile(abs, next, signal);
      unwrap(writeRes, `edit_file failed to write "${params.path}"`);
      return textResult(`edited ${params.path}`, {
        path: params.path,
        replaced: 1,
      });
    },
  };
}
