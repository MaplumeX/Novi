import { parseHTML } from "linkedom";
import type { SearchProvider } from "../search-provider.js";
import { guardedRequest } from "../network.js";
import { WebToolError } from "../errors.js";
import { normalizeResultUrl, resultSource } from "./shared.js";

export const duckDuckGoProvider: SearchProvider = {
  id: "duckduckgo",
  capabilities: {
    includeDomains: false,
    excludeDomains: false,
    dateAfter: false,
    dateBefore: false,
    language: false,
    country: false,
  },
  validateConfiguration: () => undefined,
  async search(request, context) {
    const endpoint = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(request.query)}`;
    const response = await guardedRequest(endpoint, {
      signal: context.signal,
      timeoutMs: context.timeoutMs,
      maxBytes: 2 * 1024 * 1024,
      env: context.env,
    });
    if (response.status === 429)
      throw new WebToolError("PROVIDER_RATE_LIMIT", "DuckDuckGo rate limited the request", true);
    if (response.status < 200 || response.status >= 300) {
      throw new WebToolError(
        "PROVIDER_ERROR",
        `DuckDuckGo returned HTTP ${response.status}`,
        response.status >= 500,
      );
    }
    const html = Buffer.from(response.body).toString("utf8");
    if (/anomaly-modal|challenge-form|bots use duckduckgo/i.test(html)) {
      throw new WebToolError("PROVIDER_ERROR", "DuckDuckGo returned a bot challenge", true);
    }
    const { document } = parseHTML(html);
    const nodes = Array.from(document.querySelectorAll(".result"));
    if (nodes.length === 0 && !/no results/i.test(html)) {
      throw new WebToolError(
        "PROVIDER_ERROR",
        "DuckDuckGo response markup was not recognized",
        true,
      );
    }
    return nodes.slice(0, request.limit).flatMap((node, index) => {
      const link = node.querySelector(".result__a") as HTMLAnchorElement | null;
      if (!link?.textContent || !link.getAttribute("href")) return [];
      const href = normalizeResultUrl(decodeDuckDuckGoUrl(link.getAttribute("href") ?? ""));
      if (!href) return [];
      const snippet = node.querySelector(".result__snippet")?.textContent?.trim() ?? "";
      return [
        {
          position: index + 1,
          title: link.textContent.trim(),
          url: href,
          snippet,
          publishedAt: null,
          source: resultSource(href),
        },
      ];
    });
  },
};

function decodeDuckDuckGoUrl(href: string): string {
  try {
    const url = new URL(href, "https://duckduckgo.com");
    return url.searchParams.get("uddg") ?? url.toString();
  } catch {
    return href;
  }
}
