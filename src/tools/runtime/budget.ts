import type { SettingsLayers } from "../../settings.js";

export const TOOL_BUDGET_FIELDS = [
  "modelBytes",
  "modelLines",
  "memoryBytes",
  "partialBytes",
  "partialUpdatesPerSecond",
  "timeoutMs",
  "maxConcurrentCalls",
  "traversalFiles",
  "traversalDepth",
  "resultCount",
  "artifactSessionBytes",
  "artifactGlobalBytes",
  "artifactMaxAgeMs",
  "webCacheBytes",
  "webCacheMaxAgeMs",
] as const;

export type ToolBudgetField = (typeof TOOL_BUDGET_FIELDS)[number];

export interface ToolExecutionBudget {
  modelBytes: number;
  modelLines: number;
  memoryBytes: number;
  partialBytes: number;
  partialUpdatesPerSecond: number;
  timeoutMs: number;
  maxConcurrentCalls: number;
  traversalFiles: number;
  traversalDepth: number;
  resultCount: number;
  artifactSessionBytes: number;
  artifactGlobalBytes: number;
  artifactMaxAgeMs: number;
  webCacheBytes: number;
  webCacheMaxAgeMs: number;
}

export const DEFAULT_TOOL_EXECUTION_BUDGET: Readonly<ToolExecutionBudget> = Object.freeze({
  modelBytes: 50 * 1024,
  modelLines: 2_000,
  memoryBytes: 256 * 1024,
  partialBytes: 16 * 1024,
  partialUpdatesPerSecond: 10,
  timeoutMs: 120_000,
  maxConcurrentCalls: 4,
  traversalFiles: 50_000,
  traversalDepth: 64,
  resultCount: 10_000,
  artifactSessionBytes: 256 * 1024 * 1024,
  artifactGlobalBytes: 1024 * 1024 * 1024,
  artifactMaxAgeMs: 7 * 24 * 60 * 60 * 1000,
  webCacheBytes: 512 * 1024 * 1024,
  webCacheMaxAgeMs: 30 * 24 * 60 * 60 * 1000,
});

export type ToolBudgetSource = "default" | "global" | "project" | "cli";

export interface ResolvedToolExecutionBudget {
  values: ToolExecutionBudget;
  sources: Record<ToolBudgetField, ToolBudgetSource>;
  artifactsEnabled: boolean;
  artifactsEnabledSource: ToolBudgetSource;
  diagnostics: string[];
}

export type ToolBudgetOverrides = Partial<Record<ToolBudgetField, number>>;

const FIELD_SET = new Set<string>(TOOL_BUDGET_FIELDS);

/** Parse repeatable strict CLI values such as `modelBytes=65536`. */
export function parseToolBudgetOverrides(values: readonly string[]): ToolBudgetOverrides {
  const out: ToolBudgetOverrides = {};
  for (const raw of values) {
    const match = /^([A-Za-z][A-Za-z0-9]*)=([0-9]+)$/.exec(raw);
    if (!match) {
      throw new Error(`--tool-budget expects <name>=<positive-integer>; received "${raw}"`);
    }
    const name = match[1]!;
    if (!FIELD_SET.has(name)) {
      throw new Error(
        `unknown tool budget "${name}"; expected one of: ${TOOL_BUDGET_FIELDS.join(", ")}`,
      );
    }
    const field = name as ToolBudgetField;
    const value = Number(match[2]);
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`tool budget "${field}" must be a positive safe integer`);
    }
    if (out[field] !== undefined && out[field] !== value) {
      throw new Error(`conflicting --tool-budget values for "${field}"`);
    }
    out[field] = value;
  }
  return out;
}

/** Resolve defaults ← global ← project tighten-only ← CLI. */
export function resolveToolExecutionBudget(
  layers: SettingsLayers,
  cli: ToolBudgetOverrides = {},
): ResolvedToolExecutionBudget {
  const values = { ...DEFAULT_TOOL_EXECUTION_BUDGET };
  const sources = Object.fromEntries(
    TOOL_BUDGET_FIELDS.map((field) => [field, "default"]),
  ) as Record<ToolBudgetField, ToolBudgetSource>;
  const diagnostics: string[] = [];

  applyLayer(values, sources, layers.global?.toolBudgets, "global", false, diagnostics);
  applyLayer(values, sources, layers.project?.toolBudgets, "project", true, diagnostics);
  applyLayer(values, sources, cli, "cli", false, diagnostics);

  let artifactsEnabled = true;
  let artifactsEnabledSource: ToolBudgetSource = "default";
  const globalEnabled = layers.global?.artifacts?.enabled;
  if (typeof globalEnabled === "boolean") {
    artifactsEnabled = globalEnabled;
    artifactsEnabledSource = "global";
  } else if (globalEnabled !== undefined) {
    diagnostics.push("tool resources: global artifacts.enabled must be boolean; ignored");
  }
  const projectEnabled = layers.project?.artifacts?.enabled;
  if (projectEnabled === false) {
    artifactsEnabled = false;
    artifactsEnabledSource = "project";
  } else if (projectEnabled === true) {
    diagnostics.push("tool resources: project artifacts.enabled=true ignored (tighten-only)");
  } else if (projectEnabled !== undefined) {
    diagnostics.push("tool resources: project artifacts.enabled must be boolean; ignored");
  }

  return { values, sources, artifactsEnabled, artifactsEnabledSource, diagnostics };
}

function applyLayer(
  target: ToolExecutionBudget,
  sources: Record<ToolBudgetField, ToolBudgetSource>,
  raw: ToolBudgetOverrides | undefined,
  source: Exclude<ToolBudgetSource, "default">,
  tightenOnly: boolean,
  diagnostics: string[],
): void {
  if (raw === undefined) return;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    diagnostics.push(`tool resources: ${source} toolBudgets must be an object; ignored`);
    return;
  }
  for (const [name, candidate] of Object.entries(raw)) {
    if (!FIELD_SET.has(name)) {
      diagnostics.push(`tool resources: ${source} unknown budget "${name}" ignored`);
      continue;
    }
    const field = name as ToolBudgetField;
    if (!Number.isSafeInteger(candidate) || (candidate as number) <= 0) {
      diagnostics.push(`tool resources: ${source} ${field} must be a positive integer; ignored`);
      continue;
    }
    const value = candidate as number;
    if (tightenOnly && value > target[field]) {
      diagnostics.push(
        `tool resources: project ${field}=${value} ignored (cannot exceed ${target[field]})`,
      );
      continue;
    }
    target[field] = value;
    sources[field] = source;
  }
}
