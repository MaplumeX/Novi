/** Stable JSON encoding shared by MCP catalog identities and structured results. */
export function canonicalStringify(value: unknown): string {
  return JSON.stringify(toCanonicalValue(value));
}

function toCanonicalValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("MCP JSON contains a non-finite number");
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => toCanonicalValue(item));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort(compareText)) {
      const nested = (value as Record<string, unknown>)[key];
      if (nested !== undefined) out[key] = toCanonicalValue(nested);
    }
    return out;
  }
  throw new Error(`MCP JSON contains unsupported ${typeof value}`);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
