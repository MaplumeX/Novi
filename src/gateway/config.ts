import path from "node:path";
import type { ExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { getNoviDir } from "../config.js";
import type { ChannelType } from "./core/types.js";
import type { GatewaySessionLocator } from "./core/types.js";
import { DEFAULT_DELIVERY_RATE_LIMITS, type DeliveryRateLimits } from "./messages/rate-limit.js";

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

/** Feishu (Lark) channel entry in `gateway.json`. */
export interface FeishuChannelConfig {
  type: "feishu";
  /** Stable instance id used in session keys (`<id>:<chatId>`). */
  id: string;
  /** Feishu App ID. Supports `${ENV_VAR}` expansion. */
  appId: string;
  /** Feishu App Secret. Supports `${ENV_VAR}` expansion. */
  appSecret: string;
  /** Feishu domain: "feishu" (default, domestic) or "lark" (overseas). */
  domain?: "feishu" | "lark";
}

/** Discriminated union of all channel config shapes. */
export type ChannelConfig = TelegramChannelConfig | FeishuChannelConfig;

/** Queue delivery mode for messages arriving mid-turn. */
export type QueueMode = "steer" | "followup" | "interrupt";
export type DmPolicy = "pairing" | "allowlist" | "open" | "disabled";
export type GroupPolicy = "allowlist" | "open" | "disabled";

export interface RawAutomationConfig {
  timezone?: string;
  allowedTools?: string[];
  minCronIntervalMs?: number;
  runTimeoutMs?: number;
  maxExecutionRetries?: number;
  maxDeliveryRetries?: number;
  maxConcurrentLlmRuns?: number;
  dailyTokenLimit?: number;
  dailyCostUsd?: number;
  retentionDays?: number;
  maxRunsPerJob?: number;
  maxResultBytes?: number;
}

export interface RawHeartbeatConfig {
  enabled?: boolean;
  everyMs?: number;
  model?: string;
  activeHours?: { start?: string; end?: string; timezone?: string };
  target?: GatewaySessionLocator;
}

export interface RawDeliveryConfig {
  rateLimit?: Partial<DeliveryRateLimits>;
}

export interface RawOperationsConfig {
  alertTarget?: GatewaySessionLocator;
  alertCooldownMs?: number;
  backlogRecords?: number;
  backlogAgeMs?: number;
  channelDownMs?: number;
}

/** Raw `gateway.json` shape — all fields optional, validated before use. */
export interface RawGatewayConfig {
  /** Persistent schema marker; omitted only by legacy v0 files. */
  version?: 1;
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
  delivery?: RawDeliveryConfig;
  automation?: RawAutomationConfig;
  heartbeat?: RawHeartbeatConfig;
  operations?: RawOperationsConfig;
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
  delivery: {
    rateLimit: DeliveryRateLimits;
  };
  automation: {
    timezone: string;
    allowedTools: string[];
    minCronIntervalMs: number;
    runTimeoutMs: number;
    maxExecutionRetries: number;
    maxDeliveryRetries: number;
    maxConcurrentLlmRuns: number;
    dailyTokenLimit: number;
    dailyCostUsd: number;
    retentionDays: number;
    maxRunsPerJob: number;
    maxResultBytes: number;
  };
  heartbeat: {
    enabled: boolean;
    everyMs: number;
    model?: string;
    activeHours?: { start: string; end: string; timezone: string };
    target?: GatewaySessionLocator;
  };
  operations: {
    alertTarget?: GatewaySessionLocator;
    alertCooldownMs: number;
    backlogRecords: number;
    backlogAgeMs: number;
    channelDownMs: number;
  };
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
  automationTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  allowedTools: ["read_file", "ls", "glob", "grep", "web_search", "fetch_content"],
  minCronIntervalMs: 300_000,
  runTimeoutMs: 120_000,
  maxExecutionRetries: 1,
  maxDeliveryRetries: 3,
  maxConcurrentLlmRuns: 2,
  dailyTokenLimit: 200_000,
  dailyCostUsd: 1,
  retentionDays: 30,
  maxRunsPerJob: 100,
  maxResultBytes: 65_536,
  heartbeatEveryMs: 1_800_000,
  alertCooldownMs: 3_600_000,
  alertBacklogRecords: 100,
  alertBacklogAgeMs: 900_000,
  alertChannelDownMs: 300_000,
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

/** Project automation policy may only reduce unattended authority/cost. */
function mergeTrustedLayers(
  global: RawGatewayConfig,
  project: RawGatewayConfig,
  warnings: string[],
): RawGatewayConfig {
  const merged = mergeLayers(global, project);
  const globalAutomation = global.automation ?? {};
  const projectAutomation = project.automation ?? {};
  const globalAllowed = globalAutomation.allowedTools ?? [...DEFAULTS.allowedTools];
  const projectAllowed = projectAutomation.allowedTools;
  const tightenLower = (key: keyof RawAutomationConfig, fallback: number): number => {
    const base = typeof globalAutomation[key] === "number" ? globalAutomation[key] : fallback;
    const candidate = projectAutomation[key];
    return typeof candidate === "number" ? Math.min(base, candidate) : base;
  };
  merged.automation = {
    ...globalAutomation,
    timezone: globalAutomation.timezone,
    allowedTools: projectAllowed
      ? globalAllowed.filter((tool) => projectAllowed.includes(tool))
      : globalAllowed,
    minCronIntervalMs: Math.max(
      typeof globalAutomation.minCronIntervalMs === "number"
        ? globalAutomation.minCronIntervalMs
        : DEFAULTS.minCronIntervalMs,
      typeof projectAutomation.minCronIntervalMs === "number"
        ? projectAutomation.minCronIntervalMs
        : 0,
    ),
    runTimeoutMs: tightenLower("runTimeoutMs", DEFAULTS.runTimeoutMs),
    maxExecutionRetries: tightenLower("maxExecutionRetries", DEFAULTS.maxExecutionRetries),
    maxDeliveryRetries: tightenLower("maxDeliveryRetries", DEFAULTS.maxDeliveryRetries),
    maxConcurrentLlmRuns: tightenLower("maxConcurrentLlmRuns", DEFAULTS.maxConcurrentLlmRuns),
    dailyTokenLimit: tightenLower("dailyTokenLimit", DEFAULTS.dailyTokenLimit),
    dailyCostUsd: tightenLower("dailyCostUsd", DEFAULTS.dailyCostUsd),
    retentionDays: tightenLower("retentionDays", DEFAULTS.retentionDays),
    maxRunsPerJob: tightenLower("maxRunsPerJob", DEFAULTS.maxRunsPerJob),
    maxResultBytes: tightenLower("maxResultBytes", DEFAULTS.maxResultBytes),
  };
  if (projectAutomation.timezone !== undefined) {
    warnings.push("gateway: project automation.timezone ignored (project policy is tighten-only)");
  }

  if (global.heartbeat) {
    merged.heartbeat = {
      ...global.heartbeat,
      enabled: global.heartbeat.enabled === true && project.heartbeat?.enabled !== false,
    };
    const changed =
      project.heartbeat && Object.keys(project.heartbeat).some((key) => key !== "enabled");
    if (changed)
      warnings.push("gateway: project heartbeat fields other than enabled=false are ignored");
  } else {
    merged.heartbeat = undefined;
    if (project.heartbeat?.enabled === true) {
      warnings.push("gateway: project heartbeat cannot enable unattended execution");
    }
  }
  merged.operations = global.operations;
  if (project.operations !== undefined) {
    warnings.push("gateway: project operations config ignored (global-only authority)");
  }
  return merged;
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
    } else if (type === "feishu") {
      const id = entry.id;
      const appId = entry.appId;
      const appSecret = entry.appSecret;
      if (typeof id !== "string" || !id) {
        warnings.push(`gateway: channels[${i}] ("feishu") missing "id", skipping`);
        continue;
      }
      if (typeof appId !== "string" || !appId) {
        warnings.push(`gateway: channels[${i}] ("feishu") missing "appId", skipping`);
        continue;
      }
      if (typeof appSecret !== "string" || !appSecret) {
        warnings.push(`gateway: channels[${i}] ("feishu") missing "appSecret", skipping`);
        continue;
      }
      valid.push({
        type: "feishu",
        id,
        appId,
        appSecret,
        ...(entry.domain === "feishu" || entry.domain === "lark"
          ? { domain: entry.domain }
          : {}),
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
  const automation = resolveAutomationConfig(merged.automation, warnings);
  const delivery = resolveDeliveryConfig(merged.delivery, warnings);
  const heartbeat = resolveHeartbeatConfig(merged.heartbeat, automation.timezone, warnings);
  const operations = resolveOperationsConfig(merged.operations, warnings);

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
    delivery,
    automation,
    heartbeat,
    operations,
  };
}

function resolveDeliveryConfig(
  raw: RawDeliveryConfig | undefined,
  warnings: string[],
): ResolvedGatewayConfig["delivery"] {
  const rateLimit = { ...DEFAULT_DELIVERY_RATE_LIMITS };
  for (const field of ["accountPerSecond", "directPerSecond", "groupPerMinute"] as const) {
    const value = raw?.rateLimit?.[field];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      warnings.push(`gateway: invalid delivery.rateLimit.${field}, using default`);
      continue;
    }
    if (value > DEFAULT_DELIVERY_RATE_LIMITS[field]) {
      warnings.push(`gateway: delivery.rateLimit.${field} may only tighten the default`);
      continue;
    }
    rateLimit[field] = value;
  }
  return { rateLimit };
}

function resolveAutomationConfig(
  raw: RawAutomationConfig | undefined,
  warnings: string[],
): ResolvedGatewayConfig["automation"] {
  const timezone = validTimezone(
    raw?.timezone,
    DEFAULTS.automationTimezone,
    "automation.timezone",
    warnings,
  );
  const allowedTools = Array.isArray(raw?.allowedTools)
    ? [
        ...new Set(
          raw.allowedTools.filter(
            (value): value is string => typeof value === "string" && value.length > 0,
          ),
        ),
      ]
    : [...DEFAULTS.allowedTools];
  return {
    timezone,
    allowedTools,
    minCronIntervalMs: positiveNumber(
      raw?.minCronIntervalMs,
      DEFAULTS.minCronIntervalMs,
      "automation.minCronIntervalMs",
      warnings,
    ),
    runTimeoutMs: positiveNumber(
      raw?.runTimeoutMs,
      DEFAULTS.runTimeoutMs,
      "automation.runTimeoutMs",
      warnings,
    ),
    maxExecutionRetries: nonNegativeInteger(
      raw?.maxExecutionRetries,
      DEFAULTS.maxExecutionRetries,
      "automation.maxExecutionRetries",
      warnings,
    ),
    maxDeliveryRetries: nonNegativeInteger(
      raw?.maxDeliveryRetries,
      DEFAULTS.maxDeliveryRetries,
      "automation.maxDeliveryRetries",
      warnings,
    ),
    maxConcurrentLlmRuns: positiveInteger(
      raw?.maxConcurrentLlmRuns,
      DEFAULTS.maxConcurrentLlmRuns,
      "automation.maxConcurrentLlmRuns",
      warnings,
    ),
    dailyTokenLimit: positiveInteger(
      raw?.dailyTokenLimit,
      DEFAULTS.dailyTokenLimit,
      "automation.dailyTokenLimit",
      warnings,
    ),
    dailyCostUsd: positiveNumber(
      raw?.dailyCostUsd,
      DEFAULTS.dailyCostUsd,
      "automation.dailyCostUsd",
      warnings,
    ),
    retentionDays: positiveInteger(
      raw?.retentionDays,
      DEFAULTS.retentionDays,
      "automation.retentionDays",
      warnings,
    ),
    maxRunsPerJob: positiveInteger(
      raw?.maxRunsPerJob,
      DEFAULTS.maxRunsPerJob,
      "automation.maxRunsPerJob",
      warnings,
    ),
    maxResultBytes: positiveInteger(
      raw?.maxResultBytes,
      DEFAULTS.maxResultBytes,
      "automation.maxResultBytes",
      warnings,
    ),
  };
}

function resolveHeartbeatConfig(
  raw: RawHeartbeatConfig | undefined,
  defaultTimezone: string,
  warnings: string[],
): ResolvedGatewayConfig["heartbeat"] {
  const enabled = raw?.enabled === true;
  const everyMs = positiveNumber(
    raw?.everyMs,
    DEFAULTS.heartbeatEveryMs,
    "heartbeat.everyMs",
    warnings,
  );
  const model =
    typeof raw?.model === "string" && /^[^/\s]+\/[^/\s]+$/.test(raw.model) ? raw.model : undefined;
  if (raw?.model !== undefined && !model)
    warnings.push("gateway: invalid heartbeat.model, expected provider/model");
  const target = decodeTarget(raw?.target, "heartbeat.target", warnings);
  let activeHours: ResolvedGatewayConfig["heartbeat"]["activeHours"];
  if (raw?.activeHours !== undefined) {
    const { start, end } = raw.activeHours;
    if (isClockTime(start) && isClockTime(end) && start !== end) {
      activeHours = {
        start,
        end,
        timezone: validTimezone(
          raw.activeHours.timezone,
          defaultTimezone,
          "heartbeat.activeHours.timezone",
          warnings,
        ),
      };
    } else {
      warnings.push("gateway: invalid heartbeat.activeHours, expected distinct HH:MM start/end");
    }
  }
  if (enabled && !model) warnings.push("gateway: heartbeat.enabled requires heartbeat.model");
  if (enabled && !target) warnings.push("gateway: heartbeat.enabled requires heartbeat.target");
  return {
    enabled: enabled && model !== undefined && target !== undefined,
    everyMs,
    model,
    activeHours,
    target,
  };
}

function resolveOperationsConfig(
  raw: RawOperationsConfig | undefined,
  warnings: string[],
): ResolvedGatewayConfig["operations"] {
  return {
    alertTarget: decodeTarget(raw?.alertTarget, "operations.alertTarget", warnings),
    alertCooldownMs: positiveNumber(
      raw?.alertCooldownMs,
      DEFAULTS.alertCooldownMs,
      "operations.alertCooldownMs",
      warnings,
    ),
    backlogRecords: positiveInteger(
      raw?.backlogRecords,
      DEFAULTS.alertBacklogRecords,
      "operations.backlogRecords",
      warnings,
    ),
    backlogAgeMs: positiveNumber(
      raw?.backlogAgeMs,
      DEFAULTS.alertBacklogAgeMs,
      "operations.backlogAgeMs",
      warnings,
    ),
    channelDownMs: positiveNumber(
      raw?.channelDownMs,
      DEFAULTS.alertChannelDownMs,
      "operations.channelDownMs",
      warnings,
    ),
  };
}

function decodeTarget(
  value: GatewaySessionLocator | undefined,
  field: string,
  warnings: string[],
): GatewaySessionLocator | undefined {
  if (value === undefined) return undefined;
  if (
    value.channel !== "telegram" ||
    typeof value.account !== "string" ||
    value.account.length === 0 ||
    !value.chat ||
    typeof value.chat.id !== "string" ||
    value.chat.id.length === 0 ||
    !["direct", "group", "channel", "thread"].includes(value.chat.type) ||
    (value.thread !== undefined && (typeof value.thread !== "string" || value.thread.length === 0))
  ) {
    warnings.push(`gateway: invalid ${field}`);
    return undefined;
  }
  return {
    channel: value.channel,
    account: value.account,
    chat: { ...value.chat },
    ...(value.thread !== undefined ? { thread: value.thread } : {}),
  };
}

function isClockTime(value: unknown): value is string {
  return typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function validTimezone(
  value: unknown,
  fallback: string,
  label: string,
  warnings: string[],
): string {
  if (value === undefined) return fallback;
  if (typeof value === "string") {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
      return value;
    } catch {
      // handled below
    }
  }
  warnings.push(`gateway: invalid ${label}, using ${fallback}`);
  return fallback;
}

function positiveInteger(
  value: unknown,
  fallback: number,
  label: string,
  warnings: string[],
): number {
  if (value === undefined) return fallback;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  warnings.push(`gateway: invalid ${label}, using ${fallback}`);
  return fallback;
}

function nonNegativeInteger(
  value: unknown,
  fallback: number,
  label: string,
  warnings: string[],
): number {
  if (value === undefined) return fallback;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  warnings.push(`gateway: invalid ${label}, using ${fallback}`);
  return fallback;
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
      merged = mergeTrustedLayers(global, project, warnings);
    } else {
      merged = global ?? project ?? {};
    }
  }

  // Expand ${ENV} after merge so project-layer tokens are resolved too.
  const expanded = expandEnvValues(merged);
  const config = resolveConfig(expanded, warnings);
  return { config, warnings };
}
