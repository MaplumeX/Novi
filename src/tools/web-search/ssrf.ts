/**
 * SSRF guard: reject private / internal / loopback network addresses.
 *
 * Only does **literal** hostname inspection — no DNS lookup. This prevents the
 * model from being induced to `fetch_content` an internal URL, but does not
 * defend against DNS rebinding. Novi is a local tool where `bash` can already
 * curl internal addresses; the main risk we block is exfiltrating internal
 * content to a third-party search endpoint.
 */

/**
 * Returns `true` when `url` targets a private/internal/loopback address and
 * should be rejected. The protocol check (http/https) is **not** done here —
 * the caller validates the scheme before calling.
 */
export function isPrivateUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false; // malformed URL is not "private"; caller should reject it for other reasons
  }

  const host = parsed.hostname.toLowerCase();

  // localhost variants
  if (host === "localhost" || host.endsWith(".localhost")) return true;

  // IPv6: URL.hostname retains surrounding brackets in Node (e.g. "[::1]").
  const bareHost = host.replace(/^\[|\]$/g, "");

  // Bracketed / bare IPv6
  if (bareHost.includes(":")) {
    return isPrivateIPv6(bareHost);
  }

  // Bare IPv4
  if (/^\d+\.\d+\.\d+\.\d+$/.test(bareHost)) {
    return isPrivateIPv4(bareHost);
  }

  return false;
}

function isPrivateIPv4(host: string): boolean {
  const parts = host.split(".").map((s) => parseInt(s, 10));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return false;
  }
  const [a, b] = parts;

  // 0.x (current network / "this host") — treat as private.
  if (a === 0) return true;
  // 10.x (private class A)
  if (a === 10) return true;
  // 127.x (loopback)
  if (a === 127) return true;
  // 169.254.x (link-local)
  if (a === 169 && b === 254) return true;
  // 172.16-31.x (private class B)
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.x (private class C)
  if (a === 192 && b === 168) return true;

  return false;
}

function isPrivateIPv6(host: string): boolean {
  // Normalize: strip leading/trailing colons but keep the structural form.
  const h = host.toLowerCase();

  // ::1 (loopback), :: (unspecified / all-zeros)
  if (h === "::1" || h === "::") return true;

  // Unique local addresses fc00:: - fdff:... (fc / fd prefix byte).
  if (h.startsWith("fc") || h.startsWith("fd")) return true;

  return false;
}