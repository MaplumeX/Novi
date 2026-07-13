import {
  truncateLine,
  GREP_MAX_LINE_LENGTH,
} from "@earendil-works/pi-agent-core/node";
import type { AgentToolResult, ExecutionEnv } from "@earendil-works/pi-agent-core/node";
import ignore from "ignore";
import path from "node:path";
import type { ToolExecutionBudget } from "./runtime/budget.js";

/**
 * Shared helpers for built-in tools. Tools depend only on the `ExecutionEnv`
 * capability (child 1 contract) + node std lib — never on TUI/harness internals.
 */

export { truncateLine, GREP_MAX_LINE_LENGTH };

/** Wrap a plain text string into a standard {@link AgentToolResult}. */
export function textResult(
  text: string,
  details: Record<string, unknown> = {},
): AgentToolResult<Record<string, unknown>> {
  return { content: [{ type: "text", text }], details };
}

/** Retry helper: unwrap a `Result`, throwing on failure with the env error. */
export function unwrap<T>(
  result: { ok: true; value: T } | { ok: false; error: Error },
  context: string,
): T {
  if (!result.ok) {
    throw new Error(`${context}: ${result.error.message}`);
  }
  return result.value;
}

/** Resolve a (possibly relative) path to absolute against `env.cwd`. */
export async function resolveAbsolutePath(env: ExecutionEnv, p: string): Promise<string> {
  const res = await env.absolutePath(p);
  return unwrap(res, `invalid path "${p}"`);
}

export interface WalkSummary {
  visitedFiles: number;
  visitedDirectories: number;
  maxDepthReached: number;
  truncated: boolean;
  reason?: "file_limit" | "depth_limit" | "result_limit";
}

const DEFAULT_IGNORES = [
  ".git/",
  "node_modules/",
  "dist/",
  "build/",
  ".next/",
  "coverage/",
  "target/",
  "vendor/",
];

/** Deterministic bounded traversal; symlinks are never followed. */
export async function visitFiles(
  env: ExecutionEnv,
  dir: string,
  budget: Pick<ToolExecutionBudget, "traversalFiles" | "traversalDepth">,
  visitor: (file: {
    path: string;
    name: string;
    relativePath: string;
  }) => boolean | void | Promise<boolean | void>,
  signal?: AbortSignal,
): Promise<WalkSummary> {
  const matcher = ignore().add(DEFAULT_IGNORES);
  const gitignore = await env.readTextFile(path.join(dir, ".gitignore"), signal);
  if (gitignore.ok) matcher.add(gitignore.value);
  const summary: WalkSummary = {
    visitedFiles: 0,
    visitedDirectories: 0,
    maxDepthReached: 0,
    truncated: false,
  };
  const stack: Array<{ directory: string; depth: number }> = [{ directory: dir, depth: 0 }];
  while (stack.length > 0) {
    if (signal?.aborted) throw new Error("traversal aborted");
    const current = stack.pop()!;
    summary.visitedDirectories += 1;
    summary.maxDepthReached = Math.max(summary.maxDepthReached, current.depth);
    const listRes = await env.listDir(current.directory, signal);
    if (!listRes.ok) throw new Error(`listDir "${current.directory}": ${listRes.error.message}`);
    const entries = [...listRes.value].sort((a, b) => a.name.localeCompare(b.name));
    const directories: typeof entries = [];
    for (const entry of entries) {
      const relativePath = path.relative(dir, entry.path).split(path.sep).join("/");
      if (entry.kind === "symlink") continue;
      if (entry.kind === "directory") {
        const ignored = matcher.ignores(`${relativePath}/`);
        if (ignored) continue;
        if (current.depth >= budget.traversalDepth) {
          summary.truncated = true;
          summary.reason ??= "depth_limit";
          continue;
        }
        directories.push(entry);
        continue;
      }
      if (entry.kind !== "file" || matcher.ignores(relativePath)) continue;
      if (summary.visitedFiles >= budget.traversalFiles) {
        return { ...summary, truncated: true, reason: "file_limit" };
      }
      summary.visitedFiles += 1;
      const shouldContinue = await visitor({ path: entry.path, name: entry.name, relativePath });
      if (shouldContinue === false) {
        return { ...summary, truncated: true, reason: "result_limit" };
      }
    }
    // Reverse push preserves ascending traversal order with a LIFO stack.
    for (let i = directories.length - 1; i >= 0; i--) {
      stack.push({ directory: directories[i]!.path, depth: current.depth + 1 });
    }
  }
  return summary;
}
