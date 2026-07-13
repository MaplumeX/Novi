import { createHash } from "node:crypto";
import path from "node:path";
import type { ExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { getNoviDir } from "../config.js";
import type {
  McpConfigFile,
  McpDeclarationsResult,
  McpHttpServerConfig,
  McpServerConfig,
  McpServerOrigin,
  McpStdioServerConfig,
  ResolvedMcpServerDeclaration,
} from "./types.js";

const SERVER_NAME_RE = /^[A-Za-z0-9_-]+$/;
const PLACEHOLDER_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

const STDIO_KEYS = new Set(["command", "args", "env", "cwd"]);
const HTTP_KEYS = new Set(["url", "headers"]);

/** Absolute path to the user MCP config (`~/.novi/mcp.json`). */
export function getUserMcpConfigPath(): string {
  return path.join(getNoviDir(), "mcp.json");
}

/** Primary project MCP config path (`<cwd>/.mcp.json`). */
export function getProjectMcpConfigPrimaryPath(cwd: string): string {
  return path.join(cwd, ".mcp.json");
}

/** Secondary project MCP config path (`<cwd>/.novi/mcp.json`). */
export function getProjectMcpConfigSecondaryPath(cwd: string): string {
  return path.join(cwd, ".novi", "mcp.json");
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function sortedStringRecord(record: Record<string, string> | undefined): {
  keys: string[];
  hashes: Record<string, string>;
} {
  const keys = Object.keys(record ?? {}).sort((a, b) => a.localeCompare(b));
  const hashes: Record<string, string> = {};
  for (const key of keys) {
    hashes[key] = sha256(record![key]);
  }
  return { keys, hashes };
}

/**
 * Stable identity fingerprint for a server declaration.
 *
 * Includes transport shape + env/header key sets and value hashes (not raw secrets).
 */
export function computeServerFingerprint(name: string, config: McpServerConfig): string {
  if ("command" in config) {
    const { keys, hashes } = sortedStringRecord(config.env);
    const payload = {
      name,
      kind: "stdio" as const,
      command: config.command,
      args: config.args ?? [],
      cwd: config.cwd ?? null,
      envKeys: keys,
      envHashes: hashes,
    };
    return sha256(JSON.stringify(payload));
  }
  const { keys, hashes } = sortedStringRecord(config.headers);
  const payload = {
    name,
    kind: "http" as const,
    url: config.url,
    headerKeys: keys,
    headerHashes: hashes,
  };
  return sha256(JSON.stringify(payload));
}

/**
 * Resolve `${VAR}` placeholders in a string against an env map.
 *
 * v1 supports only `${VAR}` (no defaults). Missing vars are reported; the
 * returned value keeps unresolved placeholders in place.
 */
export function resolveEnvPlaceholders(
  value: string,
  envMap: Record<string, string | undefined>,
): { ok: boolean; value: string; missing: string[] } {
  const missing: string[] = [];
  const seen = new Set<string>();
  const resolved = value.replace(PLACEHOLDER_RE, (match, name: string) => {
    const envValue = envMap[name];
    if (envValue === undefined) {
      if (!seen.has(name)) {
        seen.add(name);
        missing.push(name);
      }
      return match;
    }
    return envValue;
  });
  return { ok: missing.length === 0, value: resolved, missing };
}

/**
 * Apply {@link resolveEnvPlaceholders} to string fields of a server config.
 * Connect-time enforcement of missing vars belongs to the client layer.
 */
export function resolveServerConfigPlaceholders(
  config: McpServerConfig,
  envMap: Record<string, string | undefined>,
): { ok: boolean; config: McpServerConfig; missing: string[] } {
  const missing: string[] = [];

  const resolveField = (value: string): string => {
    const result = resolveEnvPlaceholders(value, envMap);
    for (const name of result.missing) {
      if (!missing.includes(name)) missing.push(name);
    }
    return result.value;
  };

  if ("command" in config) {
    const env = config.env
      ? Object.fromEntries(Object.entries(config.env).map(([k, v]) => [k, resolveField(v)]))
      : undefined;
    const next: McpStdioServerConfig = {
      command: resolveField(config.command),
      args: config.args?.map(resolveField),
      env,
      cwd: config.cwd !== undefined ? resolveField(config.cwd) : undefined,
    };
    return { ok: missing.length === 0, config: next, missing };
  }

  const headers = config.headers
    ? Object.fromEntries(Object.entries(config.headers).map(([k, v]) => [k, resolveField(v)]))
    : undefined;
  const next: McpHttpServerConfig = {
    url: resolveField(config.url),
    headers,
  };
  return { ok: missing.length === 0, config: next, missing };
}

async function readConfigLayer(
  env: ExecutionEnv,
  filePath: string,
  label: string,
): Promise<{ raw: McpConfigFile | null; diagnostics: string[] }> {
  const diagnostics: string[] = [];
  const result = await env.readTextFile(filePath);
  if (!result.ok) return { raw: null, diagnostics }; // missing is fine
  const text = result.value.trim();
  if (!text) return { raw: null, diagnostics };
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      diagnostics.push(`mcp [${label}] root is not a JSON object: ${filePath}`);
      return { raw: null, diagnostics };
    }
    return { raw: parsed as McpConfigFile, diagnostics };
  } catch (e) {
    diagnostics.push(
      `mcp [${label}] failed to parse ${filePath}: ${e instanceof Error ? e.message : String(e)}`,
    );
    return { raw: null, diagnostics };
  }
}

function isAbsoluteHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function validateStringRecord(
  value: unknown,
  fieldLabel: string,
  diagnostics: string[],
): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    diagnostics.push(`${fieldLabel} must be an object of string values`);
    return undefined;
  }
  const out: Record<string, string> = {};
  let ok = true;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v !== "string") {
      diagnostics.push(`${fieldLabel}.${k} must be a string`);
      ok = false;
      continue;
    }
    out[k] = v;
  }
  return ok ? out : undefined;
}

/**
 * Validate one raw server entry. Returns a structured declaration (possibly invalid).
 */
export function validateServerEntry(
  name: string,
  raw: unknown,
  origin: McpServerOrigin,
): ResolvedMcpServerDeclaration {
  const diagnostics: string[] = [];

  if (!name || name.trim() === "") {
    return {
      name,
      origin,
      fingerprint: `invalid:${name}`,
      diagnostics: ["server name must be non-empty"],
      invalid: true,
      reason: "server name must be non-empty",
    };
  }

  if (!SERVER_NAME_RE.test(name)) {
    diagnostics.push(
      `server name "${name}" should match [A-Za-z0-9_-]+; treating as invalid`,
    );
    return {
      name,
      origin,
      fingerprint: `invalid:${name}`,
      diagnostics,
      invalid: true,
      reason: `invalid server name "${name}"`,
    };
  }

  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      name,
      origin,
      fingerprint: `invalid:${name}`,
      diagnostics: [`server "${name}" config must be an object`],
      invalid: true,
      reason: `server "${name}" config must be an object`,
    };
  }

  const obj = raw as Record<string, unknown>;
  const hasCommand = Object.prototype.hasOwnProperty.call(obj, "command");
  const hasUrl = Object.prototype.hasOwnProperty.call(obj, "url");

  if (hasCommand && hasUrl) {
    return {
      name,
      origin,
      fingerprint: `invalid:${name}`,
      diagnostics: [`server "${name}" cannot define both command and url`],
      invalid: true,
      reason: `server "${name}" cannot define both command and url`,
    };
  }

  if (!hasCommand && !hasUrl) {
    return {
      name,
      origin,
      fingerprint: `invalid:${name}`,
      diagnostics: [`server "${name}" must define command (stdio) or url (http)`],
      invalid: true,
      reason: `server "${name}" must define command (stdio) or url (http)`,
    };
  }

  if (hasCommand) {
    for (const key of Object.keys(obj)) {
      if (!STDIO_KEYS.has(key)) {
        diagnostics.push(`server "${name}" ignores unknown field "${key}"`);
      }
    }

    if (typeof obj.command !== "string" || obj.command.trim() === "") {
      return {
        name,
        origin,
        fingerprint: `invalid:${name}`,
        diagnostics: [...diagnostics, `server "${name}" command must be a non-empty string`],
        invalid: true,
        reason: `server "${name}" command must be a non-empty string`,
      };
    }

    let args: string[] | undefined;
    if (obj.args !== undefined) {
      if (!Array.isArray(obj.args) || !obj.args.every((a) => typeof a === "string")) {
        return {
          name,
          origin,
          fingerprint: `invalid:${name}`,
          diagnostics: [...diagnostics, `server "${name}" args must be an array of strings`],
          invalid: true,
          reason: `server "${name}" args must be an array of strings`,
        };
      }
      args = obj.args as string[];
    }

    const envDiag: string[] = [];
    const env = validateStringRecord(obj.env, `server "${name}" env`, envDiag);
    diagnostics.push(...envDiag);
    if (obj.env !== undefined && env === undefined) {
      return {
        name,
        origin,
        fingerprint: `invalid:${name}`,
        diagnostics,
        invalid: true,
        reason: `server "${name}" env is invalid`,
      };
    }

    if (obj.cwd !== undefined && typeof obj.cwd !== "string") {
      return {
        name,
        origin,
        fingerprint: `invalid:${name}`,
        diagnostics: [...diagnostics, `server "${name}" cwd must be a string`],
        invalid: true,
        reason: `server "${name}" cwd must be a string`,
      };
    }

    const config: McpStdioServerConfig = {
      command: obj.command,
      ...(args !== undefined ? { args } : {}),
      ...(env !== undefined ? { env } : {}),
      ...(typeof obj.cwd === "string" ? { cwd: obj.cwd } : {}),
    };
    return {
      name,
      origin,
      config,
      fingerprint: computeServerFingerprint(name, config),
      diagnostics,
      invalid: false,
    };
  }

  // HTTP transport
  for (const key of Object.keys(obj)) {
    if (!HTTP_KEYS.has(key)) {
      diagnostics.push(`server "${name}" ignores unknown field "${key}"`);
    }
  }

  if (typeof obj.url !== "string" || obj.url.trim() === "") {
    return {
      name,
      origin,
      fingerprint: `invalid:${name}`,
      diagnostics: [...diagnostics, `server "${name}" url must be a non-empty string`],
      invalid: true,
      reason: `server "${name}" url must be a non-empty string`,
    };
  }

  if (!isAbsoluteHttpUrl(obj.url)) {
    return {
      name,
      origin,
      fingerprint: `invalid:${name}`,
      diagnostics: [
        ...diagnostics,
        `server "${name}" url must be an absolute http(s) URL`,
      ],
      invalid: true,
      reason: `server "${name}" url must be an absolute http(s) URL`,
    };
  }

  const headerDiag: string[] = [];
  const headers = validateStringRecord(obj.headers, `server "${name}" headers`, headerDiag);
  diagnostics.push(...headerDiag);
  if (obj.headers !== undefined && headers === undefined) {
    return {
      name,
      origin,
      fingerprint: `invalid:${name}`,
      diagnostics,
      invalid: true,
      reason: `server "${name}" headers is invalid`,
    };
  }

  const config: McpHttpServerConfig = {
    url: obj.url,
    ...(headers !== undefined ? { headers } : {}),
  };
  return {
    name,
    origin,
    config,
    fingerprint: computeServerFingerprint(name, config),
    diagnostics,
    invalid: false,
  };
}

function layerServersFromRaw(
  raw: McpConfigFile | null,
  origin: McpServerOrigin,
  diagnostics: string[],
): Map<string, { raw: unknown; origin: McpServerOrigin }> {
  const map = new Map<string, { raw: unknown; origin: McpServerOrigin }>();
  if (!raw) return map;
  if (raw.mcpServers === undefined) return map;
  if (raw.mcpServers === null || typeof raw.mcpServers !== "object" || Array.isArray(raw.mcpServers)) {
    diagnostics.push(`mcp [${origin}] mcpServers must be an object`);
    return map;
  }
  for (const [name, value] of Object.entries(raw.mcpServers)) {
    map.set(name, { raw: value, origin });
  }
  return map;
}

/**
 * Load, validate, and merge user + project MCP server declarations.
 *
 * Project overlay wins on name collision (origin becomes `"project"`).
 * Missing/corrupt files contribute empty layers + diagnostics; never throws.
 */
export async function loadMcpDeclarations(
  env: ExecutionEnv,
  cwd: string,
): Promise<McpDeclarationsResult> {
  const diagnostics: string[] = [];
  const absCwd = path.resolve(cwd);

  const userLayer = await readConfigLayer(env, getUserMcpConfigPath(), "user");
  diagnostics.push(...userLayer.diagnostics);

  const primaryPath = getProjectMcpConfigPrimaryPath(absCwd);
  const secondaryPath = getProjectMcpConfigSecondaryPath(absCwd);
  const primaryInfo = await env.fileInfo(primaryPath);
  const secondaryInfo = await env.fileInfo(secondaryPath);

  let projectRaw: McpConfigFile | null = null;
  if (primaryInfo.ok) {
    const primaryLayer = await readConfigLayer(env, primaryPath, "project");
    diagnostics.push(...primaryLayer.diagnostics);
    projectRaw = primaryLayer.raw;
    if (secondaryInfo.ok) {
      diagnostics.push(
        `mcp [project] both ${primaryPath} and ${secondaryPath} exist; using primary, ignoring secondary`,
      );
    }
  } else if (secondaryInfo.ok) {
    const secondaryLayer = await readConfigLayer(env, secondaryPath, "project");
    diagnostics.push(...secondaryLayer.diagnostics);
    projectRaw = secondaryLayer.raw;
  }

  const userMap = layerServersFromRaw(userLayer.raw, "user", diagnostics);
  const projectMap = layerServersFromRaw(projectRaw, "project", diagnostics);

  // Merge: start from user, project overlays by name.
  const merged = new Map<string, { raw: unknown; origin: McpServerOrigin; overlaid?: boolean }>();
  for (const [name, entry] of userMap) {
    merged.set(name, entry);
  }
  for (const [name, entry] of projectMap) {
    if (merged.has(name)) {
      diagnostics.push(
        `mcp: project server "${name}" overlays user server of the same name`,
      );
      merged.set(name, { ...entry, overlaid: true });
    } else {
      merged.set(name, entry);
    }
  }

  const servers: ResolvedMcpServerDeclaration[] = [];
  for (const [name, entry] of merged) {
    const decl = validateServerEntry(name, entry.raw, entry.origin);
    if (entry.overlaid) {
      decl.diagnostics = [
        `project overlays user declaration for "${name}"`,
        ...decl.diagnostics,
      ];
    }
    servers.push(decl);
  }

  // Stable order by name for deterministic plans/tests.
  servers.sort((a, b) => a.name.localeCompare(b.name));
  return { servers, diagnostics };
}

/** Alias matching the PRD naming (`loadMcpConfig`). */
export const loadMcpConfig = loadMcpDeclarations;
