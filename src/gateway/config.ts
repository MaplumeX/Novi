import path from "node:path";
import type { ExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { getNoviDir } from "../config.js";
import type { ChannelType } from "./core/types.js";

// ---------------------------------------------------------------------------
// Schema types
// ---------------------------------------------------------------------------

/** Telegram channel entry in `gateway.json`. */
export interface TelegramChannelConfig {
  type: "telegram";
  /** Stable instance id used in session keys (`<id>:<chatId>`). */
  id: string;
  /** Bot token. Supports `${ENV_VAR}` expansion. */
  botToken: string;
  /** Connection mode; MVP uses long polling. */
  connectionMode?: "long-poll" | "webhook";
}

/** Discriminated union of all channel config shapes (MVP: telegram only). */
export type ChannelConfig = TelegramChannelConfig;

/** Queue delivery mode for messages arriving mid-turn. */
export type QueueMode = "steer" | "followup" | "interrupt";
export type DmPolicy = "pairing" | "allowlist" | "open" | "disabled";
export type GroupPolicy = "allowlist" | "open" | "disabled";

/** Raw `gateway.json` shape — all fields optional, validated before use. */
export interface RawGatewayConfig {
  queue?: {
    mode?: QueueMode;
    byChannel?: Record<string, QueueMode>;
  };
  stream?: {
    editIntervalMs?: number;
  };
  session?: {
    idleTimeoutMs?: number;
    maxConcurrent?: number;
  };
  security?: {
    allowlist?: string[];
    /** Telegram user ids allowed to approve pairing requests. Required for pairing to be usable. */
    adminAllowlist?: string[];
    dmPolicy?: DmPolicy;
    groupPolicy?: GroupPolicy;
    pairing?: { ttlMs?: number; maxPending?: number };
  };
  telegram?: {
    groups?: {
      allowlist?: string[];
      requireMention?: boolean;
      mentionPatterns?: string[];
      ignoredThreadIds?: string[];
      senderAllowlist?: string[];
    };
  };
  channels?: ChannelConfig[];
}

/** Resolved gateway config with defaults applied. */
export interface ResolvedGatewayConfig {
  queue: {
    mode: QueueMode;
    byChannel: Record<string, QueueMode>;
  };
  stream: {
    editIntervalMs: number;
  };
  session: {
    idleTimeoutMs: number;
    maxConcurrent: number;
  };
  security: {
    allowlist: Set<string>;
    adminAllowlist: Set<string>;
    dmPolicy: DmPolicy;
    groupPolicy: GroupPolicy;
    pairing: { ttlMs: number; maxPending: number };
  };
  telegram: {
    groups: {
      allowlist: Set<string>;
      requireMention: boolean;
      mentionPatterns: RegExp[];
      ignoredThreadIds: Set<string>;
      senderAllowlist: Set<string>;
    };
  };
  channels: ChannelConfig[];
}

/** Load result: resolved config + non-fatal warnings (stderr by caller). */
export interface GatewayConfigLoadResult {
  config: ResolvedGatewayConfig;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULTS = {
  queueMode: "steer" as QueueMode,
  editIntervalMs: 1000,
  idleTimeoutMs: 86_400_000, // 24h
  maxConcurrent: 10,
  pairingTtlMs: 3_600_000,
  pairingMaxPending: 3,
} as const;

// ---------------------------------------------------------------------------
// ${ENV} expansion
// ---------------------------------------------------------------------------

const ENV_PATTERN = /\$\{([A-Z_][A-Z0-9_]*)\}/g;

/**
 * Recursively replace `${ENV_VAR}` tokens in string values of an arbitrary
 * JSON-like structure with the corresponding `process.env` value. Missing env
 * vars resolve to an empty string (so a misconfigured token is visible as a
 * blank value rather than a literal `${…}`).
 *
 * Non-string values are returned as-is.
 */
export function expandEnvValues<T>(input: T): T {
  if (typeof input === "string") {
    return input.replace(ENV_PATTERN, (_, name: string) => process.env[name] ?? "") as T;
  }
  if (Array.isArray(input)) {
    return input.map((item) => expandEnvValues(item)) as T;
  }
  if (input !== null && typeof input === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      out[key] = expandEnvValues(value);
    }
    return out as T;
  }
  return input;
}

// ---------------------------------------------------------------------------
// Layer loading
// ---------------------------------------------------------------------------

async function readLayer(
  env: ExecutionEnv,
  filePath: string,
  label: string,
  diagnostics: string[],
): Promise<RawGatewayConfig | null> {
  const result = await env.readTextFile(filePath);
  if (!result.ok) return null; // missing file is expected
  const text = result.value.trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      diagnostics.push(`gateway [${label}] root is not a JSON object: ${filePath}`);
      return null;
    }
    return parsed as RawGatewayConfig;
  } catch (e) {
    diagnostics.push(
      `gateway [${label}] failed to parse ${filePath}: ${e instanceof Error ? e.message : String(e)}`,
    );
    return null;
  }
}

/**
 * Shallow-merge two config layers (project overrides global), mirroring the
 * `settings.json` merge strategy. Nested objects are merged one level deep;
 * arrays are replaced (not concatenated) so project can fully override channels.
 */
function mergeLayers(global: RawGatewayConfig, project: RawGatewayConfig): RawGatewayConfig {
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
  return out as RawGatewayConfig;
}

// ---------------------------------------------------------------------------
// Validation & resolution
// ---------------------------------------------------------------------------

function validateChannels(channels: unknown, warnings: string[]): ChannelConfig[] {
  if (!Array.isArray(channels)) return [];
  const valid: ChannelConfig[] = [];
  for (let i = 0; i < channels.length; i++) {
    const entry = channels[i] as Record<string, unknown>;
    if (!entry || typeof entry !== "object") {
      warnings.push(`gateway: channels[${i}] is not an object, skipping`);
      continue;
    }
    const type = entry.type as ChannelType | undefined;
    if (type === "telegram") {
      // type is narrowed to "telegram" by the check above
      const id = entry.id;
      const botToken = entry.botToken;
      if (typeof id !== "string" || !id) {
        warnings.push(`gateway: channels[${i}] ("telegram") missing "id", skipping`);
        continue;
      }
      if (typeof botToken !== "string" || !botToken) {
        warnings.push(`gateway: channels[${i}] ("telegram") missing "botToken", skipping`);
        continue;
      }
      valid.push({
        type: "telegram",
        id,
        botToken,
        connectionMode: entry.connectionMode as "long-poll" | "webhook" | undefined,
      });
    } else {
      warnings.push(`gateway: channels[${i}] has unknown type "${type ?? ""}", skipping`);
    }
  }
  return valid;
}

function resolveConfig(merged: RawGatewayConfig, warnings: string[]): ResolvedGatewayConfig {
  const queueMode = merged.queue?.mode ?? DEFAULTS.queueMode;
  const byChannel = merged.queue?.byChannel ?? {};
  const editIntervalMs = merged.stream?.editIntervalMs ?? DEFAULTS.editIntervalMs;
  const idleTimeoutMs = merged.session?.idleTimeoutMs ?? DEFAULTS.idleTimeoutMs;
  const maxConcurrent = merged.session?.maxConcurrent ?? DEFAULTS.maxConcurrent;
  const allowlist = new Set(merged.security?.allowlist ?? []);
  const adminAllowlist = new Set(merged.security?.adminAllowlist ?? []);
  const rawDmPolicy = merged.security?.dmPolicy;
  const dmPolicy: DmPolicy =
    rawDmPolicy === "pairing" ||
    rawDmPolicy === "allowlist" ||
    rawDmPolicy === "open" ||
    rawDmPolicy === "disabled"
      ? rawDmPolicy
      : allowlist.size > 0
        ? "allowlist"
        : "pairing";
  if (rawDmPolicy !== undefined && rawDmPolicy !== dmPolicy)
    warnings.push(`gateway: invalid security.dmPolicy "${String(rawDmPolicy)}", using ${dmPolicy}`);
  const rawGroupPolicy = merged.security?.groupPolicy;
  const groupPolicy: GroupPolicy =
    rawGroupPolicy === "allowlist" || rawGroupPolicy === "open" || rawGroupPolicy === "disabled"
      ? rawGroupPolicy
      : "disabled";
  if (rawGroupPolicy !== undefined && rawGroupPolicy !== groupPolicy)
    warnings.push(
      `gateway: invalid security.groupPolicy "${String(rawGroupPolicy)}", using disabled`,
    );
  const pairing = {
    ttlMs: positiveNumber(
      merged.security?.pairing?.ttlMs,
      DEFAULTS.pairingTtlMs,
      "security.pairing.ttlMs",
      warnings,
    ),
    maxPending: positiveNumber(
      merged.security?.pairing?.maxPending,
      DEFAULTS.pairingMaxPending,
      "security.pairing.maxPending",
      warnings,
    ),
  };
  if (dmPolicy === "pairing" && adminAllowlist.size === 0) {
    warnings.push(
      "gateway: security.dmPolicy=pairing requires security.adminAllowlist to approve requests",
    );
  }
  const rawGroups = merged.telegram?.groups;
  const mentionPatterns: RegExp[] = [];
  for (const pattern of rawGroups?.mentionPatterns ?? []) {
    try {
      mentionPatterns.push(new RegExp(pattern, "i"));
    } catch {
      warnings.push(
        `gateway: invalid telegram.groups.mentionPatterns entry "${pattern}", skipping`,
      );
    }
  }
  const channels = validateChannels(merged.channels, warnings);

  if (channels.length === 0) {
    warnings.push("gateway: no channels configured — the gateway will have no inbound sources");
  }

  return {
    queue: { mode: queueMode, byChannel },
    stream: { editIntervalMs },
    session: { idleTimeoutMs, maxConcurrent },
    security: { allowlist, adminAllowlist, dmPolicy, groupPolicy, pairing },
    telegram: {
      groups: {
        allowlist: new Set(rawGroups?.allowlist ?? []),
        requireMention: rawGroups?.requireMention !== false,
        mentionPatterns,
        ignoredThreadIds: new Set(rawGroups?.ignoredThreadIds ?? []),
        senderAllowlist: new Set(rawGroups?.senderAllowlist ?? []),
      },
    },
    channels,
  };
}

function positiveNumber(
  value: unknown,
  fallback: number,
  label: string,
  warnings: string[],
): number {
  if (value === undefined) return fallback;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  warnings.push(`gateway: invalid ${label}, using ${fallback}`);
  return fallback;
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

export interface LoadGatewayConfigOptions {
  /** Explicit path (CLI `--config`). When set, only this file is loaded. */
  filePath?: string;
  /** Working directory for the project layer. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Whether the project layer is trusted (trust gate). Defaults to `true`. */
  trusted?: boolean;
}

/**
 * Load `gateway.json` with two-layer merging and `${ENV}` expansion.
 *
 * Resolution order:
 * 1. `--config <path>` — single file, no layering.
 * 2. `~/.novi/gateway.json` (user global) + `<cwd>/.novi/gateway.json`
 *    (project, only when `trusted`). Project overrides global.
 *
 * Parse failures degrade to a warning and an empty layer — startup is never
 * blocked (design.md §5.2). Env expansion happens after merge so `${TOKEN}`
 * in the project layer is expanded like any other string.
 */
export async function loadGatewayConfig(
  env: ExecutionEnv,
  options: LoadGatewayConfigOptions = {},
): Promise<GatewayConfigLoadResult> {
  const cwd = options.cwd ?? process.cwd();
  const trusted = options.trusted !== false;
  const warnings: string[] = [];

  let merged: RawGatewayConfig = {};

  if (options.filePath) {
    const layer = await readLayer(env, options.filePath, "config", warnings);
    if (layer) merged = layer;
  } else {
    const global = await readLayer(
      env,
      path.join(getNoviDir(), "gateway.json"),
      "global",
      warnings,
    );
    const project =
      trusted === false
        ? null
        : await readLayer(env, path.join(cwd, ".novi", "gateway.json"), "project", warnings);
    if (global && project) {
      merged = mergeLayers(global, project);
    } else {
      merged = global ?? project ?? {};
    }
  }

  // Expand ${ENV} after merge so project-layer tokens are resolved too.
  const expanded = expandEnvValues(merged);
  const config = resolveConfig(expanded, warnings);
  return { config, warnings };
}
