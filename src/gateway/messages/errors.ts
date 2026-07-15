import type { MessageError } from "./types.js";

const NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
]);

/** Map arbitrary channel/SDK failures into stable, redacted persistence fields. */
export function classifyChannelError(error: unknown): MessageError {
  const numericCode = readNumericCode(error);
  const stringCode = readStringCode(error);
  const retryAfterMs = readRetryAfterMs(error);
  if (numericCode === 429 || retryAfterMs !== undefined) {
    return {
      code: "RATE_LIMITED",
      message: "channel rate limit exceeded",
      retryable: true,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    };
  }
  if (numericCode !== undefined && numericCode >= 500) {
    return {
      code: "REMOTE_UNAVAILABLE",
      message: "channel service is unavailable",
      retryable: true,
    };
  }
  if (stringCode !== undefined && NETWORK_CODES.has(stringCode)) {
    return { code: "NETWORK_ERROR", message: "channel network request failed", retryable: true };
  }
  if (numericCode === 401) {
    return {
      code: "AUTHENTICATION_FAILED",
      message: "channel authentication failed",
      retryable: false,
    };
  }
  if (numericCode === 403) {
    return { code: "CHANNEL_FORBIDDEN", message: "channel rejected delivery", retryable: false };
  }
  if (numericCode === 404 || (numericCode === 400 && describesInvalidTarget(error))) {
    return { code: "INVALID_TARGET", message: "delivery target is invalid", retryable: false };
  }
  if (numericCode === 400) {
    return { code: "INVALID_REQUEST", message: "channel rejected the message", retryable: false };
  }
  return {
    code: "CHANNEL_SEND_FAILED",
    message: "channel delivery failed",
    retryable: true,
  };
}

/** Redact credential-shaped values and return a bounded single-line diagnostic. */
export function redactAndBoundError(error: unknown, maxCharacters = 500): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/(authorization:\s*bearer\s+)[^\s]+/gi, "$1[redacted]")
    .replace(/((?:api[_-]?key|token|secret)\s*[:=]\s*)[^\s]+/gi, "$1[redacted]")
    .replace(/https:\/\/api\.telegram\.org\/bot[^/\s]+/gi, "https://api.telegram.org/bot[redacted]")
    .replace(/\s+/g, " ")
    .slice(0, Math.max(0, maxCharacters));
}

function readNumericCode(error: unknown): number | undefined {
  const value = (error as { code?: unknown } | null)?.code;
  if (typeof value === "number") return value;
  const responseCode = (error as { response?: { error_code?: unknown } } | null)?.response
    ?.error_code;
  return typeof responseCode === "number" ? responseCode : undefined;
}

function readStringCode(error: unknown): string | undefined {
  const value = (error as { code?: unknown } | null)?.code;
  return typeof value === "string" ? value : undefined;
}

function readRetryAfterMs(error: unknown): number | undefined {
  const seconds = (error as { parameters?: { retry_after?: unknown } } | null)?.parameters
    ?.retry_after;
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0
    ? Math.ceil(seconds * 1_000)
    : undefined;
}

function describesInvalidTarget(error: unknown): boolean {
  const description = (error as { description?: unknown } | null)?.description;
  if (typeof description !== "string") return false;
  return /chat not found|message thread not found|invalid (?:chat|peer)|user not found/i.test(
    description,
  );
}
