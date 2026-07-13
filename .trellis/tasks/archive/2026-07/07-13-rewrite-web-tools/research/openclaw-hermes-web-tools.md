# OpenClaw and Hermes Web Tool Research

Research date: 2026-07-13

## OpenClaw

Sources:

- https://docs.openclaw.ai/tools/web
- https://docs.openclaw.ai/tools/web-fetch
- https://docs.openclaw.ai/tools/duckduckgo-search
- https://docs.openclaw.ai/tools/tavily

Findings:

- Separates `web_search`, lightweight local `web_fetch`, and full browser
  automation. JavaScript-heavy and authenticated pages are delegated to the
  browser rather than hidden inside `web_fetch`.
- Search uses normalized provider results and a provider/plugin registry.
  DuckDuckGo is an explicit experimental key-free HTML integration; numerous
  API providers are supported. Search results are cached for 15 minutes by
  default.
- `web_fetch` performs a local HTTP GET, Readability extraction, and optional
  provider fallback (currently official Firecrawl). It accepts one URL.
- Fetch safety includes HTTP(S)-only input, hostname and DNS checks, redirect
  revalidation, redirect limits, response byte caps, timeouts, character caps,
  and narrowly scoped trusted-proxy exceptions.
- Fetch results are cached for 15 minutes by default. A delayed progress signal
  is emitted for requests taking longer than five seconds.

## Hermes Agent

Sources:

- https://hermes-agent.nousresearch.com/docs/user-guide/features/web-search
- https://hermes-agent.nousresearch.com/docs/developer-guide/web-search-provider-plugin

Findings:

- Separates `web_search` and batch-capable `web_extract`, but both are serviced
  through a common provider abstraction.
- Search and extraction providers can be configured independently. Search-only
  providers include SearXNG, Brave, DDGS, and xAI; extraction-capable providers
  include Firecrawl, Tavily, Exa, and Parallel.
- Providers expose capability methods and are registered by bundled, user, or
  package plugins. Cheap availability checks must not perform network calls.
- Long extraction output is size-driven: under 5,000 characters is returned
  raw; medium and large pages are summarized with an auxiliary model; extremely
  large pages are rejected. Browser snapshots are recommended when raw content
  is required instead of LLM-compressed output.
- The default extraction path is provider-backed rather than a local
  Readability implementation. Managed Firecrawl is available through the Nous
  subscription gateway; otherwise users supply provider credentials.

## Implications for Novi

- OpenClaw provides the stronger local-first privacy and SSRF baseline.
- Hermes provides the stronger batch and per-capability provider model.
- Novi can combine these: local bounded fetch and media parsing as the default,
  plus an explicitly configured extraction provider for JavaScript-heavy or
  blocked pages. Because Tavily is already in the agreed search scope and
  supports batch extraction, it is a lower-complexity initial fallback than
  adding another remote Reader provider.
- Browser automation should remain a separate future tool rather than being an
  invisible heavyweight dependency of `fetch_content`.
- LLM summarization should not be implicit in the first fetch implementation:
  it changes source fidelity and adds model cost. Prefer deterministic bounded
  output and explicit continuation/chunk controls first.
