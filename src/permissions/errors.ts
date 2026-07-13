import type { PermissionErrorCode } from "./types.js";

const PREFIX = "NOVI_ERROR:";
const MAX_MESSAGE_LENGTH = 500;

/** Encode a stable denial through pi-agent-core's public hook reason channel. */
export function encodePermissionError(code: PermissionErrorCode, message: string): string {
  const safe = message.replace(/[\r\n]+/g, " ").slice(0, MAX_MESSAGE_LENGTH);
  return `${PREFIX}${code}:${safe}`;
}

/** Decode persisted/live hook denials without depending on core internals. */
export function decodePermissionError(
  reason: unknown,
): { code: PermissionErrorCode; message: string } | undefined {
  if (typeof reason !== "string" || !reason.startsWith(PREFIX)) return undefined;
  const separator = reason.indexOf(":", PREFIX.length);
  if (separator < 0) return undefined;
  const code = reason.slice(PREFIX.length, separator);
  if (!isPermissionErrorCode(code)) return undefined;
  return { code, message: reason.slice(separator + 1) };
}

/** Find a denial embedded in a core tool result/content projection. */
export function findPermissionError(
  value: unknown,
): { code: PermissionErrorCode; message: string } | undefined {
  const direct = decodePermissionError(value);
  if (direct) return direct;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findPermissionError(item);
      if (found) return found;
    }
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["text", "reason", "message", "content"]) {
    const found = findPermissionError(record[key]);
    if (found) return found;
  }
  return undefined;
}

function isPermissionErrorCode(value: string): value is PermissionErrorCode {
  return (
    value === "PERMISSION_DENIED" ||
    value === "PERMISSION_INTERACTION_REQUIRED" ||
    value === "WORKSPACE_EXTERNAL_WRITE_DENIED" ||
    value === "TOOL_DISABLED" ||
    value === "PERMISSION_INTENT_INVALID"
  );
}
