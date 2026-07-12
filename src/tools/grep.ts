import path from "node:path";
import * as Type from "typebox";
import { minimatch } from "minimatch";
import type { AgentTool } from "@earendil-works/pi-agent-core/node";
import type { ExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { resolveAbsolutePath, shellQuote, truncateLine, truncateWithFooter, GREP_MAX_LINE_LENGTH, walkFiles } from "./shared.js";
import type { TruncationInfo } from "./shared.js";

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
export function createGrepTool(env: ExecutionEnv): AgentTool<typeof Parameters, { matches: GrepMatch[]; engine: "ripgrep" | "fallback"; truncation?: TruncationInfo }> {
  return {
    name: "grep",
    label: "Grep",
    description: "Search file contents for a regex pattern. Prefers ripgrep, falls back to a tree scan.",
    parameters: Parameters,
    execute: async (_toolCallId, params, signal) => {
      const base = await resolveAbsolutePath(env, params.path ?? ".");
      const ignoreCase = params.ignoreCase ?? false;
      const literal = params.literal ?? false;
      const context = params.context ?? 0;
      const rg = await tryRipgrep(env, params.pattern, base, params.glob, ignoreCase, literal, context, signal);
      if (rg) return rg;

      const matches = await grepFallback(env, params.pattern, base, params.glob, ignoreCase, literal, context, signal);
      const { text, truncation } = truncateWithFooter(formatMatches(matches), "head");
      return {
        content: [{ type: "text", text }],
        details: { matches, engine: "fallback" as const, truncation },
      };
    },
  };
}

async function tryRipgrep(
  env: ExecutionEnv,
  pattern: string,
  base: string,
  glob: string | undefined,
  ignoreCase: boolean,
  literal: boolean,
  context: number,
  signal: AbortSignal | undefined,
): Promise<{ content: { type: "text"; text: string }[]; details: { matches: GrepMatch[]; engine: "ripgrep"; truncation: TruncationInfo } } | undefined> {
  // --with-filename forces the path prefix even for single-file searches.
  // --null separates the file path from the rest with a NUL byte, making
  // parsing robust against colons in file paths.
  const parts = ["rg", "--line-number", "--no-heading", "--color", "never", "--with-filename", "--null"];
  if (ignoreCase) parts.push("-i");
  if (literal) parts.push("--fixed-strings");
  if (glob) parts.push("--glob", shellQuote(glob));
  if (context > 0) parts.push("-C", String(context));
  parts.push("-e", shellQuote(pattern), "--", shellQuote(base));
  const res = await env.exec(parts.join(" "), { abortSignal: signal });
  if (!res.ok) {
    // spawn/shell unavailable → ripgrep not present, fall back.
    return undefined;
  }
  const { stdout, exitCode } = res.value;
  if (exitCode === 127) return undefined; // command not found → fallback
  if (exitCode !== 0 && exitCode !== 1) {
    throw new Error(`rg exited with code ${exitCode}\n${res.value.stderr}`);
  }
  const matches = parseRipgrep(stdout);
  const { text, truncation } = truncateWithFooter(formatMatches(matches), "head");
  return {
    content: [{ type: "text", text }],
    details: { matches, engine: "ripgrep", truncation },
  };
}

/**
 * Parse ripgrep `--null` output. Each record is `path\0line{text}` where the
 * separator between line number and text is `:` for matches and `-` for
 * context lines (when `-C` is used). Group separators appear as `--` on their
 * own line (no NUL) and are skipped.
 */
function parseRipgrep(stdout: string): GrepMatch[] {
  const matches: GrepMatch[] = [];
  for (const record of stdout.split("\n")) {
    if (!record) continue;
    const nulIdx = record.indexOf("\0");
    if (nulIdx === -1) continue; // skip "--" group separators and malformed lines
    const file = record.slice(0, nulIdx);
    const rest = record.slice(nulIdx + 1);
    // rest is "line:text" (match) or "line-text" (context).
    const m = rest.match(/^(\d+)([:-])(.*)$/);
    if (!m) continue;
    matches.push({ file, line: Number(m[1]), text: m[3] });
  }
  return matches;
}

/** Escape a string for use as a literal regex pattern. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function grepFallback(
  env: ExecutionEnv,
  pattern: string,
  base: string,
  glob: string | undefined,
  ignoreCase: boolean,
  literal: boolean,
  context: number,
  signal: AbortSignal | undefined,
): Promise<GrepMatch[]> {
  let re: RegExp;
  try {
    const flags = ignoreCase ? "i" : "";
    const patternStr = literal ? escapeRegex(pattern) : pattern;
    re = new RegExp(patternStr, flags);
  } catch (e) {
    throw new Error(`invalid regex pattern "${pattern}": ${e instanceof Error ? e.message : String(e)}`);
  }
  const contextN = context > 0 ? context : 0;
  const files = await walkFiles(env, base, signal);
  const matches: GrepMatch[] = [];
  for (const f of files) {
    // Glob filter on the full relative path (matches ripgrep --glob semantics).
    if (glob) {
      const rel = path.relative(base, f.path);
      if (!minimatch(rel, glob, { dot: true })) continue;
    }
    const res = await env.readTextFile(f.path, signal);
    if (!res.ok) continue;
    const lines = res.value.split("\n");
    // Dedup context lines per file to avoid duplicates from overlapping windows.
    const seen = new Set<number>();
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        for (let j = Math.max(0, i - contextN); j <= Math.min(lines.length - 1, i + contextN); j++) {
          if (!seen.has(j)) {
            seen.add(j);
            matches.push({ file: f.path, line: j + 1, text: lines[j] });
          }
        }
      }
    }
  }
  // Context expansion may produce out-of-order lines; sort by file then line.
  matches.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
  return matches;
}

function formatMatches(matches: GrepMatch[]): string {
  if (matches.length === 0) return "(no matches)";
  return matches.map((m) => {
    const { text: line } = truncateLine(m.text, GREP_MAX_LINE_LENGTH);
    return `${m.file}:${m.line}:${line}`;
  }).join("\n");
}