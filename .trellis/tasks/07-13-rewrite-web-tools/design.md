# Web Search and Fetch Content Redesign

## 1. Scope and design stance

This task replaces the internal design of Novi's `web_search` and
`fetch_content` tools. Only their public names and repository integration
points are retained. The implementation is local-first, deterministic, batch
oriented, and explicit about provider cost and remote content disclosure.

The two tools share four infrastructure modules:

1. normalized result and error contracts;
2. bounded concurrency;
3. persistent TTL cache;
4. guarded HTTP transport.

Browser automation, authenticated page access, OCR, crawling, and implicit LLM
summarization are deliberately outside the scope.

## 2. Public tool contracts

### 2.1 `web_search`

Input:

```ts
interface WebSearchInput {
  queries: Array<{
    query: string;
    limit?: number; // 1..10, default 5
    include_domains?: string[];
    exclude_domains?: string[];
    date_after?: string; // YYYY-MM-DD
    date_before?: string; // YYYY-MM-DD
    language?: string; // ISO 639-1
    country?: string; // ISO 3166-1 alpha-2 localization/bias
  }>; // 1..5
  force_refresh?: boolean;
}
```

Validation occurs before network access. Queries are trimmed and must be
non-empty. Domain values are hostnames, not URLs; values are lowercased and
deduplicated. The same domain cannot appear in both lists. Date strings must be
real calendar dates and `date_after <= date_before`. Locale codes are
normalized to lowercase language and uppercase country.

Output is a compact Markdown section per query. Each normalized search result
contains:

```ts
interface SearchResult {
  position: number;
  title: string;
  url: string;
  snippet: string;
  publishedAt: string | null;
  source: string | null;
}
```

The structured `details` envelope contains the active provider and one ordered
outcome per input query. Empty results are successful outcomes with an empty
array. Provider/network failures are per-query failures. Invalid top-level
input, invalid provider configuration, and cancellation fail the whole tool.

### 2.2 `fetch_content`

Input:

```ts
interface FetchContentInput {
  urls: string[]; // 1..10
  format?: "markdown" | "text"; // default markdown
  max_chars_per_item?: number; // 2,000..50,000, default 20,000
  force_refresh?: boolean;
}
```

Only public HTTP(S) URLs without embedded credentials are accepted. URLs are
canonicalized for cache identity while preserving meaningful query strings.

Each successful item records:

```ts
interface FetchSuccess {
  requestedUrl: string;
  finalUrl: string;
  title: string | null;
  mediaType: "html" | "text" | "json" | "pdf";
  extractor: "local" | "tavily";
  content: string; // full normalized content before response bounding
  bytesDownloaded: number | null;
  redirectCount: number;
}
```

The Markdown renderer emits one section per URL with source metadata and the
bounded preview. `details` contains the same ordered outcomes, cache state,
timing, original/full character counts, truncation, and continuation path.
One URL failure never discards successful siblings.

## 3. Error contract

Expected failures use stable codes in per-item structured outcomes:

- `INVALID_URL`
- `PRIVATE_ADDRESS`
- `DNS_FAILURE`
- `HTTP_ERROR`
- `TIMEOUT`
- `RESPONSE_TOO_LARGE`
- `UNSUPPORTED_MEDIA_TYPE`
- `EXTRACTION_FAILED`
- `PDF_INVALID`
- `OCR_UNSUPPORTED`
- `UNSUPPORTED_FILTER`
- `PROVIDER_AUTH`
- `PROVIDER_RATE_LIMIT`
- `PROVIDER_ERROR`

Each error contains a safe message and `retryable` boolean. It never contains
an API key, authorization header, raw provider response, or internal stack.
Abort remains an actual thrown cancellation rather than a normal item error.

## 4. Search provider architecture

`SearchProvider` exposes immutable metadata, capabilities, a cheap local
availability/configuration check, and `search(request, context)`.

```ts
interface SearchCapabilities {
  includeDomains: boolean;
  excludeDomains: boolean;
  dateAfter: boolean;
  dateBefore: boolean;
  language: boolean;
  country: boolean;
}
```

The resolver uses only `resolvedSettings.webSearch.provider`:

- absent -> `duckduckgo`;
- `duckduckgo` -> key-free provider;
- `brave` -> requires `BRAVE_API_KEY`;
- `tavily` -> requires `TAVILY_API_KEY`;
- unknown -> configuration error.

Environment keys never change provider selection. Provider API endpoints are
fixed constants; callers cannot override them through tool input.

Capability enforcement runs before cache lookup and provider execution. An
unsupported requested filter creates `UNSUPPORTED_FILTER` for that query; it
is never omitted or approximated silently.

### 4.1 Provider capability mapping

| Capability | DuckDuckGo | Brave | Tavily |
|---|---:|---:|---:|
| Result limit | yes | yes | yes |
| Include domains | no | yes, official `site:` operators | yes, native |
| Exclude domains | no | yes, official `-site:` operators | yes, native |
| Date bounds | no | yes, both bounds required for a custom range | yes |
| Language | no | yes | no |
| Country | no | yes | yes, localization/bias |

For Brave, a lone date boundary is rejected because its custom range requires
both endpoints. Tavily search uses `basic` depth and does not request generated
answers or raw page content, preventing hidden extra model output and credits.

DuckDuckGo uses its non-JavaScript HTML endpoint, an honest Novi user agent,
strict response limits, and structural parsing. Challenge pages and markup
drift become explicit provider errors. It remains intentionally documented as
best-effort.

## 5. Fetch pipeline

### 5.1 Local-first flow

For every URL:

1. validate syntax, scheme, credentials, hostname, and port;
2. check a fresh cache entry unless `force_refresh`;
3. perform a guarded GET with manual redirects;
4. classify the response from normalized `Content-Type`, with conservative
   signature checks for mislabeled PDF/HTML;
5. parse through the media-specific extractor;
6. normalize whitespace without changing factual content;
7. write the complete normalized content and metadata to cache;
8. render a bounded preview and continuation path.

Supported local extraction:

- HTML: LinkeDOM + Mozilla Readability, then Turndown for Markdown; text mode
  uses extracted text content. Relative links are resolved against final URL.
  Scripts, styles, forms, hidden metadata, data-URI images, and dangerous URL
  schemes are removed.
- Plain text: charset-aware decode with UTF-8 fallback and line-ending
  normalization.
- JSON: bounded parse followed by stable pretty printing; malformed JSON is an
  extraction failure rather than unstructured pass-through.
- PDF: `pdfjs-dist` text extraction page by page. Page boundaries are emitted
  as Markdown headings or text delimiters. A document with no meaningful text
  yields `OCR_UNSUPPORTED`.

### 5.2 Tavily fallback

`resolvedSettings.fetchContent.fallbackProvider === "tavily"` explicitly opts
in to sending public URLs to Tavily and requires `TAVILY_API_KEY`.

Eligible local failures are access blocks (`401`, `403`, `429`), bot challenge
content, and HTML extraction failure/near-empty content. Invalid/private URLs,
abort, DNS policy rejection, unsupported binary media, and local response-size
violations are not remotely retried.

Eligible failed URLs from the same call are sent in one Tavily Extract batch,
using `basic` depth and the requested `markdown`/`text` format. Tavily's
successful and failed arrays are mapped back to original input positions.
Every fallback result sets `extractor: "tavily"`; there is no silent remote
processing.

## 6. Guarded network transport

Public URL fetching does not use unrestricted global `fetch`. A shared Undici
transport performs:

- HTTP(S)-only and no URL credentials;
- rejection of localhost, `.localhost`, private, loopback, link-local,
  multicast, documentation/test, carrier-grade NAT, benchmarking, unspecified,
  and cloud metadata address ranges for IPv4 and IPv6;
- DNS resolution of all returned addresses and rejection if any address is not
  public;
- a custom Undici lookup that returns only the already validated addresses,
  preventing a second unvalidated DNS resolution at connection time;
- manual redirects, maximum three, with full validation and a fresh dispatcher
  for every hop;
- total timeout combined with the caller's `AbortSignal`;
- streaming body consumption with media-aware caps: 5 MiB for HTML/text/JSON
  and 25 MiB for PDF, with 25 MiB as the absolute pre-classification cap;
- bounded response headers and no forwarding of cookies/authorization;
- an honest `Novi/<package version>` user agent and conservative Accept header.

Provider traffic uses fixed HTTPS origins and separate bounded JSON request
helpers. Provider response sizes and timeouts are still capped, but target URL
SSRF pinning is unnecessary because tool input cannot alter provider origins.
Tavily fallback validates every target as a public URL before disclosure.

## 7. Concurrency and cancellation

A shared order-preserving worker pool executes search with concurrency 3 and
local fetch with concurrency 4 by default. Limits are configurable only in
trusted resolved settings and clamped to safe ranges. No work is started after
the caller aborts. Cancellation is propagated to active requests and PDF
processing checkpoints.

Tavily fallback is a single batch API request for all eligible URLs, not one
request per URL.

## 8. Cache and continuation

Cache root:

```text
~/.novi/cache/web/
├── search/<sha256>.json
├── content/<sha256>.json
└── documents/<sha256>.md|txt
```

Search entries are per normalized query item so mixed cache-hit batches do not
repeat other queries. Content entries are per canonical URL, output format,
and extraction configuration. SHA-256 keys are computed from versioned
canonical JSON, allowing schema invalidation without directory migration.

TTL defaults to 15 minutes. Reads validate schema version, key identity,
timestamp, and document existence. Stale or corrupt entries are ignored and
refetched. Writes use temporary files plus atomic rename. Credentials and
request authorization are never serialized.

The full normalized document is always stored for successful fetches. When it
exceeds `max_chars_per_item`, output keeps a line-aligned head preview and
includes the exact full path, total characters/lines, and a suggested
`read_file` continuation command. `max_chars_per_item` changes rendering only,
not the cached normalized document identity.

## 9. Settings and bootstrap integration

Extend `NoviSettings`:

```ts
webSearch?: {
  provider?: "duckduckgo" | "brave" | "tavily";
  cacheTtlMinutes?: number;
  timeoutSeconds?: number;
  concurrency?: number;
};
fetchContent?: {
  fallbackProvider?: "tavily";
  cacheTtlMinutes?: number;
  timeoutSeconds?: number;
  concurrency?: number;
  maxResponseBytes?: number; // absolute cap, default 25 MiB
  maxRedirects?: number;
};
```

`createBuiltinTools` receives resolved web-tool settings and passes a narrow
options object to both factories. Bootstrap, gateway session creation, and TUI
harness rebuild call sites use the same resolved settings, so behavior is
consistent across interactive, headless, and gateway modes.

API keys come from the existing credentials/environment injection path but are
never fields in settings. The initial rewrite does not expand onboarding UI;
configuration errors name the required environment/credential key.

## 10. Module layout

```text
src/tools/
├── web-search.ts
├── fetch-content.ts
└── web/
    ├── types.ts
    ├── errors.ts
    ├── concurrency.ts
    ├── cache.ts
    ├── network.ts
    ├── urls.ts
    ├── render.ts
    ├── search-provider.ts
    ├── providers/
    │   ├── duckduckgo.ts
    │   ├── brave.ts
    │   └── tavily.ts
    └── extractors/
        ├── html.ts
        ├── text.ts
        ├── json.ts
        ├── pdf.ts
        └── tavily.ts
```

Pure parsing, validation, capability, cache-key, and rendering functions get
focused unit tests. Tool tests cover orchestration, partial success, cache,
cancellation, and configuration. Network tests use controlled local DNS/HTTP
fixtures or mocked Undici boundaries; they never reach the public internet.

## 11. Compatibility, rollout, and rollback

This is an intentional schema break: scalar `query` and `url` are removed.
Tool names remain stable. Documentation and the default system prompt/tool
descriptions must teach the new batch contract.

The rewrite lands as one task because search and fetch share settings,
transport, cache, error, and rendering infrastructure. Splitting them would
temporarily duplicate or destabilize those contracts.

Rollback is a normal revert of the task commit. Cache files are additive and
versioned; older binaries ignore them, so rollback does not require data
migration or deletion.
