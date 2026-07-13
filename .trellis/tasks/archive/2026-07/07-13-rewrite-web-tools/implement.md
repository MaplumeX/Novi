# Implementation Plan

## 1. Contracts and configuration

- [x] Add shared normalized request/result/error types and stable error codes.
- [x] Extend `NoviSettings` and resolution tests for `webSearch` and
  `fetchContent` options without storing API keys in settings.
- [x] Pass resolved web-tool options through every `createBuiltinTools` call
  site (bootstrap, gateway sessions, TUI rebuilds, test helpers).
- [x] Replace both Typebox schemas with the batch-only contracts and add
  pre-network semantic validation.

Validation gate:

```bash
npm run typecheck
npm run test -- src/settings.test.ts src/tools/__tests__/index.test.ts
```

## 2. Shared runtime infrastructure

- [x] Implement ordered bounded concurrency with abort propagation.
- [x] Implement versioned SHA-256 cache keys, TTL reads, atomic writes, corrupt
  entry fallback, and full-document storage under isolated test homes.
- [x] Implement public-IP classification for IPv4/IPv6 and URL normalization.
- [x] Implement guarded Undici transport with pinned validated DNS results,
  redirect revalidation, timeout composition, media-aware streaming byte caps,
  and safe headers.
- [x] Add tests for private ranges, mixed public/private DNS answers, DNS
  rebinding prevention, redirects to private targets, redirect loops, byte
  limits, timeouts, abort, and credential-bearing URLs.

Validation gate:

```bash
npm run test -- src/tools/web
npm run typecheck
```

Rollback point: shared modules are not registered as tools yet.

## 3. Search providers and tool

- [x] Implement provider interface, explicit resolver, and strict capability
  validation.
- [x] Implement DuckDuckGo HTML provider with challenge/markup failure
  detection and fixture tests.
- [x] Implement Brave provider with fixed endpoint, API-key validation, domain
  operators, locale controls, complete date ranges, and response normalization.
- [x] Implement Tavily Search provider using basic depth, no generated answer,
  no raw content, native domain/date/country fields, and response normalization.
- [x] Implement per-query cache, concurrency, ordered partial outcomes,
  Markdown renderer, and structured details in `web_search`.
- [x] Test mixed cache hits, empty results, unsupported filters, missing keys,
  provider auth/rate-limit/server errors, partial batches, and cancellation.

Validation gate:

```bash
npm run test -- src/tools/__tests__/web-search.test.ts src/tools/web
npm run typecheck
```

## 4. Local content extractors

- [x] Add and lock the required runtime dependencies: Undici, Turndown, and
  PDF.js (`pdfjs-dist`), plus TypeScript declarations where required.
- [x] Implement media classification and charset-aware bounded decoding.
- [x] Implement sanitized HTML-to-Markdown/text extraction with absolute safe
  links and no data-URI payloads.
- [x] Implement strict JSON parsing and stable pretty output.
- [x] Implement PDF text-layer extraction with page boundaries, abort checks,
  invalid-PDF errors, and scanned-PDF detection.
- [x] Add fixtures/tests for realistic articles, relative links, hostile HTML,
  encodings, malformed JSON, text PDFs, scanned PDFs, and unsupported binary
  types.

Validation gate:

```bash
npm run test -- src/tools/web/extractors
npm run typecheck
```

## 5. Fetch orchestration and Tavily fallback

- [x] Implement local-first fetch orchestration, media-specific extraction,
  cache integration, and precise fallback eligibility.
- [x] Implement one-request Tavily Extract batching with explicit configuration
  and mapping of successes/failures back to input order.
- [x] Implement deterministic per-item preview bounding, full-document cache
  paths, continuation hints, Markdown rendering, and structured details.
- [x] Test mixed local success/failure, local cache hits, eligible/ineligible
  fallback, fallback disclosure, missing key, Tavily partial failures,
  truncation continuation, force refresh, concurrency, and cancellation.

Validation gate:

```bash
npm run test -- src/tools/__tests__/fetch-content.test.ts src/tools/web
npm run typecheck
```

## 6. Documentation and integration review

- [x] Update tool descriptions, README/ARCHITECTURE documentation, settings
  examples, credential names, capability matrix, privacy note, and breaking
  batch schema examples.
- [x] Confirm all surfaces build tools with identical resolved settings.
- [x] Confirm logs/details never expose API keys or authorization headers.
- [x] Review cache files for public data only and verify project-level settings
  remain trust-gated.

Final validation:

```bash
npm run typecheck
npm run lint
npm run test
npm run build
git diff --check
```

## 7. Review and finish gates

- [x] Run an independent code-quality review against `prd.md` and `design.md`.
- [x] Resolve all blocking findings and rerun the full validation suite.
- [x] Review whether implementation discoveries should update backend specs.
- [x] Commit the implementation only after validation and spec review.
