import type { ThinkingLevel } from "@earendil-works/pi-agent-core/node";
import type { PermissionRule } from "../permissions/types.js";
import type {
  AgentProfileSettings,
  ResolvedSubagentSettings,
  SubagentSettings,
} from "./types.js";

export const DEFAULT_SUBAGENT_SETTINGS: Readonly<ResolvedSubagentSettings> = {
  enabled: true,
  maxConcurrent: 8,
  maxChildrenPerParent: 5,
  maxSpawnDepth: 1,
  runTimeoutMs: 15 * 60 * 1000,
  maxResultBytes: 64 * 1024,
  retentionDays: 30,
  profiles: {},
};

export interface SubagentSettingsLayers {
  global: { subagents?: SubagentSettings } | null;
  project: { subagents?: SubagentSettings } | null;
}

export interface ResolvedSubagentSettingsResult {
  values: ResolvedSubagentSettings;
  sources: Record<string, "default" | "global" | "project">;
  diagnostics: string[];
}

/** Resolve global authority plus a trusted project layer that can only tighten it. */
export function resolveSubagentSettings(
  layers: SubagentSettingsLayers,
): ResolvedSubagentSettingsResult {
  const diagnostics: string[] = [];
  const sources: Record<string, "default" | "global" | "project"> = {};
  const global = sanitizeSettings(layers.global?.subagents, "global", diagnostics);
  const project = sanitizeSettings(layers.project?.subagents, "project", diagnostics);

  const values: ResolvedSubagentSettings = {
    enabled: resolveEnabled(global.enabled, project.enabled, diagnostics),
    maxConcurrent: tightenNumber(
      "maxConcurrent",
      DEFAULT_SUBAGENT_SETTINGS.maxConcurrent,
      global.maxConcurrent,
      project.maxConcurrent,
      sources,
      diagnostics,
    ),
    maxChildrenPerParent: tightenNumber(
      "maxChildrenPerParent",
      DEFAULT_SUBAGENT_SETTINGS.maxChildrenPerParent,
      global.maxChildrenPerParent,
      project.maxChildrenPerParent,
      sources,
      diagnostics,
    ),
    maxSpawnDepth: tightenNumber(
      "maxSpawnDepth",
      DEFAULT_SUBAGENT_SETTINGS.maxSpawnDepth,
      global.maxSpawnDepth,
      project.maxSpawnDepth,
      sources,
      diagnostics,
      0,
    ),
    runTimeoutMs: tightenNumber(
      "runTimeoutMs",
      DEFAULT_SUBAGENT_SETTINGS.runTimeoutMs,
      global.runTimeoutMs,
      project.runTimeoutMs,
      sources,
      diagnostics,
    ),
    maxResultBytes: tightenNumber(
      "maxResultBytes",
      DEFAULT_SUBAGENT_SETTINGS.maxResultBytes,
      global.maxResultBytes,
      project.maxResultBytes,
      sources,
      diagnostics,
    ),
    retentionDays: tightenNumber(
      "retentionDays",
      DEFAULT_SUBAGENT_SETTINGS.retentionDays,
      global.retentionDays,
      project.retentionDays,
      sources,
      diagnostics,
    ),
    profiles: mergeProfiles(global.profiles, project.profiles, diagnostics),
  };

  sources.enabled =
    project.enabled === false ? "project" : global.enabled !== undefined ? "global" : "default";
  const models = tightenList("allowedModels", global.allowedModels, project.allowedModels, diagnostics);
  if (models !== undefined) values.allowedModels = models;
  sources.allowedModels =
    project.allowedModels !== undefined
      ? "project"
      : global.allowedModels !== undefined
        ? "global"
        : "default";
  sources.profiles = project.profiles
    ? "project"
    : global.profiles
      ? "global"
      : "default";

  return { values, sources, diagnostics };
}

/** Merge used by the settings display/load view; runtime calls the resolver again. */
export function mergeSubagentSettings(
  global: SubagentSettings | undefined,
  project: SubagentSettings | undefined,
): SubagentSettings | undefined {
  if (!global && !project) return undefined;
  return resolveSubagentSettings({
    global: global ? { subagents: global } : null,
    project: project ? { subagents: project } : null,
  }).values;
}

function sanitizeSettings(
  value: SubagentSettings | undefined,
  source: "global" | "project",
  diagnostics: string[],
): SubagentSettings {
  if (value === undefined) return {};
  if (!isRecord(value)) {
    diagnostics.push(`settings [${source}] subagents must be an object`);
    return {};
  }
  const out: SubagentSettings = {};
  if (typeof value.enabled === "boolean") out.enabled = value.enabled;
  else if (value.enabled !== undefined) diagnostics.push(`settings [${source}] subagents.enabled is invalid`);
  for (const key of [
    "maxConcurrent",
    "maxChildrenPerParent",
    "maxSpawnDepth",
    "runTimeoutMs",
    "maxResultBytes",
    "retentionDays",
  ] as const) {
    const raw = value[key];
    if (raw === undefined) continue;
    if (
      typeof raw === "number" &&
      Number.isSafeInteger(raw) &&
      raw >= (key === "maxSpawnDepth" ? 0 : 1)
    )
      out[key] = raw;
    else diagnostics.push(`settings [${source}] subagents.${key} is invalid`);
  }
  if (value.allowedModels !== undefined) {
    const list = stringList(value.allowedModels);
    if (list) out.allowedModels = list;
    else diagnostics.push(`settings [${source}] subagents.allowedModels is invalid`);
  }
  if (value.profiles !== undefined) {
    if (!isRecord(value.profiles)) {
      diagnostics.push(`settings [${source}] subagents.profiles must be an object`);
    } else {
      const profiles: Record<string, AgentProfileSettings> = {};
      for (const [name, raw] of Object.entries(value.profiles)) {
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(name) || !isRecord(raw)) {
          diagnostics.push(`settings [${source}] subagents.profiles.${name} is invalid`);
          continue;
        }
        profiles[name] = sanitizeProfile(raw, source, name, diagnostics);
      }
      out.profiles = profiles;
    }
  }
  return out;
}

function sanitizeProfile(
  raw: Record<string, unknown>,
  source: "global" | "project",
  name: string,
  diagnostics: string[],
): AgentProfileSettings {
  const profile: AgentProfileSettings = {};
  const prefix = `settings [${source}] subagents.profiles.${name}`;
  for (const key of ["enabled", "writable"] as const) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] === "boolean") profile[key] = raw[key];
    else diagnostics.push(`${prefix}.${key} is invalid`);
  }
  for (const key of ["description", "systemPrompt"] as const) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] === "string") profile[key] = raw[key];
    else diagnostics.push(`${prefix}.${key} is invalid`);
  }
  if (raw.model !== undefined) {
    if (raw.model === "inherit" || (typeof raw.model === "string" && modelRef(raw.model))) {
      profile.model = raw.model as AgentProfileSettings["model"];
    } else diagnostics.push(`${prefix}.model is invalid`);
  }
  if (raw.maxThinking !== undefined) {
    if (thinkingLevel(raw.maxThinking)) profile.maxThinking = raw.maxThinking;
    else diagnostics.push(`${prefix}.maxThinking is invalid`);
  }
  if (raw.tools !== undefined) {
    if (isRecord(raw.tools)) {
      const allow = raw.tools.allow === undefined ? undefined : stringList(raw.tools.allow);
      const deny = raw.tools.deny === undefined ? undefined : stringList(raw.tools.deny);
      if (allow) profile.tools = { ...profile.tools, allow };
      else if (raw.tools.allow !== undefined) diagnostics.push(`${prefix}.tools.allow is invalid`);
      if (deny) profile.tools = { ...profile.tools, deny };
      else if (raw.tools.deny !== undefined) diagnostics.push(`${prefix}.tools.deny is invalid`);
    } else diagnostics.push(`${prefix}.tools is invalid`);
  }
  for (const key of ["skills", "mcpSources"] as const) {
    if (raw[key] === undefined) continue;
    const list = stringList(raw[key]);
    if (list) profile[key] = list;
    else diagnostics.push(`${prefix}.${key} is invalid`);
  }
  if (raw.permissions !== undefined) {
    if (Array.isArray(raw.permissions)) profile.permissions = raw.permissions as PermissionRule[];
    else diagnostics.push(`${prefix}.permissions is invalid`);
  }
  return profile;
}

function resolveEnabled(global: boolean | undefined, project: boolean | undefined, diagnostics: string[]): boolean {
  const base = global ?? DEFAULT_SUBAGENT_SETTINGS.enabled;
  if (project === false) return false;
  if (project === true && !base) diagnostics.push("settings [project] subagents.enabled cannot re-enable a global disable");
  return base;
}

function tightenNumber(
  key: string,
  fallback: number,
  global: number | undefined,
  project: number | undefined,
  sources: Record<string, "default" | "global" | "project">,
  diagnostics: string[],
  minimum = 1,
): number {
  const base = global ?? fallback;
  sources[key] = global === undefined ? "default" : "global";
  if (project === undefined) return base;
  if (project < minimum || project > base) {
    diagnostics.push(`settings [project] subagents.${key} cannot raise the effective limit`);
    return base;
  }
  sources[key] = "project";
  return project;
}

function tightenList(
  key: string,
  global: string[] | undefined,
  project: string[] | undefined,
  diagnostics: string[],
): string[] | undefined {
  if (project === undefined) return global ? [...global] : undefined;
  if (global === undefined) return [...project];
  const allowed = new Set(global);
  const result = project.filter((item) => allowed.has(item));
  if (result.length !== project.length) diagnostics.push(`settings [project] subagents.${key} cannot add values`);
  return result;
}

function mergeProfiles(
  global: Record<string, AgentProfileSettings> | undefined,
  project: Record<string, AgentProfileSettings> | undefined,
  diagnostics: string[],
): Record<string, AgentProfileSettings> {
  const result: Record<string, AgentProfileSettings> = structuredClone(global ?? {});
  for (const [name, restriction] of Object.entries(project ?? {})) {
    const base = result[name];
    if (!base) {
      if (!["explorer", "reviewer", "worker"].includes(name)) {
        diagnostics.push(`settings [project] subagents.profiles.${name} cannot create a profile`);
        continue;
      }
      result[name] = builtInRestriction(name, restriction, diagnostics);
      continue;
    }
    const next: AgentProfileSettings = { ...base };
    if (restriction.enabled === false) next.enabled = false;
    else if (restriction.enabled === true && base.enabled === false)
      diagnostics.push(`settings [project] subagents.profiles.${name}.enabled cannot re-enable profile`);
    if (restriction.writable === false) next.writable = false;
    else if (restriction.writable === true && base.writable !== true)
      diagnostics.push(`settings [project] subagents.profiles.${name}.writable cannot add writes`);
    if (restriction.tools) {
      next.tools = {
        allow: tightenList(
          `profiles.${name}.tools.allow`,
          base.tools?.allow,
          restriction.tools.allow,
          diagnostics,
        ),
        deny: unique([...(base.tools?.deny ?? []), ...(restriction.tools.deny ?? [])]),
      };
    }
    for (const key of ["skills", "mcpSources"] as const) {
      if (restriction[key] !== undefined)
        next[key] = tightenList(`profiles.${name}.${key}`, base[key], restriction[key], diagnostics);
    }
    if (restriction.maxThinking !== undefined) {
      if (base.maxThinking === undefined || thinkingRank(restriction.maxThinking) <= thinkingRank(base.maxThinking))
        next.maxThinking = restriction.maxThinking;
      else diagnostics.push(`settings [project] subagents.profiles.${name}.maxThinking cannot increase`);
    }
    if (restriction.permissions) {
      next.permissions = [
        ...(base.permissions ?? []),
        ...restriction.permissions.filter((rule) => rule.effect === "ask" || rule.effect === "deny"),
      ];
    }
    result[name] = next;
  }
  return result;
}

function builtInRestriction(
  name: string,
  restriction: AgentProfileSettings,
  diagnostics: string[],
): AgentProfileSettings {
  const result: AgentProfileSettings = {};
  if (restriction.enabled === false) result.enabled = false;
  if (restriction.writable === false) result.writable = false;
  else if (restriction.writable === true && name !== "worker")
    diagnostics.push(`settings [project] subagents.profiles.${name}.writable cannot add writes`);
  if (restriction.tools) {
    result.tools = {
      ...(restriction.tools.allow ? { allow: [...restriction.tools.allow] } : {}),
      ...(restriction.tools.deny ? { deny: [...restriction.tools.deny] } : {}),
    };
  }
  if (restriction.skills) result.skills = [...restriction.skills];
  if (restriction.mcpSources) result.mcpSources = [...restriction.mcpSources];
  if (restriction.maxThinking) result.maxThinking = restriction.maxThinking;
  if (restriction.permissions) {
    result.permissions = restriction.permissions.filter(
      (rule) => rule.effect === "ask" || rule.effect === "deny",
    );
  }
  return result;
}

function thinkingLevel(value: unknown): value is ThinkingLevel {
  return ["off", "minimal", "low", "medium", "high", "xhigh"].includes(String(value));
}

function thinkingRank(value: ThinkingLevel): number {
  return ["off", "minimal", "low", "medium", "high", "xhigh"].indexOf(value);
}

function modelRef(value: string): boolean {
  return /^[^/\s]+\/[^/\s]+$/.test(value);
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) return undefined;
  return unique(value as string[]);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
