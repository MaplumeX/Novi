import type {
  PermissionLevel,
  ResolvedPermissions,
  ToolPermissionMap,
} from "./types.js";

/**
 * Built-in defaults (not written to disk). Only `bash` asks; every other
 * tool is implicitly `allow` when unlisted.
 */
export const DEFAULT_TOOL_PERMISSIONS: ToolPermissionMap = {
  bash: "ask",
};

/** Severity ordering for tighten-only project merge: higher = stricter. */
const SEVERITY: Record<PermissionLevel, number> = {
  allow: 0,
  ask: 1,
  deny: 2,
};

/**
 * Resolve the effective level for one tool from a tools map.
 * Unlisted tools default to `allow`.
 */
export function resolveToolPermission(
  toolsMap: ToolPermissionMap,
  toolName: string,
): PermissionLevel {
  return toolsMap[toolName] ?? "allow";
}

/**
 * Merge project permissions onto a base map with **tighten-only** semantics:
 * a project value is accepted only when `severity(project) >= severity(base)`.
 * Project cannot relax `ask→allow` or change a `deny`.
 *
 * Tools present only in project (not in base) are accepted as-is (they
 * tighten the implicit default `allow`).
 */
export function mergePermissionsTightenOnly(
  base: ToolPermissionMap,
  project: ToolPermissionMap,
): ToolPermissionMap {
  const out: ToolPermissionMap = { ...base };
  for (const [tool, projectLevel] of Object.entries(project)) {
    if (!isPermissionLevel(projectLevel)) continue;
    const current = out[tool] ?? "allow";
    if (SEVERITY[projectLevel] >= SEVERITY[current]) {
      out[tool] = projectLevel;
    }
    // else: project tries to relax — ignore
  }
  return out;
}

function isPermissionLevel(value: unknown): value is PermissionLevel {
  return value === "allow" || value === "ask" || value === "deny";
}

/**
 * Sanitize a raw tools map from settings (drop unknown values / non-strings).
 */
export function sanitizeToolPermissions(
  raw: Record<string, unknown> | undefined | null,
): ToolPermissionMap {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: ToolPermissionMap = {};
  for (const [tool, level] of Object.entries(raw)) {
    if (isPermissionLevel(level)) out[tool] = level;
  }
  return out;
}

/**
 * Resolve effective permissions from settings layers + CLI `--yes`.
 *
 * Algorithm:
 * 1. start from {@link DEFAULT_TOOL_PERMISSIONS}
 * 2. override with global.permissions.tools (full override per tool)
 * 3. merge project.permissions.tools with tighten-only
 * 4. if `yes`, convert every effective `ask` → `allow`
 *
 * When split layers are unavailable, pass the merged map as `globalTools`
 * and leave `projectTools` empty (tighten already applied during settings
 * merge is NOT assumed — prefer split layers).
 */
export function resolvePermissions(opts: {
  globalTools?: ToolPermissionMap;
  projectTools?: ToolPermissionMap;
  /** Already-merged tools map (used when layers are not split). */
  mergedTools?: ToolPermissionMap;
  yes?: boolean;
}): ResolvedPermissions {
  let tools: ToolPermissionMap = { ...DEFAULT_TOOL_PERMISSIONS };

  if (opts.globalTools) {
    tools = { ...tools, ...sanitizeToolPermissions(opts.globalTools) };
  }
  if (opts.projectTools) {
    tools = mergePermissionsTightenOnly(
      tools,
      sanitizeToolPermissions(opts.projectTools),
    );
  } else if (opts.mergedTools) {
    // Fallback path: treat merged as a full override of defaults (no
    // tighten). Prefer split layers for correct project semantics.
    tools = { ...tools, ...sanitizeToolPermissions(opts.mergedTools) };
  }

  if (opts.yes) {
    const next: ToolPermissionMap = {};
    for (const [tool, level] of Object.entries(tools)) {
      next[tool] = level === "ask" ? "allow" : level;
    }
    tools = next;
  }

  return { tools };
}

/**
 * Convenience: resolve from a settings-like object with optional layers.
 *
 * `settings.permissions.tools` is the merged view; when `layers` is provided
 * the split global/project maps drive tighten-only merge.
 */
export function resolvePermissionsFromSettings(
  settings: {
    permissions?: { tools?: Record<string, unknown> };
  } | null | undefined,
  opts: {
    yes?: boolean;
    layers?: {
      global?: { permissions?: { tools?: Record<string, unknown> } } | null;
      project?: { permissions?: { tools?: Record<string, unknown> } } | null;
    };
  } = {},
): ResolvedPermissions {
  if (opts.layers) {
    return resolvePermissions({
      globalTools: sanitizeToolPermissions(
        opts.layers.global?.permissions?.tools as ToolPermissionMap | undefined,
      ),
      projectTools: sanitizeToolPermissions(
        opts.layers.project?.permissions?.tools as ToolPermissionMap | undefined,
      ),
      yes: opts.yes,
    });
  }
  return resolvePermissions({
    mergedTools: sanitizeToolPermissions(
      settings?.permissions?.tools as ToolPermissionMap | undefined,
    ),
    yes: opts.yes,
  });
}
