import {
  truncateHead,
  truncateTail,
  truncateLine,
  DEFAULT_MAX_LINES,
  DEFAULT_MAX_BYTES,
  GREP_MAX_LINE_LENGTH,
  type TruncationResult,
} from "@earendil-works/pi-agent-core/node";
import type { AgentToolResult, ExecutionEnv } from "@earendil-works/pi-agent-core/node";

/**
 * Shared helpers for built-in tools. Tools depend only on the `ExecutionEnv`
 * capability (child 1 contract) + node std lib — never on TUI/harness internals.
 */

export { truncateLine, GREP_MAX_LINE_LENGTH, DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES };

/**
 * Metadata describing a truncation result. Included in tool `details` so
 * logs/UI can surface that output was cut.
 */
export interface TruncationInfo {
  truncated: boolean;
  truncatedBy: "lines" | "bytes" | null;
  totalLines: number;
  totalBytes: number;
  outputLines: number;
  outputBytes: number;
}

function infoFromResult(r: TruncationResult): TruncationInfo {
  return {
    truncated: r.truncated,
    truncatedBy: r.truncatedBy,
    totalLines: r.totalLines,
    totalBytes: r.totalBytes,
    outputLines: r.outputLines,
    outputBytes: r.outputBytes,
  };
}

/**
 * Apply head/tail truncation to `content` and, when truncation occurred, append
 * a human-readable footer noting the original size and which limit was hit.
 *
 * `direction="head"` keeps the beginning (read_file/grep/glob/ls);
 * `direction="tail"` keeps the end (bash, where errors/results land last).
 *
 * Returns the (possibly footer-augmented) text plus {@link TruncationInfo} for
 * `details`. When no truncation is needed, returns `content` as-is.
 */
export function truncateWithFooter(
  content: string,
  direction: "head" | "tail",
): { text: string; truncation: TruncationInfo } {
  const result = direction === "head" ? truncateHead(content) : truncateTail(content);
  const truncation = infoFromResult(result);
  if (!result.truncated) {
    return { text: content, truncation };
  }
  const footer = `\n[Output truncated: ${result.truncatedBy} limit hit. Original: ${result.totalLines} lines / ${result.totalBytes} bytes. Showing ${result.outputLines} lines / ${result.outputBytes} bytes.]`;
  return { text: result.content + footer, truncation };
}

/** Wrap a plain text string into a standard {@link AgentToolResult}. */
export function textResult(
  text: string,
  details: Record<string, unknown> = {},
): AgentToolResult<Record<string, unknown>> {
  return { content: [{ type: "text", text }], details };
}

/**
 * Slice text by 1-based line numbers.
 *
 * `offset` is 1-based (line 1 = first line). `limit` is the max number of lines
 * returned. Both default to "from start" / "to end" when omitted or non-positive.
 */
export function sliceLines(text: string, offset?: number, limit?: number): string {
  const lines = text.split("\n");
  const start = offset && offset > 0 ? offset - 1 : 0;
  const end = limit && limit > 0 ? start + limit : lines.length;
  return lines.slice(start, Math.max(start, end)).join("\n");
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

/** Recursively walk a directory tree, returning files (symlinks not followed). */
export async function walkFiles(
  env: ExecutionEnv,
  dir: string,
  signal?: AbortSignal,
): Promise<{ path: string; name: string }[]> {
  const listRes = await env.listDir(dir, signal);
  if (!listRes.ok) {
    throw new Error(`listDir "${dir}": ${listRes.error.message}`);
  }
  const out: { path: string; name: string }[] = [];
  for (const entry of listRes.value) {
    if (entry.kind === "directory") {
      const sub = await walkFiles(env, entry.path, signal);
      out.push(...sub);
    } else if (entry.kind === "file") {
      out.push({ path: entry.path, name: entry.name });
    }
  }
  return out;
}

/** Escape a string for safe inclusion as a single shell-quoted argument. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'"'"'`)}'`;
}
