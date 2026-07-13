import path from "node:path";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import * as Type from "typebox";
import { minimatch } from "minimatch";
import type { AgentTool } from "@earendil-works/pi-agent-core/node";
import type { ExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { WorkspaceScopeGuard } from "../permissions/scope.js";
import {
  resolveAbsolutePath,
  truncateLine,
  GREP_MAX_LINE_LENGTH,
  visitFiles,
  type WalkSummary,
} from "./shared.js";
import type { ToolExecutionBudget } from "./runtime/budget.js";
import type { ToolExecutionRuntime } from "./runtime/runtime.js";
import type { ToolOutputMetrics } from "./runtime/output.js";

const Parameters = Type.Object({
  pattern: Type.String(),
  path: Type.Optional(Type.String()),
  glob: Type.Optional(Type.String()),
  ignoreCase: Type.Optional(Type.Boolean()),
  literal: Type.Optional(Type.Boolean()),
  context: Type.Optional(Type.Number()),
});

export interface GrepMatch {
  file: string;
  line: number;
  text: string;
}

/**
 * `grep`: search file contents for a regex `pattern`.
 *
 * Prefers ripgrep (`rg`); if `rg` is unavailable (spawn error / exit 127) falls
 * back to a recursive `env.listDir` + `readTextFile` + `RegExp` scan.
 */
export function createGrepTool(
  env: ExecutionEnv,
  scopeGuard?: WorkspaceScopeGuard,
  runtime?: ToolExecutionRuntime,
): AgentTool<
  typeof Parameters,
  {
    matches: GrepMatch[];
    engine: "ripgrep" | "bounded";
    traversal: WalkSummary;
    resource: ToolOutputMetrics;
  }
> {
  return {
    name: "grep",
    label: "Grep",
    description:
      "Search file contents for a regex pattern. Prefers ripgrep, falls back to a tree scan.",
    parameters: Parameters,
    execute: async (toolCallId, params, signal) => {
      await scopeGuard?.assertNativeFileAccess(
        toolCallId,
        "filesystem.read",
        params.path ?? ".",
        "subtree",
        signal,
      );
      if (!runtime) throw new Error("grep: tool execution runtime is required");
      const budget = runtime.budget;
      const base = await resolveAbsolutePath(env, params.path ?? ".");
      const ignoreCase = params.ignoreCase ?? false;
      const literal = params.literal ?? false;
      const context = params.context ?? 0;
      const capture = runtime.createCapture(toolCallId, "grep", "head");
      try {
        const onMatch = async (match: GrepMatch) => await capture.append(`${formatMatch(match)}\n`);
        const canUseRipgrep = await ripgrepAvailable(env.cwd, signal);
        const result = canUseRipgrep
          ? await grepRipgrepBounded(
              env,
              params.pattern,
              base,
              params.glob,
              ignoreCase,
              literal,
              context,
              budget,
              onMatch,
              signal,
            )
          : await grepBounded(
              env,
              params.pattern,
              base,
              params.glob,
              ignoreCase,
              literal,
              context,
              budget,
              onMatch,
              signal,
            );
        const { matches, matchCount, structuredTruncated, traversal } = result;
        if (matchCount === 0) await capture.append("(no matches)");
        const captured = await capture.finalize({ partialUpdates: 0, partialDroppedBytes: 0 });
        return {
          content: [{ type: "text", text: captured.text }],
          details: {
            resourceGoverned: true,
            resourceDirection: "head",
            matches,
            count: matchCount,
            structuredTruncated,
            engine: canUseRipgrep ? ("ripgrep" as const) : ("bounded" as const),
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

interface GrepState {
  matches: GrepMatch[];
  count: number;
  bytes: number;
  structuredTruncated: boolean;
}

interface GrepBoundedResult {
  matches: GrepMatch[];
  matchCount: number;
  structuredTruncated: boolean;
  traversal: WalkSummary;
}

async function ripgrepAvailable(cwd: string, signal?: AbortSignal): Promise<boolean> {
  return await new Promise<boolean>((resolve, reject) => {
    const child = spawn("rg", ["--version"], { cwd, stdio: "ignore", windowsHide: true });
    const onAbort = () => child.kill("SIGKILL");
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    child.once("error", (error: NodeJS.ErrnoException) => {
      signal?.removeEventListener("abort", onAbort);
      if (error.code === "ENOENT") resolve(false);
      else reject(error);
    });
    child.once("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) reject(new Error("grep aborted"));
      else resolve(code === 0);
    });
  });
}

async function grepRipgrepBounded(
  env: ExecutionEnv,
  pattern: string,
  base: string,
  glob: string | undefined,
  ignoreCase: boolean,
  literal: boolean,
  context: number,
  budget: ToolExecutionBudget,
  onMatch: (match: GrepMatch) => Promise<unknown>,
  signal: AbortSignal | undefined,
): Promise<GrepBoundedResult> {
  // Validate regex before traversal so invalid input never starts a child process.
  if (!literal) {
    try {
      new RegExp(pattern, ignoreCase ? "i" : "");
    } catch (error) {
      throw new Error(
        `invalid regex pattern "${pattern}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const state: GrepState = { matches: [], count: 0, bytes: 0, structuredTruncated: false };
  const structuredByteLimit = Math.max(1, Math.floor(budget.memoryBytes / 2));
  let batch: string[] = [];
  let stopped = false;
  const flush = async (): Promise<boolean> => {
    if (batch.length === 0) return true;
    const current = batch;
    batch = [];
    return await runRipgrepBatch(
      current,
      pattern,
      ignoreCase,
      literal,
      context,
      state,
      structuredByteLimit,
      budget.resultCount,
      onMatch,
      signal,
    );
  };
  const traversal = await visitFiles(
    env,
    base,
    budget,
    async (file) => {
      if (glob && !minimatch(file.relativePath, glob, { dot: true })) return;
      batch.push(file.path);
      if (batch.length >= 128 && !(await flush())) {
        stopped = true;
        return false;
      }
    },
    signal,
  );
  if (!stopped) stopped = !(await flush());
  if (stopped && !traversal.truncated) {
    traversal.truncated = true;
    traversal.reason = "result_limit";
  }
  return finishGrepState(state, traversal);
}

async function runRipgrepBatch(
  files: string[],
  pattern: string,
  ignoreCase: boolean,
  literal: boolean,
  context: number,
  state: GrepState,
  structuredByteLimit: number,
  resultLimit: number,
  onMatch: (match: GrepMatch) => Promise<unknown>,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  const args = ["--json", "--max-columns", String(GREP_MAX_LINE_LENGTH)];
  if (ignoreCase) args.push("-i");
  if (literal) args.push("--fixed-strings");
  if (context > 0) args.push("-C", String(context));
  args.push("-e", pattern, "--", ...files);
  const child = spawn("rg", args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const onAbort = () => child.kill("SIGKILL");
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-4096);
  });
  const close = new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 0));
  });
  const reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
  let completed = true;
  try {
    for await (const line of reader) {
      if (signal?.aborted) throw new Error("grep aborted");
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      const match = parseRipgrepJson(event);
      if (!match) continue;
      if (!(await recordMatch(state, match, structuredByteLimit, resultLimit, onMatch))) {
        completed = false;
        child.kill("SIGKILL");
        break;
      }
    }
    const code = await close;
    if (signal?.aborted) throw new Error("grep aborted");
    if (completed && code !== 0 && code !== 1) {
      throw new Error(`rg exited with code ${code}: ${stderr.replace(/[\r\n]+/g, " ")}`);
    }
    return completed;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.close();
  }
}

function parseRipgrepJson(value: unknown): GrepMatch | undefined {
  if (!value || typeof value !== "object") return undefined;
  const event = value as { type?: string; data?: Record<string, unknown> };
  if (event.type !== "match" && event.type !== "context") return undefined;
  const data = event.data;
  const file = (data?.path as { text?: unknown } | undefined)?.text;
  const rawText = (data?.lines as { text?: unknown } | undefined)?.text;
  const line = data?.line_number;
  if (typeof file !== "string" || typeof rawText !== "string" || typeof line !== "number")
    return undefined;
  const text = truncateLine(rawText.replace(/\r?\n$/, ""), GREP_MAX_LINE_LENGTH).text;
  return { file, line, text };
}

async function recordMatch(
  state: GrepState,
  match: GrepMatch,
  structuredByteLimit: number,
  resultLimit: number,
  onMatch: (match: GrepMatch) => Promise<unknown>,
): Promise<boolean> {
  if (state.count >= resultLimit) return false;
  state.count += 1;
  await onMatch(match);
  const bytes = Buffer.byteLength(JSON.stringify(match), "utf8");
  if (state.bytes + bytes <= structuredByteLimit) {
    state.matches.push(match);
    state.bytes += bytes;
  } else {
    state.structuredTruncated = true;
  }
  return true;
}

function finishGrepState(state: GrepState, traversal: WalkSummary): GrepBoundedResult {
  state.matches.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
  return {
    matches: state.matches,
    matchCount: state.count,
    structuredTruncated: state.structuredTruncated,
    traversal,
  };
}

/** Escape a string for use as a literal regex pattern. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function grepBounded(
  env: ExecutionEnv,
  pattern: string,
  base: string,
  glob: string | undefined,
  ignoreCase: boolean,
  literal: boolean,
  context: number,
  budget: ToolExecutionBudget,
  onMatch: (match: GrepMatch) => Promise<unknown>,
  signal: AbortSignal | undefined,
): Promise<{
  matches: GrepMatch[];
  matchCount: number;
  structuredTruncated: boolean;
  traversal: WalkSummary;
}> {
  let re: RegExp;
  try {
    const flags = ignoreCase ? "i" : "";
    const patternStr = literal ? escapeRegex(pattern) : pattern;
    re = new RegExp(patternStr, flags);
  } catch (e) {
    throw new Error(
      `invalid regex pattern "${pattern}": ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const contextN = context > 0 ? context : 0;
  const state = { matches: [] as GrepMatch[], count: 0, bytes: 0, structuredTruncated: false };
  const traversal = await visitFiles(
    env,
    base,
    budget,
    async (f) => {
      // Glob filter on the full relative path (matches ripgrep --glob semantics).
      if (glob) {
        const rel = path.relative(base, f.path);
        if (!minimatch(rel, glob, { dot: true })) return;
      }
      return await scanFileBounded(
        f.path,
        re,
        contextN,
        state,
        Math.max(1, Math.floor(budget.memoryBytes / 2)),
        budget.resultCount,
        onMatch,
        signal,
      );
    },
    signal,
  );
  // Context expansion may produce out-of-order lines; sort by file then line.
  state.matches.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
  return {
    matches: state.matches,
    matchCount: state.count,
    structuredTruncated: state.structuredTruncated,
    traversal,
  };
}

async function scanFileBounded(
  file: string,
  pattern: RegExp,
  context: number,
  state: { matches: GrepMatch[]; count: number; bytes: number; structuredTruncated: boolean },
  structuredByteLimit: number,
  resultLimit: number,
  onMatch: (match: GrepMatch) => Promise<unknown>,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  const stream = createReadStream(file, { encoding: "utf8", signal });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  const previous: Array<{ line: number; text: string }> = [];
  let lineNumber = 0;
  let afterRemaining = 0;
  let lastEmitted = 0;
  const emit = async (entry: { line: number; text: string }): Promise<boolean> => {
    if (entry.line <= lastEmitted) return true;
    if (state.count >= resultLimit) return false;
    const match = { file, line: entry.line, text: entry.text };
    state.count += 1;
    await onMatch(match);
    const bytes = Buffer.byteLength(JSON.stringify(match), "utf8");
    if (state.bytes + bytes <= structuredByteLimit) {
      state.matches.push(match);
      state.bytes += bytes;
    } else {
      state.structuredTruncated = true;
    }
    lastEmitted = entry.line;
    return true;
  };
  try {
    for await (const rawLine of reader) {
      if (signal?.aborted) throw new Error("grep aborted");
      lineNumber += 1;
      const text = truncateLine(rawLine, GREP_MAX_LINE_LENGTH).text;
      const current = { line: lineNumber, text };
      if (pattern.test(rawLine)) {
        for (const entry of previous) if (!(await emit(entry))) return false;
        if (!(await emit(current))) return false;
        afterRemaining = context;
      } else if (afterRemaining > 0) {
        if (!(await emit(current))) return false;
        afterRemaining -= 1;
      }
      previous.push(current);
      if (previous.length > context) previous.shift();
    }
    return true;
  } catch (error) {
    if (signal?.aborted) throw error;
    return true; // unreadable/binary file: preserve grep's skip behavior
  } finally {
    reader.close();
    stream.destroy();
  }
}

function formatMatch(match: GrepMatch): string {
  const { text: line } = truncateLine(match.text, GREP_MAX_LINE_LENGTH);
  return `${match.file}:${match.line}:${line}`;
}
