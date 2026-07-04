import { duckDuckGoProvider } from "./duckduckgo.js";

/**
 * Pluggable search-provider abstraction.
 *
 * Each provider implements {@link SearchProvider}; the resolver picks one
 * based on settings or env-var availability. Adding a new provider is a
 * matter of creating a file exporting a {@link SearchProvider} instance and
 * adding it to the {@link PROVIDERS} array below.
 */

export interface SearchOpts {
  /** Max results to return (1-20). Default 5. */
  limit?: number;
  /** AbortSignal forwarded to the underlying fetch call. */
  signal?: AbortSignal;
}

export interface SearchResult {
  title: string;
  url: string;
  description: string;
}

export interface SearchProvider {
  /** Stable id used to match `settings.webSearch.provider`. */
  name: string;
  /** Whether this provider can be used right now (reads env, no network). */
  isAvailable(): boolean;
  /** Execute the search; throw on failure. */
  search(query: string, opts: SearchOpts): Promise<SearchResult[]>;
}

/**
 * Registered providers, in priority order. DuckDuckGo is always available
 * (no key required), so it comes first and is the default zero-config option.
 * Future key-gated providers are appended after.
 */
export const PROVIDERS: SearchProvider[] = [duckDuckGoProvider];

/**
 * Resolve which provider to use.
 *
 * - When `configured` names a registered provider, return it directly (even
 *   if `isAvailable()` is false — the subsequent `search()` call will throw a
 *   clear configuration error).
 * - Otherwise return the first provider whose `isAvailable()` is true.
 * - If none are available, throw a clear message explaining how to configure.
 */
export function resolveProvider(configured?: string): SearchProvider {
  if (configured) {
    const match = PROVIDERS.find((p) => p.name === configured);
    if (match) return match;
    throw new Error(
      `Unknown web search provider "${configured}". Known providers: ${PROVIDERS.map((p) => p.name).join(", ")}.`,
    );
  }

  for (const p of PROVIDERS) {
    if (p.isAvailable()) return p;
  }

  throw new Error(
    "No web search provider configured. DuckDuckGo is always available; if it failed, check network.",
  );
}