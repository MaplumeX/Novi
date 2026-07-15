import type { request as undiciRequest } from "undici";
import { guardedRequest } from "../tools/web/network.js";
import type { AuditResponse, SearchResult } from "./types.js";

/** skills.sh marketplace search API endpoint. */
const SEARCH_API = "https://skills.sh/api/search";

/** skills.sh audit endpoint (add-skill). */
const AUDIT_API = "https://add-skill.vercel.sh/audit";

/** Default search limit. */
const SEARCH_LIMIT = 10;

/** Audit request timeout in ms. */
const AUDIT_TIMEOUT_MS = 3_000;

/** Search request timeout in ms. */
const SEARCH_TIMEOUT_MS = 10_000;

/**
 * Search the skills.sh marketplace for skills matching `query`.
 *
 * Returns an empty array on any failure (network, parse, non-200) — never throws.
 */
export async function searchSkills(
  query: string,
  opts: { owner?: string; request?: typeof undiciRequest } = {},
): Promise<SearchResult[]> {
  const url = new URL(SEARCH_API);
  url.searchParams.set("q", query);
  url.searchParams.set("limit", String(SEARCH_LIMIT));
  if (opts.owner) url.searchParams.set("owner", opts.owner);

  try {
    const response = await guardedRequest(url.toString(), {
      timeoutMs: SEARCH_TIMEOUT_MS,
      maxBytes: 2 * 1024 * 1024,
      headers: { accept: "application/json" },
      env: process.env,
      ...(opts.request ? { request: opts.request } : {}),
    });
    if (response.status !== 200) return [];
    const json = JSON.parse(Buffer.from(response.body).toString("utf8")) as unknown;
    return parseSearchResponse(json);
  } catch {
    return [];
  }
}

/**
 * Fetch audit (security scan) data from the skills.sh audit endpoint.
 *
 * Returns `null` on any failure (network, timeout, parse) — never throws.
 *
 * @param source — GitHub `owner/repo` identifier
 * @param slugs — skill slugs within the repo to audit
 */
export async function fetchAudit(
  source: string,
  slugs: string[],
  opts: { request?: typeof undiciRequest } = {},
): Promise<AuditResponse | null> {
  const url = new URL(AUDIT_API);
  url.searchParams.set("source", source);
  url.searchParams.set("skills", slugs.join(","));

  try {
    const response = await guardedRequest(url.toString(), {
      timeoutMs: AUDIT_TIMEOUT_MS,
      maxBytes: 2 * 1024 * 1024,
      headers: { accept: "application/json" },
      env: process.env,
      ...(opts.request ? { request: opts.request } : {}),
    });
    if (response.status !== 200) return null;
    const json = JSON.parse(Buffer.from(response.body).toString("utf8")) as unknown;
    return parseAuditResponse(json);
  } catch {
    return null;
  }
}

/**
 * Validate and normalise a search API response into {@link SearchResult}[].
 *
 * Expected shape: `{ skills: [{ id, name, source, installs }] }`.
 */
function parseSearchResponse(json: unknown): SearchResult[] {
  if (json === null || typeof json !== "object" || Array.isArray(json)) return [];
  const root = json as Record<string, unknown>;
  const skills = root.skills;
  if (!Array.isArray(skills)) return [];
  const results: SearchResult[] = [];
  for (const item of skills) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
    const obj = item as Record<string, unknown>;
    const id = obj.id;
    const name = obj.name;
    const source = obj.source;
    const installs = obj.installs;
    if (typeof id !== "string" || typeof name !== "string" || typeof source !== "string") continue;
    results.push({
      id,
      name,
      source,
      installs: typeof installs === "number" ? installs : 0,
    });
  }
  return results;
}

/**
 * Validate an audit API response.
 *
 * Expected shape: `Record<slug, Record<scanner, PartnerAudit>>`.
 */
function parseAuditResponse(json: unknown): AuditResponse | null {
  if (json === null || typeof json !== "object" || Array.isArray(json)) return null;
  return json as AuditResponse;
}
