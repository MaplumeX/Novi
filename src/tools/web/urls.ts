import { isIP } from "node:net";
import { WebToolError } from "./errors.js";

const BLOCKED_HOSTS = new Set(["localhost", "localhost.localdomain", "metadata.google.internal"]);

function ipv4Number(address: string): number | null {
  const parts = address.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return null;
  }
  return (((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3]) >>> 0;
}

function inV4Cidr(value: number, base: string, bits: number): boolean {
  const start = ipv4Number(base);
  if (start === null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (value & mask) === (start & mask);
}

/** True only for globally routable public addresses suitable for tool egress. */
export function isPublicIp(address: string): boolean {
  const normalized = address
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .split("%")[0];
  const family = isIP(normalized);
  if (family === 4) {
    const value = ipv4Number(normalized);
    if (value === null) return false;
    return ![
      ["0.0.0.0", 8],
      ["10.0.0.0", 8],
      ["100.64.0.0", 10],
      ["127.0.0.0", 8],
      ["169.254.0.0", 16],
      ["172.16.0.0", 12],
      ["192.0.0.0", 24],
      ["192.0.2.0", 24],
      ["192.168.0.0", 16],
      ["198.18.0.0", 15],
      ["198.51.100.0", 24],
      ["203.0.113.0", 24],
      ["224.0.0.0", 4],
      ["240.0.0.0", 4],
    ].some(([base, bits]) => inV4Cidr(value, base as string, bits as number));
  }
  if (family === 6) {
    if (normalized === "::" || normalized === "::1") return false;
    if (
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fec") ||
      normalized.startsWith("fed") ||
      normalized.startsWith("fee") ||
      normalized.startsWith("fef")
    )
      return false;
    if (/^fe[89ab]/.test(normalized)) return false;
    if (normalized.startsWith("ff")) return false;
    const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPublicIp(mapped[1]);
    return (
      !normalized.startsWith("2001:db8:") &&
      !normalized.startsWith("2001:2:") &&
      !normalized.startsWith("2001:10:")
    );
  }
  return false;
}

export function parsePublicUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new WebToolError("INVALID_URL", `Invalid URL: ${input}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new WebToolError("INVALID_URL", `URL must use http or https: ${input}`);
  }
  if (url.username || url.password) {
    throw new WebToolError("INVALID_URL", "URLs containing credentials are not allowed");
  }
  const hostname = url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (
    BLOCKED_HOSTS.has(hostname) ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    (isIP(hostname) !== 0 && !isPublicIp(hostname))
  ) {
    throw new WebToolError(
      "PRIVATE_ADDRESS",
      `URL targets a private or non-public address: ${hostname}`,
    );
  }
  url.hash = "";
  return url;
}

export function canonicalUrl(input: string): string {
  const url = parsePublicUrl(input);
  url.hostname = url.hostname.toLowerCase();
  if (
    (url.protocol === "http:" && url.port === "80") ||
    (url.protocol === "https:" && url.port === "443")
  ) {
    url.port = "";
  }
  return url.toString();
}
