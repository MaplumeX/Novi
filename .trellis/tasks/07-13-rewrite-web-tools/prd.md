# 重写 Novi Agent Web Search 与 Fetch Content 工具

## Goal

Redesign and rewrite Novi Agent's built-in `web_search` and `fetch_content`
tools from first principles so agents can reliably discover web sources and
retrieve model-ready source content.

## Requirements

- Replace the two tools' design and implementation rather than incrementally
  modifying or preserving the current internal approach.
- Keep the public tool names `web_search` and `fetch_content` so existing agent
  prompts and built-in tool registration continue to work.
- Define the new input/output contracts, provider strategy, content handling,
  safety boundaries, failure semantics, and test coverage during planning.
- Treat the current code only as evidence of repository integration boundaries;
  it is not a design constraint or implementation template.
- `web_search` must work without configuration through a default provider and
  also support explicitly configured, higher-quality API-backed providers
  behind the same tool contract.
- The first release must implement three search providers: zero-configuration
  DuckDuckGo HTML search, Brave Search API, and Tavily Search API.
- DuckDuckGo is a best-effort default because it relies on a public HTML
  surface; Brave and Tavily are explicit API-key-backed choices.
- Provider selection must be explicit and cost-predictable: an unset
  `webSearch.provider` always selects DuckDuckGo, even when API-key environment
  variables exist. Selecting Brave or Tavily without its credential must fail
  clearly and must not silently fall back.
- Providers must declare filter capabilities. Unsupported requested filters
  must be reported explicitly rather than silently ignored.
- Capability enforcement is strict per query: requesting any filter that the
  active provider cannot reliably honor yields an `UNSUPPORTED_FILTER` outcome
  for that query. Other queries in the batch continue normally.
- `fetch_content` must support public HTML pages, plain text, JSON, and PDF in
  its first release; unsupported binary media must be rejected explicitly.
- PDF support is limited to documents with an extractable text layer. Extracted
  output must preserve page boundaries. Image-only/scanned PDFs must return a
  clear per-item `OCR_UNSUPPORTED`-style error; OCR is outside this task.
- `fetch_content` must accept bounded URL batches (target maximum: 10), fetch
  them with bounded concurrency, preserve input order, and report success or
  failure per URL without discarding successful siblings.
- Fetching must be local-first. An explicitly configured Tavily Extract
  provider may be used as fallback for JavaScript-heavy, blocked, or locally
  unextractable pages; remote fallback use must be visible in each result.
- Browser automation is outside this task and must remain a separate future
  capability rather than an implicit heavyweight dependency.
- The first release must not invoke an LLM to summarize fetched content.
  Content bounding and continuation must be deterministic and preserve source
  fidelity without hidden model cost.
- Search responses and normalized fetched content must use a persistent local
  cache with a default 15-minute TTL. Cache keys must include every input that
  affects output, including provider, filters, URL, and output format.
- Callers must be able to bypass cached data with `force_refresh`.
- When normalized content exceeds the response budget, `fetch_content` must
  cache the complete content and return a bounded preview, size/truncation
  metadata, and a local path suitable for exact continuation with `read_file`.
- Cache entries must contain only public response data and metadata; API keys,
  authorization headers, and other credentials must never be persisted.
- `web_search` must accept bounded query batches (target maximum: 5), execute
  them with bounded concurrency, and return independent ordered outcomes.
- Each search request in a batch must be able to express its own result limit,
  site inclusion/exclusion filters, and time range when the selected provider
  supports those capabilities.
- The rewritten request schema is intentionally breaking and batch-only:
  `web_search` accepts `queries` (an array of per-query request objects) and
  `fetch_content` accepts `urls` (an array of URL strings). Single operations
  use one-element arrays; legacy scalar `query` and `url` inputs are not
  supported.
- `web_search` has a call-level `force_refresh`; each query item supports
  `query`, optional `limit`, domain include/exclude filters, date bounds,
  language, and country.
- `fetch_content` has call-level `format`, `max_chars_per_item`, and
  `force_refresh` controls.
- Model-visible tool `content` must be compact Markdown organized by query or
  URL. Machine-facing `details` must expose the same normalized outcomes as a
  stable structured object, including provider/extractor, cache status,
  timings, redirects, per-item errors, lengths, truncation, and cache paths.
- Markdown and structured details must be rendered from one normalized result
  model so they cannot disagree.

## Acceptance Criteria

- [x] `web_search` has a documented, model-friendly request and response
  contract and returns useful source metadata for downstream retrieval.
- [x] A fresh Novi installation can search without an API key; users can opt
  into a configured API provider without changing how the agent calls the tool.
- [x] DuckDuckGo, Brave, and Tavily normalize results into the same stable
  result model, with provider-specific responses covered by fixture tests.
- [x] Merely exporting a Brave or Tavily key does not change the active
  provider; explicit misconfiguration produces an actionable error.
- [x] Provider capability tests prove that unsupported filters fail before the
  provider request and are never silently dropped or approximated.
- [x] A batch of distinct search queries returns a separately attributable,
  ordered result set for every query and respects documented batch limits.
- [x] Tool schemas reject empty batches, over-limit batches, legacy scalar
  input, invalid dates/locales, and contradictory domain filters before any
  network request is made.
- [x] Success, partial failure, empty results, cache hits, and truncated content
  have consistent model-readable Markdown and equivalent structured details.
- [x] `fetch_content` has a documented request and response contract and turns
  supported public web resources into bounded, model-ready content.
- [x] HTML, plain text, JSON, and PDF each have a tested media-specific parsing
  path, with clear errors for malformed or unsupported content.
- [x] Text PDFs preserve page boundaries; scanned/image-only PDFs fail clearly
  without invoking OCR or any model service.
- [x] A batch containing both successful and failed URLs returns both outcomes
  in input order and never exceeds its documented concurrency limit.
- [x] Local extraction is attempted before remote extraction, Tavily fallback
  occurs only when explicitly configured, and result metadata identifies the
  path used.
- [x] Fetching never triggers an auxiliary model call.
- [x] Repeated equivalent calls within the TTL avoid duplicate network work;
  `force_refresh` performs a new request; stale/corrupt cache entries degrade
  safely to a fresh request.
- [x] Oversized normalized content is recoverable in full through the returned
  cache path without repeating the network request.
- [x] Network access is bounded, abortable, and protected against access to
  private/internal resources, including redirect and DNS-resolution paths.
- [x] Expected failure modes are explicit and covered by automated tests.
- [x] The rewritten tools are registered under their existing public names and
  pass the project's typecheck, lint, test, and build gates.

## Notes

- User instruction: do not base the redesign on the current implementation.
- This is a complex task; `design.md` and `implement.md` are required before
  implementation can start.
