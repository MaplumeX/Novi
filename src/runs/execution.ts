/** Bound text without splitting a UTF-8 code point. */
export function boundUtf8Text(
  value: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("maxBytes must be non-negative");
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return { text: value, truncated: false };
  let text = "";
  let bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > maxBytes) break;
    text += character;
    bytes += size;
  }
  return { text, truncated: true };
}

export function isTerminalRunStatus(status: string): boolean {
  return ["succeeded", "failed", "interrupted", "cancelled"].includes(status);
}

export function extractTextContent(content: string | readonly unknown[]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part): part is { type: "text"; text: string } =>
        typeof part === "object" &&
        part !== null &&
        (part as { type?: unknown }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string",
    )
    .map((part) => part.text)
    .join("");
}
