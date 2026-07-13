/** Accept only absolute HTTP(S) result URLs emitted by untrusted provider payloads. */
export function normalizeResultUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

export function resultSource(value: string): string | null {
  try {
    return new URL(value).hostname;
  } catch {
    return null;
  }
}
