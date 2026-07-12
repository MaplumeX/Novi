import * as Type from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core/node";
import type { ExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { resolveAbsolutePath, sliceLines, textResult, truncateWithFooter, unwrap } from "./shared.js";

const Parameters = Type.Object({
  path: Type.String(),
  offset: Type.Optional(Type.Number()),
  limit: Type.Optional(Type.Number()),
});

/**
 * `read_file`: read a UTF-8 text file, optionally sliced by 1-based line range.
 * Throws when the file does not exist or is unreadable.
 */
export function createReadFileTool(env: ExecutionEnv): AgentTool<typeof Parameters> {
  return {
    name: "read_file",
    label: "Read File",
    description: "Read the text contents of a file. `offset`/`limit` slice by 1-based line number.",
    parameters: Parameters,
    execute: async (_toolCallId, params, signal) => {
      const abs = await resolveAbsolutePath(env, params.path);
      const res = await env.readTextFile(abs, signal);
      const text = unwrap(res, `read_file failed for "${params.path}"`);
      const sliced = sliceLines(text, params.offset, params.limit);
      const { text: outText, truncation } = truncateWithFooter(sliced, "head");
      return textResult(outText, {
        path: params.path,
        offset: params.offset ?? null,
        limit: params.limit ?? null,
        lines: sliced.split("\n").length,
        truncation,
      });
    },
  };
}
