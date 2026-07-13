import { WebToolError } from "../errors.js";

export type MediaType = "html" | "text" | "json" | "pdf";

export function classifyMedia(contentType: string, bytes: Uint8Array): MediaType {
  const type = contentType.split(";", 1)[0].trim().toLowerCase();
  const prefix = Buffer.from(bytes.subarray(0, 16)).toString("ascii").trimStart().toLowerCase();
  if (prefix.startsWith("%pdf-") || type === "application/pdf") return "pdf";
  if (
    type === "text/html" ||
    type === "application/xhtml+xml" ||
    prefix.startsWith("<!doctype html") ||
    prefix.startsWith("<html")
  )
    return "html";
  if (type === "application/json" || type.endsWith("+json")) return "json";
  if (
    type.startsWith("text/") ||
    type === "application/xml" ||
    type.endsWith("+xml") ||
    type === ""
  )
    return "text";
  throw new WebToolError("UNSUPPORTED_MEDIA_TYPE", `Unsupported media type: ${type || "unknown"}`);
}

export function charsetFromContentType(contentType: string): string {
  return /charset\s*=\s*["']?([^;"'\s]+)/i.exec(contentType)?.[1]?.toLowerCase() ?? "utf-8";
}
