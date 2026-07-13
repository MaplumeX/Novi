import { WebToolError } from "../errors.js";

export function decodeText(bytes: Uint8Array, charset = "utf-8"): string {
  try {
    return new TextDecoder(charset, { fatal: false })
      .decode(bytes)
      .replace(/\r\n?/g, "\n")
      .split("\0")
      .join("");
  } catch {
    try {
      return new TextDecoder("utf-8", { fatal: false })
        .decode(bytes)
        .replace(/\r\n?/g, "\n")
        .split("\0")
        .join("");
    } catch {
      throw new WebToolError("EXTRACTION_FAILED", `Unable to decode text with charset ${charset}`);
    }
  }
}

export function normalizeText(value: string): string {
  return value
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}
