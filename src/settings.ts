import os from "node:os";
import path from "node:path";
import type { ExecutionEnv, ThinkingLevel } from "@earendil-works/pi-agent-core/node";
import { getNoviDir } from "./config.js";

/**
 * User-configurable Novi settings.
 *
 * Loaded from `~/.novi/settings.json` (global) and `<cwd>/.novi/settings.json`
 * (project). Nested objects are shallow-merged with project overriding global.
 */
export interface NoviSettings {
  defaultProvider?: string;
  defaultModel?: string;
  defaultThinkingLevel?: ThinkingLevel;
  compaction?: {
    enabled?: boolean;
    reserveTokens?: number;
    keepRecentTokens?: number;
  };
  retry?: {
    provider?: {
      timeoutMs?: number;
      maxRetries?: number;
      maxRetryDelayMs?: number;
    };
  };
  /** Fallback project-trust behavior when no saved decision applies. Global-only. */
  defaultProjectTrust?: "ask" | "always" | "never";
  /** Preferred provider transport for providers that support multiple. */
  transport?: "sse" | "websocket" | "websocket-cached" | "auto";
  /** Steering queue delivery mode. */
  steeringMode?: "one-at-a-time" | "all";
  /** Follow-up queue delivery mode. */
  followUpMode?: "one-at-a-time" | "all";
  /** Glob patterns for scoped model cycling (Ctrl+P). Format: `provider/id`. */
  scopedModels?: string[];
  /** Web search configuration. Absent means auto-detect (DuckDuckGo by default). */
  webSearch?: {
    /** Explicit provider id; must match a registered SearchProvider name. */
    provider?: string;
  };
}

/** Which layer sourced a given setting leaf. */
export type SettingSource = "global" | "project" | "cli" | "default";

/** Settings resolved with per-key source provenance (for `/settings` UI). */
export interface ResolvedSettings extends NoviSettings {
  /** key = "defaultProvider" | "compaction.enabled" | "retry.provider.timeoutMs" | … */
  _sources: Record<string, SettingSource>;
}

/** Split layers (for provenance tracking). */
export interface SettingsLayers {
  global: NoviSettings | null;
  project: NoviSettings | null;
}

export interface SettingsLoadResult {
  /** Merged settings (global+project), or `null` when neither file exists. */
  merged: NoviSettings | null;
  /** Split layers (for source provenance in the `/settings` UI). */
  layers: SettingsLayers;
  /** Non-fatal parse warnings (stderr only, never throws). */
  diagnostics: string[];
}

/** CLI overrides that take precedence over settings files. */
export interface SettingsCliOverrides {
  provider?: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  transport?: "sse" | "websocket" | "websocket-cached" | "auto";
  steeringMode?: "one-at-a-time" | "all";
  followUpMode?: "one-at-a-time" | "all";
  scopedModels?: string[];
}

/**
 * Load settings from `~/.novi/settings.json` (global) and
 * `<cwd>/.novi/settings.json` (project). Parse failures degrade to a warning
 * and contribute an empty layer — startup is never blocked.
 *
 * Returns the merged result plus the split layers so callers can determine
 * per-leaf provenance via {@link resolveSettings}.
 */
export async function loadSettings(
  env: ExecutionEnv,
  cwd: string,
  opts: { includeProject?: boolean } = {},
): Promise<SettingsLoadResult> {
  const globalPath = path.join(getNoviDir(), "settings.json");
  const diagnostics: string[] = [];

  const global = await readSettingsLayer(env, globalPath, "global", diagnostics);

  // Project layer is loaded only when trusted (gate). When `includeProject`
  // is false (untrusted), skip the project file entirely so its values cannot
  // influence provider resolution or the merged settings.
  const project = opts.includeProject === false
    ? null
    : await readSettingsLayer(env, path.join(cwd, ".novi", "settings.json"), "project", diagnostics);

  const layers: SettingsLayers = { global, project };
  if (!global && !project) {
    return { merged: null, layers, diagnostics };
  }
  const merged = mergeSettings(global ?? {}, project ?? {});
  const hasKeys = Object.keys(merged).length > 0;
  return { merged: hasKeys ? merged : null, layers, diagnostics };
}

async function readSettingsLayer(
  env: ExecutionEnv,
  filePath: string,
  label: string,
  diagnostics: string[],
): Promise<NoviSettings | null> {
  const result = await env.readTextFile(filePath);
  if (!result.ok) return null; // missing file is expected
  const text = result.value.trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      diagnostics.push(`settings [${label}] root is not a JSON object: ${filePath}`);
      return null;
    }
    return parsed as NoviSettings;
  } catch (e) {
    diagnostics.push(
      `settings [${label}] failed to parse ${filePath}: ${e instanceof Error ? e.message : String(e)}`,
    );
    return null;
  }
}

/**
 * Shallow-merge two settings layers: nested objects are merged one level deep,
 * project overrides global. Unknown keys are preserved (forward-compat).
 */
export function mergeSettings(global: NoviSettings, project: NoviSettings): NoviSettings {
  const keys = new Set<string>([...Object.keys(global), ...Object.keys(project)]);
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const g = (global as Record<string, unknown>)[key];
    const p = (project as Record<string, unknown>)[key];
    if (
      g !== undefined &&
      p !== undefined &&
      g !== null &&
      p !== null &&
      typeof g === "object" &&
      typeof p === "object" &&
      !Array.isArray(g) &&
      !Array.isArray(p)
    ) {
      out[key] = { ...g, ...p };
    } else {
      out[key] = p !== undefined ? p : g;
    }
  }
  return out as NoviSettings;
}

/**
 * Apply CLI overrides and compute per-leaf source provenance.
 *
 * Precedence: cli > project > global > default.
 */
export function resolveSettings(
  merged: NoviSettings | null,
  layers: SettingsLayers,
  cli: SettingsCliOverrides,
): ResolvedSettings {
  const settings: NoviSettings = { ...(merged ?? {}) };
  const _sources: Record<string, SettingSource> = {};

  // Top-level scalar keys.
  const topKeys: Array<{ name: string; cliKey: keyof SettingsCliOverrides }> = [
    { name: "defaultProvider", cliKey: "provider" },
    { name: "defaultModel", cliKey: "model" },
    { name: "defaultThinkingLevel", cliKey: "thinkingLevel" },
  ];
  for (const { name, cliKey } of topKeys) {
    const cliVal = cli[cliKey];
    if (cliVal !== undefined) {
      (settings as Record<string, unknown>)[name] = cliVal;
      _sources[name] = "cli";
    } else {
      const projectVal = (layers.project as Record<string, unknown> | null)?.[name];
      const globalVal = (layers.global as Record<string, unknown> | null)?.[name];
      const mergedVal = (merged as Record<string, unknown> | null)?.[name];
      if (mergedVal !== undefined) {
        _sources[name] = projectVal !== undefined ? "project" : globalVal !== undefined ? "global" : "default";
      } else {
        _sources[name] = "default";
      }
    }
  }

  // defaultProjectTrust: global-only fallback (not a per-run CLI override;
  // per-run trust goes through --approve/--no-approve). Source tracks the
  // layer that provided it (project writes are allowed but have no effect on
  // the trust decision, which reads global settings only).
  {
    const mergedVal = (merged as Record<string, unknown> | null)?.defaultProjectTrust;
    const projectVal = (layers.project as Record<string, unknown> | null)?.defaultProjectTrust;
    const globalVal = (layers.global as Record<string, unknown> | null)?.defaultProjectTrust;
    if (mergedVal !== undefined) {
      _sources.defaultProjectTrust = projectVal !== undefined ? "project" : globalVal !== undefined ? "global" : "default";
    } else {
      _sources.defaultProjectTrust = "default";
    }
  }

  // transport / steeringMode / followUpMode: top-level scalars with cli override.
  for (const { name, cliKey } of [
    { name: "transport", cliKey: "transport" as const },
    { name: "steeringMode", cliKey: "steeringMode" as const },
    { name: "followUpMode", cliKey: "followUpMode" as const },
  ] as const) {
    const cliVal = cli[cliKey];
    if (cliVal !== undefined) {
      (settings as Record<string, unknown>)[name] = cliVal;
      _sources[name] = "cli";
    } else {
      const projectVal = (layers.project as Record<string, unknown> | null)?.[name];
      const globalVal = (layers.global as Record<string, unknown> | null)?.[name];
      const mergedVal = (merged as Record<string, unknown> | null)?.[name];
      if (mergedVal !== undefined) {
        _sources[name] = projectVal !== undefined ? "project" : globalVal !== undefined ? "global" : "default";
      } else {
        _sources[name] = "default";
      }
    }
  }

  // scopedModels: top-level array, cli override replaces (no merge).
  {
    const cliVal = cli.scopedModels;
    if (cliVal !== undefined) {
      (settings as Record<string, unknown>).scopedModels = cliVal;
      _sources.scopedModels = "cli";
    } else {
      const projectVal = (layers.project as Record<string, unknown> | null)?.scopedModels;
      const globalVal = (layers.global as Record<string, unknown> | null)?.scopedModels;
      const mergedVal = (merged as Record<string, unknown> | null)?.scopedModels;
      if (mergedVal !== undefined) {
        _sources.scopedModels = projectVal !== undefined ? "project" : globalVal !== undefined ? "global" : "default";
      } else {
        _sources.scopedModels = "default";
      }
    }
  }

  // compaction.*
  for (const sub of ["enabled", "reserveTokens", "keepRecentTokens"] as const) {
    const fullKey = `compaction.${sub}`;
    const mergedVal = merged?.compaction?.[sub];
    const projectVal = layers.project?.compaction?.[sub];
    const globalVal = layers.global?.compaction?.[sub];
    if (mergedVal !== undefined) {
      _sources[fullKey] = projectVal !== undefined ? "project" : globalVal !== undefined ? "global" : "default";
    } else {
      _sources[fullKey] = "default";
    }
  }

  // retry.provider.*
  for (const sub of ["timeoutMs", "maxRetries", "maxRetryDelayMs"] as const) {
    const fullKey = `retry.provider.${sub}`;
    const mergedVal = merged?.retry?.provider?.[sub];
    const projectVal = layers.project?.retry?.provider?.[sub];
    const globalVal = layers.global?.retry?.provider?.[sub];
    if (mergedVal !== undefined) {
      _sources[fullKey] = projectVal !== undefined ? "project" : globalVal !== undefined ? "global" : "default";
    } else {
      _sources[fullKey] = "default";
    }
  }

  return { ...settings, _sources };
}

// ---------------------------------------------------------------------------
// writeSettings
// ---------------------------------------------------------------------------

/**
 * Write a partial settings patch to `targetPath`. Reads any existing JSON,
 * shallow-merges the patch (one nesting level per dotted segment), and writes
 * pretty-printed JSON back. Creates parent dirs if missing.
 *
 * `patch` uses dot-path keys (e.g. `"compaction.enabled"`). A `null`/`undefined`
 * value removes the key.
 */
export async function writeSettings(
  env: ExecutionEnv,
  targetPath: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const dir = path.dirname(targetPath);
  const dirResult = await env.createDir(dir, { recursive: true });
  if (!dirResult.ok) {
    throw new Error(`settings: failed to create directory ${dir}: ${dirResult.error.message}`);
  }

  let existing: Record<string, unknown> = {};
  const readResult = await env.readTextFile(targetPath);
  if (readResult.ok && readResult.value.trim()) {
    try {
      const parsed = JSON.parse(readResult.value);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        existing = parsed as Record<string, unknown>;
      }
    } catch {
      // Corrupt file: overwrite with the patched value (best-effort recovery).
    }
  }

  const updated = applyPatch(existing, patch);
  const json = JSON.stringify(updated, null, 2) + "\n";
  const writeResult = await env.writeFile(targetPath, json);
  if (!writeResult.ok) {
    throw new Error(`settings: failed to write ${targetPath}: ${writeResult.error.message}`);
  }
}

/** Apply a dot-path patch to an existing object, creating nested objects as needed. */
export function applyPatch(existing: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...existing };
  for (const [key, value] of Object.entries(patch)) {
    const parts = key.split(".");
    let cursor: Record<string, unknown> = out;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      const next = cursor[part];
      if (next === undefined || next === null || typeof next !== "object" || Array.isArray(next)) {
        cursor[part] = {};
      }
      cursor = cursor[part] as Record<string, unknown>;
    }
    const leaf = parts[parts.length - 1];
    if (value === undefined || value === null) {
      delete cursor[leaf];
    } else {
      cursor[leaf] = value;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// AGENTS.md context file candidate path calculation
// ---------------------------------------------------------------------------

/**
 * Compute candidate AGENTS.md file paths, in load order, deduplicated by
 * absolute path:
 *
 * 1. `~/.novi/AGENTS.md` (global user-level)
 * 2. From cwd upward through every parent directory, each `AGENTS.md` at the
 *    directory root — farthest ancestor emitted first.
 * 3. `<cwd>/AGENTS.md`
 */
export function getAgentsMdCandidates(cwd: string, home: string = os.homedir()): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  const push = (p: string): void => {
    const normalized = path.resolve(p);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  };

  // 1. Global user-level AGENTS.md.
  push(path.join(home, ".novi", "AGENTS.md"));

  // 2. Parent directories from cwd's parent up to the filesystem root.
  //    Emit farthest ancestor first so the most specific (closest to cwd) comes
  //    later. cwd's own AGENTS.md is added in step 3 (dedup handles overlap).
  const ancestors: string[] = [];
  let dir = path.resolve(cwd);
  let parent = path.dirname(dir);
  while (parent !== dir) {
    ancestors.push(parent);
    dir = parent;
    parent = path.dirname(dir);
  }
  for (let i = ancestors.length - 1; i >= 0; i--) {
    push(path.join(ancestors[i], "AGENTS.md"));
  }

  // 3. cwd's own AGENTS.md.
  push(path.join(path.resolve(cwd), "AGENTS.md"));

  return result;
}
