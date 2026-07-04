import type { SearchProvider, SearchOpts, SearchResult } from "./provider.js";

/**
 * DuckDuckGo search provider — uses the no-key HTML endpoint.
 *
 * Endpoint: `https://html.duckduckgo.com/html/` accepts a POST form with
 * `q=<query>` and returns a plain HTML page. Result links carry the real URL
 * inside an `uddg=` query parameter (URL-decoded) and snippets use the
 * `.result__snippet` class. No API key is required, so `isAvailable()` is
 * always true.
 */

const DDG_ENDPOINT = "https://html.duckduckgo.com/html/";
const USER_AGENT = "Novi/0.0.0";

export const duckDuckGoProvider: SearchProvider = {
  name: "duckduckgo",
  isAvailable: () => true,

  async search(query: string, opts: SearchOpts): Promise<SearchResult[]> {
    const limit = clampLimit(opts.limit);
    const body = new URLSearchParams({ q: query });

    const response = await fetch(DDG_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": USER_AGENT,
      },
      body: body.toString(),
      signal: opts.signal,
    });

    if (!response.ok) {
      throw new Error(`DuckDuckGo search failed: HTTP ${response.status} ${response.statusText}`);
    }

    const html = await response.text();
    const results = parseResults(html);
    return results.slice(0, limit);
  },
};

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || Number.isNaN(limit)) return 5;
  return Math.max(1, Math.min(20, Math.floor(limit)));
}

/**
 * Parse the DuckDuckGo HTML results page.
 *
 * Each result is wrapped in a `.result` block; the anchor `.result__a` carries
 * the title text and an href like `//duckduckgo.com/l/?uddg=<url-encoded>…`.
 * Snippets live under `.result__snippet`. When the page structure changes
 * (or no results match) we return an empty array rather than throwing.
 */
function parseResults(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  const resultRe = /<a[^>]+class="[^"]*result__a[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
  const hrefRe = /href="([^"]+)"/;
  const snippetRe = /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;

  const anchors = collectMatches(html, resultRe);
  const snippets = collectMatches(html, snippetRe);

  for (let i = 0; i < anchors.length; i++) {
    const anchorHtml = anchors[i][1];
    const hrefMatch = hrefRe.exec(anchors[i][0]);
    if (!hrefMatch) continue;

    const realUrl = extractUddg(hrefMatch[1]);
    if (!realUrl) continue;

    const title = stripTags(anchorHtml).trim();
    if (!title || !realUrl) continue;

    const description = snippets[i] ? stripTags(snippets[i][1]).trim() : "";
    results.push({ title, url: realUrl, description });
  }

  return results;
}

function collectMatches(text: string, re: RegExp): RegExpExecArray[] {
  const out: RegExpExecArray[] = [];
  let m: RegExpExecArray | null;
  // Clone the regex so we don't depend on the global state of shared instances.
  const local = new RegExp(re.source, re.flags);
  while ((m = local.exec(text)) !== null) {
    out.push(m);
    if (m.index === local.lastIndex) local.lastIndex++;
  }
  return out;
}

function extractUddg(href: string): string | undefined {
  let raw = href;
  if (raw.startsWith("//")) raw = "https:" + raw;
  try {
    const u = new URL(raw);
    const uddg = u.searchParams.get("uddg");
    if (uddg) return uddg;
    // Some links are direct (not wrapped through duckduckgo.com/l/).
    if (u.protocol === "http:" || u.protocol === "https:") return u.toString();
  } catch {
    return undefined;
  }
  return undefined;
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ");
}