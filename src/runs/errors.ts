const DEFAULT_ERROR_BYTES = 2 * 1024;

export interface BoundedError {
  code: string;
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
}

export interface BoundedErrorOptions {
  code?: string;
  retryable?: boolean;
  retryAfterMs?: number;
  maxBytes?: number;
}

/** Convert an unknown failure into a single-line, size-bounded persisted error. */
export function toBoundedError(error: unknown, options: BoundedErrorOptions = {}): BoundedError {
  const raw = error instanceof Error ? error.message : String(error);
  const message = boundUtf8(
    redactSecrets(raw.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim() || "unknown error"),
    options.maxBytes ?? DEFAULT_ERROR_BYTES,
  );
  return {
    code: stableCode(options.code ?? errorCode(error)),
    message,
    retryable: options.retryable ?? false,
    ...(options.retryAfterMs !== undefined ? { retryAfterMs: options.retryAfterMs } : {}),
  };
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return "UNKNOWN";
}

function stableCode(value: string): string {
  const normalized = value.toUpperCase().replace(/[^A-Z0-9_]/g, "_").slice(0, 64);
  return normalized || "UNKNOWN";
}

function redactSecrets(value: string): string {
  return value
    .replace(/\b(authorization\s*:\s*bearer\s+)\S+/gi, "$1[redacted]")
    .replace(/\b(?:sk|xox[baprs]|gh[pousr])[-_A-Za-z0-9]{8,}\b/gi, "[redacted]")
    .replace(
      /\b((?:api[_-]?key|token|password|cookie)\s*[:=]\s*)\S+/gi,
      "$1[redacted]",
    );
}

function boundUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const suffix = "…";
  const budget = Math.max(0, maxBytes - Buffer.byteLength(suffix, "utf8"));
  let prefix = "";
  let bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > budget) break;
    prefix += character;
    bytes += size;
  }
  return `${prefix}${suffix}`;
}
