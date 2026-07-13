import { WebToolError } from "../errors.js";
import { decodeText, normalizeText } from "./text.js";

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, sortJson(entry)]),
    );
  }
  return value;
}

export function extractJson(bytes: Uint8Array, charset: string): string {
  try {
    return normalizeText(JSON.stringify(sortJson(JSON.parse(decodeText(bytes, charset))), null, 2));
  } catch (error) {
    if (error instanceof WebToolError) throw error;
    throw new WebToolError("EXTRACTION_FAILED", "Response declared JSON but could not be parsed");
  }
}
