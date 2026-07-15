/** Default marker appended when durable Gateway text exceeds its byte budget. */
export const GATEWAY_TRUNCATION_MARKER = "\n[output truncated by Novi]";

/**
 * Bound a string by UTF-8 bytes without splitting a multi-byte code point.
 * The marker is itself bounded so callers may safely use very small budgets.
 */
export function truncateUtf8(
  text: string,
  maxBytes: number,
  marker = GATEWAY_TRUNCATION_MARKER,
): { text: string; truncated: boolean } {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new Error("maxBytes must be a non-negative safe integer");
  }
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return { text, truncated: false };

  const boundedMarker = utf8Head(marker, maxBytes);
  const markerBytes = Buffer.byteLength(boundedMarker, "utf8");
  return {
    text: utf8Head(text, maxBytes - markerBytes) + boundedMarker,
    truncated: true,
  };
}

/** Split text by UTF-16 code units without separating surrogate pairs. */
export function chunkText(text: string, limit: number): string[] {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error("chunk limit must be a positive safe integer");
  }
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + limit, text.length);
    if (end < text.length) {
      const code = text.charCodeAt(end);
      if (code >= 0xdc00 && code <= 0xdfff) end--;
    }
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks.length > 0 ? chunks : [""];
}

function utf8Head(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
}
