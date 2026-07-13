# Provider and Runtime Notes

Research date: 2026-07-13

## Primary sources

- Brave Web Search API:
  https://api-dashboard.search.brave.com/api-reference/web/search/get
- Tavily Search API:
  https://docs.tavily.com/documentation/api-reference/endpoint/search
- Tavily Extract API:
  https://docs.tavily.com/documentation/api-reference/endpoint/extract
- Mozilla PDF.js Node setup:
  https://github.com/mozilla/pdf.js/wiki/setup-pdf.js-in-a-website
- Undici dispatcher and DNS lookup:
  https://github.com/nodejs/undici/blob/main/docs/docs/api/Dispatcher.md

## Decisions grounded in the sources

- Brave supports result counts, country, search language, and freshness. Its
  custom freshness syntax requires a complete start/end pair.
- Tavily Search supports native domain lists, start/end dates, country bias,
  and explicit basic depth. Novi will disable generated answers and raw content
  in search because `fetch_content` owns source retrieval.
- Tavily Extract accepts up to 20 URLs, returns separate success/failure lists,
  supports Markdown/text, and can process a Novi batch of at most 10 in one
  request.
- PDF.js publishes the `pdfjs-dist` npm package and Node examples. Novi uses
  only text extraction, not rendering or OCR.
- Undici accepts a custom DNS lookup function. Novi can validate all DNS
  answers, then give Undici only the approved records so connection-time
  resolution cannot escape the SSRF policy.
