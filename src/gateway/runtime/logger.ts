import { runtimeFailure, type RuntimeFailureSummary } from "./snapshot.js";

export type GatewayLogLevel = "debug" | "info" | "warn" | "error";
export type GatewayLogFields = Readonly<Record<string, unknown>>;

export interface GatewayLoggerOptions {
  instanceId: string;
  now?: () => Date;
  write?: (line: string) => void;
}

/** Gateway-only single-line JSON logger with recursive secret/body filtering. */
export class GatewayLogger {
  readonly #options: GatewayLoggerOptions;

  constructor(options: GatewayLoggerOptions) {
    this.#options = options;
  }

  debug(event: string, fields: GatewayLogFields = {}): void {
    this.log("debug", event, fields);
  }

  info(event: string, fields: GatewayLogFields = {}): void {
    this.log("info", event, fields);
  }

  warn(event: string, fields: GatewayLogFields = {}): void {
    this.log("warn", event, fields);
  }

  error(event: string, error: unknown, fields: GatewayLogFields = {}): void {
    this.log("error", event, { ...fields, error: runtimeFailure(error) });
  }

  log(level: GatewayLogLevel, event: string, fields: GatewayLogFields = {}): void {
    const record = {
      timestamp: (this.#options.now ?? (() => new Date()))().toISOString(),
      level,
      event: boundedString(event, 128),
      instanceId: this.#options.instanceId,
      ...sanitizeObject(fields),
    };
    (this.#options.write ?? ((line) => process.stderr.write(line)))(`${JSON.stringify(record)}\n`);
  }
}

export function gatewayErrorSummary(error: unknown, code?: string): RuntimeFailureSummary {
  return runtimeFailure(error, code);
}

function sanitizeObject(value: GatewayLogFields): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (forbiddenKey(key)) continue;
    const sanitized = sanitizeValue(item, 0);
    if (sanitized !== undefined) output[key] = sanitized;
  }
  return output;
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (depth > 4) return "[truncated]";
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "string") return boundedString(redact(value), 500);
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitizeValue(item, depth + 1));
  if (typeof value === "object") {
    if (value instanceof Error) return runtimeFailure(value);
    return sanitizeObjectAtDepth(value as Record<string, unknown>, depth + 1);
  }
  return undefined;
}

function sanitizeObjectAtDepth(
  value: Record<string, unknown>,
  depth: number,
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, 50)) {
    if (forbiddenKey(key)) continue;
    const sanitized = sanitizeValue(item, depth);
    if (sanitized !== undefined) output[key] = sanitized;
  }
  return output;
}

function forbiddenKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[_-]/g, "");
  return [
    "text",
    "body",
    "content",
    "prompt",
    "token",
    "bottoken",
    "apikey",
    "secret",
    "credential",
    "authorization",
    "pairingcode",
    "env",
    "environment",
    "rawerror",
    "response",
  ].includes(normalized);
}

function redact(value: string): string {
  return value
    .replace(/(authorization:\s*bearer\s+)[^\s]+/gi, "$1[redacted]")
    .replace(/((?:api[_-]?key|token|secret|pairing[_-]?code)\s*[:=]\s*)[^\s]+/gi, "$1[redacted]")
    .replace(/https:\/\/api\.telegram\.org\/bot[^/\s]+/gi, "https://api.telegram.org/bot[redacted]")
    .replace(/[\r\n]+/g, " ");
}

function boundedString(value: string, maximum: number): string {
  return value.slice(0, maximum);
}
