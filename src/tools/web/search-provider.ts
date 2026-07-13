import type { SearchRequest, SearchResult, WebSearchProviderId, WebToolOptions } from "./types.js";
import { WebToolError } from "./errors.js";
import { braveProvider } from "./providers/brave.js";
import { duckDuckGoProvider } from "./providers/duckduckgo.js";
import { tavilyProvider } from "./providers/tavily.js";

export interface SearchCapabilities {
  includeDomains: boolean;
  excludeDomains: boolean;
  dateAfter: boolean;
  dateBefore: boolean;
  language: boolean;
  country: boolean;
}

export interface SearchProvider {
  id: WebSearchProviderId;
  capabilities: SearchCapabilities;
  validateConfiguration(env: NodeJS.ProcessEnv): void;
  search(
    request: SearchRequest,
    context: { signal?: AbortSignal; timeoutMs: number; env: NodeJS.ProcessEnv },
  ): Promise<SearchResult[]>;
}

const PROVIDERS: Record<WebSearchProviderId, SearchProvider> = {
  duckduckgo: duckDuckGoProvider,
  brave: braveProvider,
  tavily: tavilyProvider,
};

export function resolveSearchProvider(options: WebToolOptions): SearchProvider {
  const id = options.webSearch?.provider ?? "duckduckgo";
  const provider = PROVIDERS[id];
  if (!provider) throw new Error(`web_search: unknown provider "${String(id)}"`);
  provider.validateConfiguration(options.env ?? process.env);
  return provider;
}

export function validateCapabilities(provider: SearchProvider, request: SearchRequest): void {
  const requested: Array<[keyof SearchCapabilities, boolean]> = [
    ["includeDomains", Boolean(request.includeDomains?.length)],
    ["excludeDomains", Boolean(request.excludeDomains?.length)],
    ["dateAfter", request.dateAfter !== undefined],
    ["dateBefore", request.dateBefore !== undefined],
    ["language", request.language !== undefined],
    ["country", request.country !== undefined],
  ];
  const unsupported = requested
    .filter(([key, used]) => used && !provider.capabilities[key])
    .map(([key]) => key);
  if (unsupported.length > 0) {
    throw new WebToolError(
      "UNSUPPORTED_FILTER",
      `${provider.id} does not support: ${unsupported.join(", ")}`,
    );
  }
}
