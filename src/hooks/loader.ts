import path from "node:path";
import type { ExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { getNoviDir } from "../config.js";
import {
  SUPPORTED_EVENTS,
  type HookConfig,
  type HookHandlerConfig,
  type HookManifest,
  type HookMatcherGroup,
} from "./types.js";

/**
 * Load hook manifests from `~/.novi/hooks/hooks.json` (user) and
 * `<cwd>/.novi/hooks/hooks.json` (project, gated by trust).
 *
 * Merge semantics: matcher groups for the same event name are appended (user
 * first, project second); groups are never deduplicated or overridden.
 *
 * Degradation (mirrors settings/resources loaders): a missing file yields no
 * events and no diagnostics; a file that fails to parse or whose shape is
 * wrong contributes a diagnostic and is skipped; unknown event names produce a
 * per-event diagnostic and are skipped. Never throws — startup is never
 * blocked.
 */
export async function loadHooks(
  env: ExecutionEnv,
  cwd: string,
  opts: { includeProject?: boolean } = {},
): Promise<HookConfig> {
  const diagnostics: string[] = [];
  const events = new Map<string, HookMatcherGroup[]>();

  const userPath = path.join(getNoviDir(), "hooks", "hooks.json");
  const projectPath = path.join(cwd, ".novi", "hooks", "hooks.json");

  const userGroups = await readManifest(env, userPath, "user", diagnostics);
  appendGroups(events, userGroups);

  if (opts.includeProject !== false) {
    const projectGroups = await readManifest(env, projectPath, "project", diagnostics);
    appendGroups(events, projectGroups);
  }

  return { events, diagnostics };
}

/** Read and validate one manifest file, returning event → matcher groups. */
async function readManifest(
  env: ExecutionEnv,
  filePath: string,
  label: string,
  diagnostics: string[],
): Promise<Map<string, HookMatcherGroup[]>> {
  const out = new Map<string, HookMatcherGroup[]>();

  const result = await env.readTextFile(filePath);
  if (!result.ok) return out; // missing file is expected
  const text = result.value.trim();
  if (!text) return out;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    diagnostics.push(
      `hooks [${label}] failed to parse ${filePath}: ${e instanceof Error ? e.message : String(e)}`,
    );
    return out;
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    diagnostics.push(`hooks [${label}] root is not a JSON object: ${filePath}`);
    return out;
  }

  const manifest = parsed as HookManifest;
  const hooksMap = manifest.hooks;
  if (hooksMap === undefined || hooksMap === null) {
    return out;
  }
  if (typeof hooksMap !== "object" || Array.isArray(hooksMap)) {
    diagnostics.push(`hooks [${label}] "hooks" is not an object: ${filePath}`);
    return out;
  }

  for (const [event, rawGroups] of Object.entries(hooksMap)) {
    if (!SUPPORTED_EVENTS.has(event)) {
      diagnostics.push(
        `hooks [${label}] unknown event "${event}" in ${filePath}; supported: ${[...SUPPORTED_EVENTS].join(", ")}`,
      );
      continue;
    }
    if (!Array.isArray(rawGroups)) {
      diagnostics.push(
        `hooks [${label}] event "${event}" must be an array of matcher groups: ${filePath}`,
      );
      continue;
    }
    const groups: HookMatcherGroup[] = [];
    for (let i = 0; i < rawGroups.length; i++) {
      const g = validateGroup(rawGroups[i], event, i, label, filePath, diagnostics);
      if (g) groups.push(g);
    }
    if (groups.length > 0) {
      // Append to any existing groups from the other layer (user before project).
      const existing = out.get(event) ?? [];
      existing.push(...groups);
      out.set(event, existing);
    }
  }

  return out;
}

/** Validate a single matcher group entry; return it or undefined + diagnostic. */
function validateGroup(
  raw: unknown,
  event: string,
  index: number,
  label: string,
  filePath: string,
  diagnostics: string[],
): HookMatcherGroup | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    diagnostics.push(
      `hooks [${label}] event "${event}" group ${index} is not an object: ${filePath}`,
    );
    return undefined;
  }
  const r = raw as Record<string, unknown>;
  const matcher = typeof r.matcher === "string" ? r.matcher : undefined;
  const rawHooks = r.hooks;
  if (!Array.isArray(rawHooks)) {
    diagnostics.push(
      `hooks [${label}] event "${event}" group ${index} has no "hooks" array: ${filePath}`,
    );
    return undefined;
  }
  const hooks: HookHandlerConfig[] = [];
  for (let j = 0; j < rawHooks.length; j++) {
    const h = validateHandler(rawHooks[j], event, index, j, label, filePath, diagnostics);
    if (h) hooks.push(h);
  }
  if (hooks.length === 0) {
    diagnostics.push(
      `hooks [${label}] event "${event}" group ${index} has no valid handlers: ${filePath}`,
    );
    return undefined;
  }
  return { matcher, hooks };
}

/** Validate a single handler entry; return it or undefined + diagnostic. */
function validateHandler(
  raw: unknown,
  event: string,
  groupIndex: number,
  handlerIndex: number,
  label: string,
  filePath: string,
  diagnostics: string[],
): HookHandlerConfig | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    diagnostics.push(
      `hooks [${label}] event "${event}" group ${groupIndex} handler ${handlerIndex} is not an object: ${filePath}`,
    );
    return undefined;
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.command !== "string" || !r.command) {
    diagnostics.push(
      `hooks [${label}] event "${event}" group ${groupIndex} handler ${handlerIndex} missing "command": ${filePath}`,
    );
    return undefined;
  }
  const args = Array.isArray(r.args) && r.args.every((a) => typeof a === "string") ? r.args : undefined;
  const timeoutMs = typeof r.timeoutMs === "number" ? r.timeoutMs : undefined;
  return { command: r.command, args, timeoutMs };
}

/** Append matcher groups from `src` into `dst`, merging same-event arrays. */
function appendGroups(
  dst: Map<string, HookMatcherGroup[]>,
  src: Map<string, HookMatcherGroup[]>,
): void {
  for (const [event, groups] of src) {
    const existing = dst.get(event) ?? [];
    existing.push(...groups);
    dst.set(event, existing);
  }
}