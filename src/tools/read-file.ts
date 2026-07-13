import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import * as Type from "typebox";
import type { AgentTool, ExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { WorkspaceScopeGuard } from "../permissions/scope.js";
import { resolveAbsolutePath } from "./shared.js";
import type { ToolExecutionRuntime } from "./runtime/runtime.js";

const Parameters = Type.Object({
  path: Type.String(),
  offset: Type.Optional(Type.Number()),
  limit: Type.Optional(Type.Number()),
});

/** Stream a UTF-8 file through the common bounded output/artifact pipeline. */
export function createReadFileTool(
  env: ExecutionEnv,
  scopeGuard: WorkspaceScopeGuard | undefined,
  runtime: ToolExecutionRuntime,
): AgentTool<typeof Parameters> {
  return {
    name: "read_file",
    label: "Read File",
    description: "Read text with optional 1-based offset/limit and bounded continuation output.",
    parameters: Parameters,
    execute: async (toolCallId, params, signal) => {
      await scopeGuard?.assertNativeFileAccess(
        toolCallId,
        "filesystem.read",
        params.path,
        "file",
        signal,
      );
      const abs = await resolveAbsolutePath(env, params.path);
      const start = params.offset && params.offset > 0 ? Math.floor(params.offset) : 1;
      const limit = params.limit && params.limit > 0 ? Math.floor(params.limit) : undefined;
      const capture = runtime.createCapture(toolCallId, "read_file", "head");
      const stream = createReadStream(abs, { encoding: "utf8", signal });
      const lines = createInterface({ input: stream, crlfDelay: Infinity });
      let lineNumber = 0;
      let selected = 0;
      try {
        for await (const line of lines) {
          if (signal?.aborted) throw new Error("read_file aborted");
          lineNumber += 1;
          if (lineNumber < start) continue;
          if (limit !== undefined && selected >= limit) break;
          await capture.append(`${line}\n`);
          selected += 1;
        }
        const captured = await capture.finalize({ partialUpdates: 0, partialDroppedBytes: 0 });
        return {
          content: [{ type: "text", text: captured.text }],
          details: {
            resourceGoverned: true,
            resourceDirection: "head",
            path: params.path,
            offset: params.offset ?? null,
            limit: params.limit ?? null,
            lines: selected,
            resource: captured.metrics,
          },
        };
      } catch (error) {
        await capture.abort();
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`read_file failed for "${params.path}": ${message}`);
      } finally {
        lines.close();
        stream.destroy();
      }
    },
  };
}
