import * as Type from "typebox";
import { minimatch } from "minimatch";
import type { AgentTool } from "@earendil-works/pi-agent-core/node";
import type { ExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { resolveAbsolutePath, shellQuote, walkFiles } from "./shared.js";

const Parameters = Type.Object({
  pattern: Type.String(),
  path: Type.Optional(Type.String()),
  glob: Type.Optional(Type.String()),
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
export function createGrepTool(env: ExecutionEnv): AgentTool<typeof Parameters, { matches: GrepMatch[]; engine: "ripgrep" | "fallback" }> {
  return {
    name: "grep",
    label: "Grep",
    description: "Search file contents for a regex pattern. Prefers ripgrep, falls back to a tree scan.",
    parameters: Parameters,
    execute: async (_toolCallId, params, signal) => {
      const base = await resolveAbsolutePath(env, params.path ?? ".");
      const rg = await tryRipgrep(env, params.pattern, base, params.glob, signal);
      if (rg) return rg;

      const matches = await grepFallback(env, params.pattern, base, params.glob, signal);
      return {
        content: [{ type: "text", text: formatMatches(matches) }],
        details: { matches, engine: "fallback" as const },
      };
    },
  };
}

async function tryRipgrep(
  env: ExecutionEnv,
  pattern: string,
  base: string,
  glob: string | undefined,
  signal: AbortSignal | undefined,
): Promise<{ content: { type: "text"; text: string }[]; details: { matches: GrepMatch[]; engine: "ripgrep" } } | undefined> {
  const parts = ["rg", "--line-number", "--no-heading", "--color", "never"];
  if (glob) parts.push("--glob", shellQuote(glob));
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
  return {
    content: [{ type: "text", text: formatMatches(matches) }],
    details: { matches, engine: "ripgrep" },
  };
}

function parseRipgrep(stdout: string): GrepMatch[] {
  const matches: GrepMatch[] = [];
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    const c1 = line.indexOf(":");
    const c2 = line.indexOf(":", c1 + 1);
    if (c1 === -1 || c2 === -1) continue;
    matches.push({
      file: line.slice(0, c1),
      line: Number(line.slice(c1 + 1, c2)),
      text: line.slice(c2 + 1),
    });
  }
  return matches;
}

async function grepFallback(
  env: ExecutionEnv,
  pattern: string,
  base: string,
  glob: string | undefined,
  signal: AbortSignal | undefined,
): Promise<GrepMatch[]> {
  let re: RegExp;
  try {
    re = new RegExp(pattern);
  } catch (e) {
    throw new Error(`invalid regex pattern "${pattern}": ${e instanceof Error ? e.message : String(e)}`);
  }
  const files = await walkFiles(env, base, signal);
  const matches: GrepMatch[] = [];
  for (const f of files) {
    // Optional glob filter on the basename (ripgrep --glob matches path).
    if (glob && !minimatch(f.name, glob, { dot: true })) continue;
    const res = await env.readTextFile(f.path, signal);
    if (!res.ok) continue;
    res.value.split("\n").forEach((text, i) => {
      if (re.test(text)) matches.push({ file: f.path, line: i + 1, text });
    });
  }
  return matches;
}

function formatMatches(matches: GrepMatch[]): string {
  if (matches.length === 0) return "(no matches)";
  return matches.map((m) => `${m.file}:${m.line}:${m.text}`).join("\n");
}
