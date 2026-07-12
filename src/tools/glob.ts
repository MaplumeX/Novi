import path from "node:path";
import * as Type from "typebox";
import { minimatch } from "minimatch";
import type { AgentTool } from "@earendil-works/pi-agent-core/node";
import type { ExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { resolveAbsolutePath, textResult, truncateWithFooter, walkFiles } from "./shared.js";

const Parameters = Type.Object({
  pattern: Type.String(),
  path: Type.Optional(Type.String()),
});

/**
 * `glob`: match file paths under `path` (default cwd) against a glob `pattern`
 * (minimatch syntax, e.g. double-star slash star-dot-ts). Recursively walks the tree via `env.listDir`.
 */
export function createGlobTool(env: ExecutionEnv): AgentTool<typeof Parameters> {
  return {
    name: "glob",
    label: "Glob",
    description: "Find files under a directory matching a glob pattern (minimatch syntax).",
    parameters: Parameters,
    execute: async (_toolCallId, params, signal) => {
      const base = await resolveAbsolutePath(env, params.path ?? ".");
      const files = await walkFiles(env, base, signal);
      const matched = files
        .map((f) => path.relative(base, f.path))
        .filter((rel) => minimatch(rel, params.pattern, { dot: true }))
        .sort();
      const { text, truncation } = truncateWithFooter(
        matched.length ? matched.join("\n") : "(no matches)",
        "head",
      );
      return textResult(text, {
        path: base,
        pattern: params.pattern,
        count: matched.length,
        matches: matched,
        truncation,
      });
    },
  };
}
