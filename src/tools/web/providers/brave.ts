import type { SearchProvider } from "../search-provider.js";
import { providerJsonRequest } from "../network.js";
import { WebToolError } from "../errors.js";
import { normalizeResultUrl, resultSource } from "./shared.js";

interface BraveResponse {
  web?: {
    results?: Array<{
      title?: string;
      url?: string;
      description?: string;
      age?: string;
      profile?: { long_name?: string };
    }>;
  };
}

export const braveProvider: SearchProvider = {
  id: "brave",
  capabilities: {
    includeDomains: true,
    excludeDomains: true,
    dateAfter: true,
    dateBefore: true,
    language: true,
    country: true,
  },
  validateConfiguration(env) {
    if (!env.BRAVE_API_KEY) throw new Error("web_search: provider brave requires BRAVE_API_KEY");
  },
  async search(request, context) {
    if ((request.dateAfter === undefined) !== (request.dateBefore === undefined)) {
      throw new WebToolError(
        "UNSUPPORTED_FILTER",
        "Brave custom date ranges require both date_after and date_before",
      );
    }
    const query = [
      request.query,
      ...(request.includeDomains ?? []).map((domain) => `site:${domain}`),
      ...(request.excludeDomains ?? []).map((domain) => `-site:${domain}`),
    ].join(" ");
    const url = new URL("https://api.search.brave.com/res/v1/web/search");
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(request.limit));
    if (request.language) url.searchParams.set("search_lang", request.language);
    if (request.country) url.searchParams.set("country", request.country);
    if (request.dateAfter && request.dateBefore)
      url.searchParams.set("freshness", `${request.dateAfter}to${request.dateBefore}`);
    const response = await providerJsonRequest(url.toString(), {
      headers: {
        accept: "application/json",
        "x-subscription-token": context.env.BRAVE_API_KEY ?? "",
      },
      signal: context.signal,
      timeoutMs: context.timeoutMs,
    });
    providerStatus(response.status, "Brave");
    const results = (response.json as BraveResponse).web?.results ?? [];
    return results.slice(0, request.limit).flatMap((entry, index) => {
      const url = entry.url ? normalizeResultUrl(entry.url) : null;
      return entry.title && url
        ? [
            {
              position: index + 1,
              title: entry.title,
              url,
              snippet: entry.description ?? "",
              publishedAt: entry.age ?? null,
              source: entry.profile?.long_name ?? resultSource(url),
            },
          ]
        : [];
    });
  },
};

function providerStatus(status: number, provider: string): void {
  if (status === 401 || status === 403)
    throw new WebToolError("PROVIDER_AUTH", `${provider} rejected the API key`);
  if (status === 429)
    throw new WebToolError("PROVIDER_RATE_LIMIT", `${provider} rate limit exceeded`, true);
  if (status < 200 || status >= 300)
    throw new WebToolError("PROVIDER_ERROR", `${provider} returned HTTP ${status}`, status >= 500);
}
