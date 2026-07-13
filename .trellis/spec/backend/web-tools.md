# Web Tool Contracts

## Scenario: Built-in web search and public-content retrieval

### 1. Scope / Trigger

Use this contract whenever changing `web_search`, `fetch_content`, web-tool
settings, providers, cache layout, public-network access, or the tool factory
call chain. The two public names stay stable, but both inputs are intentionally
batch-only. Browser automation, authenticated pages, OCR, crawling, and hidden
LLM summarization are outside this subsystem.

### 2. Signatures

```ts
createBuiltinTools(
  env: ExecutionEnv,
  sessionId: string,
  options?: WebToolOptions,
): AgentTool[];

interface WebSearchInput {
  queries: Array<{
    query: string;
    limit?: number;                 // 1..10, default 5
    include_domains?: string[];
    exclude_domains?: string[];
    date_after?: string;            // real YYYY-MM-DD
    date_before?: string;
    language?: string;              // ISO 639-1
    country?: string;               // ISO 3166-1 alpha-2
  }>;                               // 1..5
  force_refresh?: boolean;
}

interface FetchContentInput {
  urls: string[];                   // 1..10
  format?: "markdown" | "text";    // default markdown
  max_chars_per_item?: number;      // 2,000..50,000, default 20,000
  force_refresh?: boolean;
}
```

Every call site (bootstrap, resumed bootstrap, gateway session, and TUI
rebuild) passes the same resolved `webSearch` / `fetchContent` settings. TUI
session changes retain the latest resolved tool settings even when model
settings are replayed from the old harness.

### 3. Contracts

- Unset `webSearch.provider` means `duckduckgo`, regardless of environment
  keys. `brave` requires `BRAVE_API_KEY`; `tavily` requires `TAVILY_API_KEY`.
- DuckDuckGo is key-free and best-effort. Brave supports domains, complete
  date ranges, language, and country. Tavily supports domains, dates, and
  country, but not language.
- `fetch_content` is local-first and supports HTML, text, JSON, and text-layer
  PDF. `fetchContent.fallbackProvider: "tavily"` explicitly permits eligible
  URLs to be disclosed to Tavily Extract and requires `TAVILY_API_KEY`.
- Expected per-query/per-URL failures are ordered sibling outcomes. Invalid
  top-level schemas, invalid provider configuration, and caller cancellation
  fail the whole tool.
- Model-visible Markdown and `details.outcomes` are rendered from the same
  normalized result. Provider/extractor, cache state, duration, redirects,
  length, truncation, and continuation path remain visible.
- Cache root is `~/.novi/cache/web/{search,content,documents}`. Keys include
  version, provider/extractor configuration, every output-affecting filter,
  canonical URL, and format. `max_chars_per_item` affects preview rendering,
  not full-document identity. Default TTL is 15 minutes.
- Cache payloads contain public normalized data only. Never serialize API
  keys, Authorization headers, cookies, provider raw errors, or stacks.
- Public fetches use `guardedRequest`, never unrestricted global `fetch`.
  Validate all DNS answers, pin validated answers into Undici, revalidate every
  redirect, reject URL credentials/private/reserved/test/metadata addresses,
  and apply total timeout, redirect, and byte limits.

### 4. Validation & Error Matrix

| Condition | Outcome |
| --- | --- |
| empty/oversized batch, legacy scalar `query`/`url` | whole-tool schema/validation error |
| empty query, invalid date/locale/domain, contradictory domains | whole-tool pre-network validation error |
| requested unsupported Provider filter | per-query `UNSUPPORTED_FILTER` |
| selected API Provider lacks its key | actionable whole-tool configuration error |
| malformed/non-HTTP URL or URL credentials | per-URL `INVALID_URL` |
| literal or DNS-resolved non-public address | per-URL `PRIVATE_ADDRESS` |
| DNS failure | per-URL `DNS_FAILURE` |
| timeout / byte cap / unsupported binary | `TIMEOUT` / `RESPONSE_TOO_LARGE` / `UNSUPPORTED_MEDIA_TYPE` |
| malformed JSON / unextractable HTML | `EXTRACTION_FAILED` |
| malformed PDF / no text layer | `PDF_INVALID` / `OCR_UNSUPPORTED` |
| Provider auth/rate/server failure | `PROVIDER_AUTH` / `PROVIDER_RATE_LIMIT` / `PROVIDER_ERROR` |
| caller AbortSignal | throw cancellation; do not normalize into an item error |

All public item errors include `{ code, message, retryable }` and exclude
credentials, raw authorization data, provider payloads, and internal stacks.

### 5. Good / Base / Bad Cases

- Good: a five-query Brave batch validates capabilities, runs with bounded
  concurrency, returns ordered independent outcomes, and reuses per-query
  cache entries.
- Base: one-element `queries` / `urls` arrays represent a single operation;
  DuckDuckGo and local extraction need no credential.
- Bad: exporting `BRAVE_API_KEY` silently changes the default provider, a
  Provider drops unsupported filters, a fetch follows redirects with global
  `fetch`, or truncation discards the only full copy.

### 6. Tests Required

- Schema/semantic tests assert empty/oversized/legacy inputs, real dates,
  locale normalization, contradictory domains, and no pre-validation network.
- Provider fixture tests assert DuckDuckGo challenge/markup detection, Brave
  query parameters/status mapping, Tavily request flags, normalized results,
  missing keys, and unsupported capabilities.
- Cache tests assert canonical keys, mixed hits, TTL, force refresh,
  corrupt-entry recovery, exact document persistence, and no credentials.
- Network tests assert private IPv4/IPv6 ranges, mixed DNS answers, DNS timeout,
  pinned lookup, redirect revalidation/loops, byte limits, credentials, and
  abort behavior without public internet access.
- Extractor tests assert hostile/relative-link HTML, charset text, stable JSON,
  text PDF page boundaries, invalid/scanned PDF, and unsupported binary media.
- Tool tests assert batch ordering, bounded concurrency, partial success,
  fallback eligibility/disclosure, truncation continuation, and equivalent
  Markdown/details semantics.
- Before completion run `npm run typecheck`, `npm run lint`, `npm run test`,
  `npm run build`, and `git diff --check`.

### 7. Wrong vs Correct

#### Wrong

```ts
const provider = process.env.BRAVE_API_KEY ? "brave" : "duckduckgo";
const response = await fetch(userUrl, { redirect: "follow" });
return { content: [{ type: "text", text: responseText.slice(0, limit) }] };
```

This creates unpredictable cost, bypasses DNS/redirect SSRF policy, discards
the exact source, and gives siblings no independent error model.

#### Correct

```ts
const provider = resolveSearchProvider(resolvedOptions); // unset => DuckDuckGo
validateCapabilities(provider, normalizedQuery);
const response = await guardedRequest(publicUrl, networkLimits);
const documentPath = await writeDocument(cacheRoot, key, format, fullContent);
return renderNormalizedOutcomes(orderedOutcomes, documentPath);
```

Provider choice is explicit, the public-network boundary is centralized, and
the normalized outcome owns both model Markdown and structured details.
