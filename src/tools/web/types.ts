export type WebSearchProviderId = "duckduckgo" | "brave" | "tavily";
export type FetchFallbackProviderId = "tavily";
export type ContentFormat = "markdown" | "text";

export interface WebToolOptions {
  webSearch?: {
    provider?: WebSearchProviderId;
    cacheTtlMinutes?: number;
    timeoutSeconds?: number;
    concurrency?: number;
  };
  fetchContent?: {
    fallbackProvider?: FetchFallbackProviderId;
    cacheTtlMinutes?: number;
    timeoutSeconds?: number;
    concurrency?: number;
    maxResponseBytes?: number;
    maxRedirects?: number;
  };
  cacheRoot?: string;
  cacheRetention?: { maxBytes: number; maxAgeMs: number };
  env?: NodeJS.ProcessEnv;
}

export type WebErrorCode =
  | "INVALID_URL"
  | "PRIVATE_ADDRESS"
  | "DNS_FAILURE"
  | "HTTP_ERROR"
  | "TIMEOUT"
  | "RESPONSE_TOO_LARGE"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "EXTRACTION_FAILED"
  | "PDF_INVALID"
  | "OCR_UNSUPPORTED"
  | "UNSUPPORTED_FILTER"
  | "PROVIDER_AUTH"
  | "PROVIDER_RATE_LIMIT"
  | "PROVIDER_ERROR";

export interface WebItemError {
  code: WebErrorCode;
  message: string;
  retryable: boolean;
}

export interface SearchRequest {
  query: string;
  limit: number;
  includeDomains?: string[];
  excludeDomains?: string[];
  dateAfter?: string;
  dateBefore?: string;
  language?: string;
  country?: string;
}

export interface SearchResult {
  position: number;
  title: string;
  url: string;
  snippet: string;
  publishedAt: string | null;
  source: string | null;
}

export interface SearchSuccess {
  ok: true;
  query: string;
  provider: WebSearchProviderId;
  results: SearchResult[];
  cache: "hit" | "miss" | "bypass";
  durationMs: number;
}

export interface SearchFailure {
  ok: false;
  query: string;
  provider: WebSearchProviderId;
  error: WebItemError;
  cache: "miss" | "bypass";
  durationMs: number;
}

export type SearchOutcome = SearchSuccess | SearchFailure;

export interface FetchSuccess {
  ok: true;
  requestedUrl: string;
  finalUrl: string;
  title: string | null;
  mediaType: "html" | "text" | "json" | "pdf";
  extractor: "local" | "tavily";
  content: string;
  bytesDownloaded: number | null;
  redirectCount: number;
  cache: "hit" | "miss" | "bypass";
  durationMs: number;
  originalChars: number;
  originalLines: number;
  truncated: boolean;
  cachePath: string | null;
}

export interface FetchFailure {
  ok: false;
  requestedUrl: string;
  error: WebItemError;
  cache: "miss" | "bypass";
  durationMs: number;
}

export type FetchOutcome = FetchSuccess | FetchFailure;
