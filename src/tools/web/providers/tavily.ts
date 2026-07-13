import type { SearchProvider } from "../search-provider.js";
import { providerJsonRequest } from "../network.js";
import { WebToolError } from "../errors.js";
import { normalizeResultUrl, resultSource } from "./shared.js";

interface TavilyResponse {
  results?: Array<{
    title?: string;
    url?: string;
    content?: string;
    published_date?: string;
    score?: number;
  }>;
}

export const tavilyProvider: SearchProvider = {
  id: "tavily",
  capabilities: {
    includeDomains: true,
    excludeDomains: true,
    dateAfter: true,
    dateBefore: true,
    language: false,
    country: true,
  },
  validateConfiguration(env) {
    if (!env.TAVILY_API_KEY) throw new Error("web_search: provider tavily requires TAVILY_API_KEY");
  },
  async search(request, context) {
    const response = await providerJsonRequest("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${context.env.TAVILY_API_KEY ?? ""}`,
      },
      body: JSON.stringify({
        query: request.query,
        max_results: request.limit,
        search_depth: "basic",
        include_answer: false,
        include_raw_content: false,
        include_domains: request.includeDomains,
        exclude_domains: request.excludeDomains,
        start_date: request.dateAfter,
        end_date: request.dateBefore,
        country: request.country,
      }),
      signal: context.signal,
      timeoutMs: context.timeoutMs,
    });
    if (response.status === 401 || response.status === 403)
      throw new WebToolError("PROVIDER_AUTH", "Tavily rejected the API key");
    if (response.status === 429)
      throw new WebToolError("PROVIDER_RATE_LIMIT", "Tavily rate limit exceeded", true);
    if (response.status < 200 || response.status >= 300)
      throw new WebToolError(
        "PROVIDER_ERROR",
        `Tavily returned HTTP ${response.status}`,
        response.status >= 500,
      );
    return ((response.json as TavilyResponse).results ?? [])
      .slice(0, request.limit)
      .flatMap((entry, index) => {
        const url = entry.url ? normalizeResultUrl(entry.url) : null;
        return entry.title && url
          ? [
              {
                position: index + 1,
                title: entry.title,
                url,
                snippet: entry.content ?? "",
                publishedAt: entry.published_date ?? null,
                source: resultSource(url),
              },
            ]
          : [];
      });
  },
};
