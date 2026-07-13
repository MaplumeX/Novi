import path from "node:path";
import * as Type from "typebox";
import type { AgentTool, ExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { getNoviDir } from "../config.js";
import { textResult } from "./shared.js";
import { makeCacheKey, readCache, writeCache } from "./web/cache.js";
import { mapConcurrent } from "./web/concurrency.js";
import { toWebItemError } from "./web/errors.js";
import { resolveSearchProvider, validateCapabilities } from "./web/search-provider.js";
import type { SearchOutcome, SearchRequest, SearchResult, WebToolOptions } from "./web/types.js";

const Query = Type.Object(
  {
    query: Type.String({ minLength: 1 }),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
    include_domains: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 10 })),
    exclude_domains: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 10 })),
    date_after: Type.Optional(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" })),
    date_before: Type.Optional(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" })),
    language: Type.Optional(Type.String({ pattern: "^[A-Za-z]{2}$" })),
    country: Type.Optional(Type.String({ pattern: "^[A-Za-z]{2}$" })),
  },
  { additionalProperties: false },
);

const Parameters = Type.Object(
  {
    queries: Type.Array(Query, { minItems: 1, maxItems: 5 }),
    force_refresh: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export function createWebSearchTool(
  _env: ExecutionEnv,
  options: WebToolOptions = {},
): AgentTool<typeof Parameters> {
  const provider = resolveSearchProvider(options);
  const env = options.env ?? process.env;
  const cacheRoot = options.cacheRoot ?? path.join(getNoviDir(), "cache", "web");
  const ttlMs = clamp(options.webSearch?.cacheTtlMinutes, 1, 24 * 60, 15) * 60_000;
  const timeoutMs = clamp(options.webSearch?.timeoutSeconds, 1, 120, 15) * 1000;
  const concurrency = clamp(options.webSearch?.concurrency, 1, 5, 3);
  return {
    name: "web_search",
    label: "Web Search",
    description:
      "Search up to five web queries. Each query returns ordered source metadata or an explicit independent error.",
    parameters: Parameters,
    execute: async (_id, params, signal) => {
      const requests = validateQueries(params.queries);
      const outcomes = await mapConcurrent(
        requests,
        concurrency,
        async (request): Promise<SearchOutcome> => {
          const started = Date.now();
          const cache = params.force_refresh ? ("bypass" as const) : ("miss" as const);
          try {
            validateCapabilities(provider, request);
            const key = makeCacheKey("search", { provider: provider.id, request });
            if (!params.force_refresh) {
              const cached = await readCache<SearchResult[]>(cacheRoot, "search", key, ttlMs);
              if (cached && isSearchResults(cached))
                return {
                  ok: true,
                  query: request.query,
                  provider: provider.id,
                  results: cached,
                  cache: "hit",
                  durationMs: Date.now() - started,
                };
            }
            const results = await provider.search(request, { signal, timeoutMs, env });
            await writeCache(cacheRoot, "search", key, results);
            return {
              ok: true,
              query: request.query,
              provider: provider.id,
              results,
              cache,
              durationMs: Date.now() - started,
            };
          } catch (error) {
            if (signal?.aborted) throw error;
            return {
              ok: false,
              query: request.query,
              provider: provider.id,
              error: toWebItemError(error, "PROVIDER_ERROR"),
              cache,
              durationMs: Date.now() - started,
            };
          }
        },
        signal,
      );
      return textResult(render(outcomes), { provider: provider.id, outcomes });
    },
  };
}

function validateQueries(input: Array<Record<string, unknown>>): SearchRequest[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > 5)
    throw new Error("web_search: queries must contain 1 to 5 items");
  return input.map((raw, index) => {
    const query = typeof raw.query === "string" ? raw.query.trim() : "";
    if (!query) throw new Error(`web_search: queries[${index}].query must not be empty`);
    const includeDomains = normalizeDomains(raw.include_domains, index, "include_domains");
    const excludeDomains = normalizeDomains(raw.exclude_domains, index, "exclude_domains");
    const overlap = includeDomains?.find((domain) => excludeDomains?.includes(domain));
    if (overlap)
      throw new Error(`web_search: domain ${overlap} appears in both include and exclude lists`);
    const dateAfter = validateDate(raw.date_after, index, "date_after");
    const dateBefore = validateDate(raw.date_before, index, "date_before");
    if (dateAfter && dateBefore && dateAfter > dateBefore)
      throw new Error(`web_search: queries[${index}] has date_after after date_before`);
    const language = normalizeLocale(raw.language, /^[a-z]{2}$/i, "lower", index, "language");
    const country = normalizeLocale(raw.country, /^[a-z]{2}$/i, "upper", index, "country");
    const limit =
      typeof raw.limit === "number" &&
      Number.isInteger(raw.limit) &&
      raw.limit >= 1 &&
      raw.limit <= 10
        ? raw.limit
        : raw.limit === undefined
          ? 5
          : NaN;
    if (!Number.isFinite(limit))
      throw new Error(`web_search: queries[${index}].limit must be an integer from 1 to 10`);
    return {
      query,
      limit,
      includeDomains,
      excludeDomains,
      dateAfter,
      dateBefore,
      language,
      country,
    };
  });
}

function normalizeDomains(value: unknown, index: number, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 10)
    throw new Error(`web_search: queries[${index}].${field} is invalid`);
  const domains = value.map((entry) => {
    if (
      typeof entry !== "string" ||
      entry.includes("://") ||
      !/^(?:[a-z0-9-]+\.)*[a-z0-9-]+$/i.test(entry.trim())
    ) {
      throw new Error(`web_search: queries[${index}].${field} must contain hostnames`);
    }
    return entry.trim().toLowerCase().replace(/\.$/, "");
  });
  return [...new Set(domains)];
}

function validateDate(value: unknown, index: number, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    throw new Error(`web_search: queries[${index}].${field} must be YYYY-MM-DD`);
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value)
    throw new Error(`web_search: queries[${index}].${field} is not a real date`);
  return value;
}

function normalizeLocale(
  value: unknown,
  pattern: RegExp,
  casing: "lower" | "upper",
  index: number,
  field: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !pattern.test(value))
    throw new Error(`web_search: queries[${index}].${field} must be a two-letter code`);
  return casing === "lower" ? value.toLowerCase() : value.toUpperCase();
}

function render(outcomes: SearchOutcome[]): string {
  return outcomes
    .map((outcome, index) => {
      const heading = `## ${index + 1}. ${outcome.query}`;
      if (!outcome.ok)
        return `${heading}\n\nError [${outcome.error.code}]: ${outcome.error.message}`;
      if (outcome.results.length === 0) return `${heading}\n\nNo results found.`;
      return `${heading}\n\n${outcome.results.map((result) => `${result.position}. [${result.title}](${result.url})${result.snippet ? `\n   ${result.snippet}` : ""}`).join("\n\n")}`;
    })
    .join("\n\n");
}

function clamp(value: number | undefined, min: number, max: number, fallback: number): number {
  return value === undefined || !Number.isFinite(value)
    ? fallback
    : Math.max(min, Math.min(max, Math.floor(value)));
}

function isSearchResults(value: unknown): value is SearchResult[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        entry !== null &&
        typeof entry === "object" &&
        typeof (entry as SearchResult).position === "number" &&
        typeof (entry as SearchResult).title === "string" &&
        typeof (entry as SearchResult).url === "string" &&
        typeof (entry as SearchResult).snippet === "string",
    )
  );
}
