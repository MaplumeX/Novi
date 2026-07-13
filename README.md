# Novi

## Web tools

Novi exposes two batch-only web tools:

```json
{"queries":[{"query":"TypeScript ESM","limit":5}],"force_refresh":false}
```

```json
{"urls":["https://example.com/article"],"format":"markdown","max_chars_per_item":20000}
```

`web_search` uses key-free DuckDuckGo HTML search by default. Set an explicit
provider in `~/.novi/settings.json` (or a trusted project settings file) to use
Brave or Tavily; exporting a key alone never changes the provider:

```json
{
  "webSearch": {
    "provider": "brave",
    "cacheTtlMinutes": 15,
    "timeoutSeconds": 15,
    "concurrency": 3
  },
  "fetchContent": {
    "fallbackProvider": "tavily",
    "cacheTtlMinutes": 15,
    "timeoutSeconds": 20,
    "concurrency": 4,
    "maxRedirects": 3
  }
}
```

Brave requires `BRAVE_API_KEY`; Tavily search and the explicitly enabled
Tavily Extract fallback require `TAVILY_API_KEY`. Credentials are never
persisted in settings or web caches.

Web requests inherit `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY` (including
their lowercase variants) from the Novi process environment.

| Filter | DuckDuckGo | Brave | Tavily |
| --- | --- | --- | --- |
| include/exclude domains | no | yes | yes |
| complete date range | no | yes | yes |
| language | no | yes | no |
| country | no | yes | yes |

Unsupported filters produce an explicit per-query `UNSUPPORTED_FILTER`; they
are never silently discarded. `fetch_content` supports public HTML, text,
JSON, and text-layer PDF documents. It performs local extraction first and
never invokes an LLM. Scanned PDFs return `OCR_UNSUPPORTED`; browser automation
and authenticated-page access remain separate capabilities.

Both tools use a 15-minute persistent cache under `~/.novi/cache/web/` by
default. Oversized documents remain available at the returned continuation
path for exact reading with `read_file`. Fetching validates DNS and every
redirect, rejects private/internal targets, pins validated DNS answers, and
applies time, redirect, and response-size limits.
