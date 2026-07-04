import * as Type from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core/node";
import type { ExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { resolveProvider, type SearchResult } from "./web-search/provider.js";
import { textResult } from "./shared.js";

const Parameters = Type.Object({
  query: Type.String(),
  limit: Type.Optional(Type.Number()),
});

/**
 * `web_search`: search the web and return link metadata.
 *
 * Resolves the active search provider (auto-detect by default; settings can
 * override via `webSearch.provider`), executes the search, and returns a
 * markdown-formatted result list to the model. Throws on failure — the
 * harness translates the throw into a tool result with `isError: true`.
 */
export function createWebSearchTool(env: ExecutionEnv): AgentTool<typeof Parameters> {
  void env;
  return {
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web for a query. Returns a list of results with title, URL, and description.",
    parameters: Parameters,
    execute: async (_toolCallId, params, signal) => {
      // DuckDuckGo is always available and is the first provider, so
      // auto-detect (no configured value) returns it. The `webSearch.provider`
      // setting is for future key-gated providers.
      const provider = resolveProvider();
      const limit = clampLimit(params.limit);
      const results = await provider.search(params.query, { limit, signal });
      const body = formatResults(params.query, provider.name, results);
      return textResult(body, {
        provider: provider.name,
        query: params.query,
        results,
      });
    },
  };
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || Number.isNaN(limit)) return 5;
  return Math.max(1, Math.min(20, Math.floor(limit)));
}

function formatResults(query: string, providerName: string, results: SearchResult[]): string {
  if (results.length === 0) {
    return `## Results for "${query}"\n\n(No results found via ${providerName})`;
  }
  const lines = [`## Results for "${query}"`];
  results.forEach((r, i) => {
    lines.push("");
    lines.push(`${i + 1}. **${r.title}**`);
    lines.push(`   ${r.url}`);
    if (r.description) lines.push(`   ${r.description}`);
  });
  return lines.join("\n");
}