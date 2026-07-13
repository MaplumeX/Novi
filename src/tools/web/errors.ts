import type { WebErrorCode, WebItemError } from "./types.js";

/** Internal coded error converted to a safe per-item public error at tool boundaries. */
export class WebToolError extends Error {
  constructor(
    readonly code: WebErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "WebToolError";
  }
}

export function toWebItemError(error: unknown, fallback: WebErrorCode): WebItemError {
  if (error instanceof WebToolError) {
    return { code: error.code, message: error.message, retryable: error.retryable };
  }
  return {
    code: fallback,
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
  };
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
}
