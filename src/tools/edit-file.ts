import * as Type from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core/node";
import type { ExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { WorkspaceScopeGuard } from "../permissions/scope.js";
import { resolveAbsolutePath, textResult, unwrap } from "./shared.js";
import type { ToolExecutionBudget } from "./runtime/budget.js";
import { DEFAULT_TOOL_EXECUTION_BUDGET } from "./runtime/budget.js";

const Parameters = Type.Object({
  path: Type.String(),
  edits: Type.Array(
    Type.Object({
      oldText: Type.String(),
      newText: Type.String(),
    }),
  ),
});

type EditSpec = { oldText: string; newText: string };

/**
 * Build an error whose message references `edits[i]` only when multiple edits
 * are in play; for single-edit calls, keep the message simple.
 */
function singleOrMultiError(
  msg: string,
  path: string,
  editIndex: number,
  totalEdits: number,
): Error {
  if (totalEdits === 1) {
    return new Error(`edit_file: ${msg} in "${path}".`);
  }
  return new Error(`edit_file: edits[${editIndex}] ${msg} in "${path}".`);
}

/**
 * `edit_file`: exact text replacement supporting multiple edits in one call.
 * Each `oldText` must match exactly once in the file; 0 matches or >1 matches
 * both throw so edits stay unambiguous. All edits match against the original
 * content, overlapping edits are rejected, and the operation is atomic — any
 * validation failure throws without writing the file.
 */
export function createEditFileTool(
  env: ExecutionEnv,
  scopeGuard?: WorkspaceScopeGuard,
  budget: ToolExecutionBudget = { ...DEFAULT_TOOL_EXECUTION_BUDGET },
): AgentTool<typeof Parameters> {
  return {
    name: "edit_file",
    label: "Edit File",
    description:
      "Replace text in a file. Pass `edits: [{oldText, newText}]` for one or more replacements.",
    parameters: Parameters,
    execute: async (toolCallId, params, signal) => {
      await scopeGuard?.assertNativeFileAccess(
        toolCallId,
        "filesystem.write",
        params.path,
        "file",
        signal,
        false,
      );
      try {
        const abs = await resolveAbsolutePath(env, params.path);
        const info = unwrap(await env.fileInfo(abs), `edit_file failed to stat "${params.path}"`);
        if (info.size > budget.memoryBytes) {
          throw new Error(
            `NOVI_ERROR:TOOL_MEMORY_LIMIT:edit_file input is ${info.size} bytes (limit ${budget.memoryBytes})`,
          );
        }
        const readRes = await env.readTextFile(abs, signal);
        const text = unwrap(readRes, `edit_file failed to read "${params.path}"`);

        const edits: EditSpec[] = params.edits;
        if (!Array.isArray(edits) || edits.length === 0) {
          throw new Error(
            `edit_file: edits must contain at least one replacement in "${params.path}".`,
          );
        }

        // Match phase: each edit must occur exactly once in the original content.
        const matches: { index: number; oldText: string; newText: string }[] = [];
        for (let i = 0; i < edits.length; i++) {
          const { oldText, newText } = edits[i];
          if (!oldText) {
            throw singleOrMultiError("oldText must not be empty", params.path, i, edits.length);
          }
          const count = text.split(oldText).length - 1;
          if (count === 0) {
            throw singleOrMultiError("oldText not found", params.path, i, edits.length);
          }
          if (count > 1) {
            throw singleOrMultiError(
              `oldText matches ${count} times, must be unique`,
              params.path,
              i,
              edits.length,
            );
          }
          matches.push({ index: text.indexOf(oldText), oldText, newText });
        }

        // Overlap detection: sort by position, reject intersecting ranges.
        matches.sort((a, b) => a.index - b.index);
        for (let i = 1; i < matches.length; i++) {
          const prev = matches[i - 1];
          const curr = matches[i];
          if (prev.index + prev.oldText.length > curr.index) {
            throw new Error(
              `edit_file: edits overlap in "${params.path}". Merge overlapping edits into one.`,
            );
          }
        }

        // Apply in reverse order (highest index first) so offsets stay stable.
        let result = text;
        for (let i = matches.length - 1; i >= 0; i--) {
          const m = matches[i];
          result = result.slice(0, m.index) + m.newText + result.slice(m.index + m.oldText.length);
        }
        const resultBytes = Buffer.byteLength(result, "utf8");
        if (resultBytes > budget.memoryBytes) {
          throw new Error(
            `NOVI_ERROR:TOOL_MEMORY_LIMIT:edit_file result is ${resultBytes} bytes (limit ${budget.memoryBytes})`,
          );
        }

        await scopeGuard?.assertNativeFileAccess(
          toolCallId,
          "filesystem.write",
          params.path,
          "file",
          signal,
        );
        const writeRes = await env.writeFile(abs, result, signal);
        unwrap(writeRes, `edit_file failed to write "${params.path}"`);
        return textResult(`edited ${params.path}`, { path: params.path, replaced: edits.length });
      } finally {
        scopeGuard?.clearCallApproval(toolCallId);
      }
    },
  };
}
