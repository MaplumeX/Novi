import { useState, useEffect, useCallback } from "react";
import { Text, Box, useInput } from "ink";
import path from "node:path";
import type { ExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { theme } from "./theme.js";

/**
 * Scan `cwd` for project files, filtering out common noise directories,
 * then fuzzy-match against `query`.
 *
 * Returns at most `limit` results sorted by relevance.
 * When `acceptExtensions` is set (e.g. `.png`), only matching files remain.
 */
export async function loadFileCandidates(
  cwd: string,
  query: string,
  env: ExecutionEnv,
  limit = 10,
  acceptExtensions?: readonly string[],
): Promise<string[]> {
  const baseRes = await env.absolutePath(".");
  if (!baseRes.ok) return [];
  const base = cwd || baseRes.value;

  const files = await walkFiles(env, base);
  const filtered = files
    .filter((f) => f !== base)
    .map((f) => {
      const rel = f.startsWith(base) ? f.slice(base.length).replace(/^\//, "") : f;
      return rel || f;
    })
    .filter((rel) => matchesAcceptExtensions(rel, acceptExtensions));
  const matched = fuzzyMatch(filtered, query);

  return matched.slice(0, limit);
}

/** True when no extension filter is set, or the path ends with an accepted ext. */
export function matchesAcceptExtensions(
  filePath: string,
  acceptExtensions?: readonly string[],
): boolean {
  if (!acceptExtensions || acceptExtensions.length === 0) return true;
  const lower = filePath.toLowerCase();
  return acceptExtensions.some((ext) => {
    const normalized = ext.startsWith(".") ? ext.toLowerCase() : `.${ext.toLowerCase()}`;
    return lower.endsWith(normalized);
  });
}

/** Walk the directory tree via `env.listDir`, skipping noise dirs. */
async function walkFiles(env: ExecutionEnv, dir: string): Promise<string[]> {
  const listRes = await env.listDir(dir);
  if (!listRes.ok) return [];
  const out: string[] = [];
  for (const entry of listRes.value) {
    if (entry.kind === "directory") {
      if (IGNORE_DIRS.has(path.basename(entry.path))) continue;
      const sub = await walkFiles(env, entry.path);
      out.push(...sub);
    } else if (entry.kind === "file") {
      out.push(entry.path);
    }
  }
  return out;
}

const IGNORE_DIRS = new Set(["node_modules", ".git", "dist", ".novi", ".pi", ".claude", ".trellis"]);

/**
 * Fuzzy match files against a query using subsequence matching.
 * Each character of `query` must appear in the path in order.
 * Returns paths sorted by relevance (higher score = better).
 */
function fuzzyMatch(files: string[], query: string): string[] {
  if (!query) return files.sort();
  const lower = query.toLowerCase();

  const scored = files
    .map((f) => ({ path: f, score: fuzzyScore(f.toLowerCase(), lower) }))
    .filter((e) => e.score >= 0)
    .sort((a, b) => b.score - a.score);

  return scored.map((e) => e.path);
}

/**
 * Return a relevance score (higher = better) or -1 if no match.
 * Rewards consecutive matches and early matches; penalizes long paths.
 */
function fuzzyScore(filePath: string, query: string): number {
  let pi = 0;
  let qi = 0;
  let score = 0;
  let consecutive = 0;

  while (pi < filePath.length && qi < query.length) {
    if (filePath[pi] === query[qi]) {
      consecutive++;
      score += consecutive * 2;
      qi++;
    } else {
      consecutive = 0;
    }
    pi++;
  }

  if (qi < query.length) return -1;
  score -= Math.floor(filePath.length / 50);
  return score;
}

export interface FilePickerProps {
  cwd: string;
  env: ExecutionEnv;
  /** Initial query to filter files by. */
  initialQuery: string;
  onInsert: (path: string) => void;
  onCancel: () => void;
  /** When set, only list files whose extension is in this list (e.g. image picker). */
  acceptExtensions?: readonly string[];
  /** Overlay title; defaults to `@file`. */
  title?: string;
  /** Footer hint; defaults to insert wording. */
  footer?: string;
}

/** Decoded intent from a FilePicker keypress (pure — unit-testable in isolation). */
export type FilePickerAction =
  | "up"
  | "down"
  | "select"
  | "cancel"
  | "backspace"
  | "append"
  | null;

/**
 * Map a raw Ink `useInput(value, key)` payload to a FilePicker action.
 * `select` is returned for both `return` and `tab` — Tab accepts the
 * highlighted item, matching the "Tab accepts completion" mental model.
 */
export function filePickerKeyAction(
  value: string,
  key: {
    upArrow?: boolean;
    downArrow?: boolean;
    return?: boolean;
    tab?: boolean;
    escape?: boolean;
    backspace?: boolean;
    delete?: boolean;
    ctrl?: boolean;
    meta?: boolean;
  },
): FilePickerAction {
  if (key.upArrow) return "up";
  if (key.downArrow) return "down";
  if (key.return || key.tab) return "select";
  if (key.escape) return "cancel";
  if (key.backspace || key.delete) return "backspace";
  if (!value || key.ctrl || key.meta) return null;
  return "append";
}

/**
 * FilePicker overlay: shows a fuzzy-filtered project file list.
 *
 * The user types to filter (`query`), `↑`/`↓` move the selection,
 * `Enter` inserts `@<path>` into the input and closes,
 * `Esc` cancels (keeps the `@` in the input).
 *
 * With `acceptExtensions`, used as the image picker (`/image` with no path).
 */
export function FilePicker({
  cwd,
  env,
  initialQuery,
  onInsert,
  onCancel,
  acceptExtensions,
  title = "@file",
  footer = "type to filter · ↑↓ select · Enter/Tab insert · Esc cancel",
}: FilePickerProps): React.ReactElement {
  const [query, setQuery] = useState(initialQuery);
  const [candidates, setCandidates] = useState<string[]>([]);
  const [cursor, setCursor] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void loadFileCandidates(cwd, query, env, 10, acceptExtensions).then((result) => {
      if (cancelled) return;
      setCandidates(result);
      setCursor(0);
    });
    return () => {
      cancelled = true;
    };
  }, [query, cwd, env, acceptExtensions]);

  const select = useCallback((): void => {
    const chosen = candidates[cursor];
    if (chosen) {
      onInsert(chosen);
    } else {
      onCancel();
    }
  }, [candidates, cursor, onInsert, onCancel]);

  useInput((value, key) => {
    switch (filePickerKeyAction(value, key)) {
      case "up":
        setCursor((c) => (c - 1 + candidates.length) % Math.max(candidates.length, 1));
        return;
      case "down":
        setCursor((c) => (c + 1) % Math.max(candidates.length, 1));
        return;
      case "select":
        select();
        return;
      case "cancel":
        onCancel();
        return;
      case "backspace":
        setQuery((q) => q.slice(0, -1));
        return;
      case "append":
        setQuery((q) => q + value);
        return;
      case null:
        return;
      default:
        return;
    }
  });

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>
        {title} — filter: <Text color={theme.accent}>{query || "(all)"}</Text>
      </Text>
      {candidates.length === 0 ? (
        <Text color={theme.dim}>No files match &quot;{query}&quot;</Text>
      ) : (
        candidates.map((p, i) => (
          <Text key={p} color={i === cursor ? theme.accent : undefined}>
            {i === cursor ? "› " : "  "}
            {p}
          </Text>
        ))
      )}
      <Text color={theme.dim}>{footer}</Text>
    </Box>
  );
}
