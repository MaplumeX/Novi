import path from "node:path";
import { access } from "node:fs/promises";
import * as Type from "typebox";
import type { AgentTool, ExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { getNoviDir } from "../config.js";
import { textResult } from "./shared.js";
import {
  configureWebCacheRetention,
  makeCacheKey,
  readCache,
  writeCache,
  writeDocument,
} from "./web/cache.js";
import { mapConcurrent } from "./web/concurrency.js";
import { WebToolError, toWebItemError } from "./web/errors.js";
import { extractHtml } from "./web/extractors/html.js";
import { extractJson } from "./web/extractors/json.js";
import { charsetFromContentType, classifyMedia, type MediaType } from "./web/extractors/media.js";
import { extractPdf } from "./web/extractors/pdf.js";
import { decodeText, normalizeText } from "./web/extractors/text.js";
import { guardedRequest, providerJsonRequest } from "./web/network.js";
import type { ContentFormat, FetchOutcome, FetchSuccess, WebToolOptions } from "./web/types.js";
import { canonicalUrl, parsePublicUrl } from "./web/urls.js";

const Parameters = Type.Object(
  {
    urls: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 10 }),
    format: Type.Optional(Type.Union([Type.Literal("markdown"), Type.Literal("text")])),
    max_chars_per_item: Type.Optional(Type.Integer({ minimum: 2000, maximum: 50000 })),
    force_refresh: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

interface CachedContent {
  requestedUrl: string;
  finalUrl: string;
  title: string | null;
  mediaType: MediaType;
  extractor: "local" | "tavily";
  content: string;
  bytesDownloaded: number | null;
  redirectCount: number;
  documentPath: string;
}

interface LocalResult {
  outcome: FetchOutcome;
  fallbackEligible: boolean;
}

export function createFetchContentTool(
  _env: ExecutionEnv,
  options: WebToolOptions = {},
): AgentTool<typeof Parameters> {
  const env = options.env ?? process.env;
  const cacheRoot = options.cacheRoot ?? path.join(getNoviDir(), "cache", "web");
  if (options.cacheRetention) configureWebCacheRetention(cacheRoot, options.cacheRetention);
  const ttlMs = clamp(options.fetchContent?.cacheTtlMinutes, 1, 24 * 60, 15) * 60_000;
  const timeoutMs = clamp(options.fetchContent?.timeoutSeconds, 1, 120, 20) * 1000;
  const concurrency = clamp(options.fetchContent?.concurrency, 1, 8, 4);
  const maxBytes = clamp(
    options.fetchContent?.maxResponseBytes,
    1024,
    25 * 1024 * 1024,
    25 * 1024 * 1024,
  );
  const maxRedirects = clamp(options.fetchContent?.maxRedirects, 0, 10, 3);
  if (options.fetchContent?.fallbackProvider === "tavily" && !env.TAVILY_API_KEY) {
    throw new Error("fetch_content: Tavily fallback requires TAVILY_API_KEY");
  }
  return {
    name: "fetch_content",
    label: "Fetch Content",
    description:
      "Fetch up to ten public HTML, text, JSON, or text-layer PDF URLs with ordered per-URL outcomes and deterministic continuation paths.",
    parameters: Parameters,
    execute: async (_id, params, signal) => {
      if (!Array.isArray(params.urls) || params.urls.length < 1 || params.urls.length > 10)
        throw new Error("fetch_content: urls must contain 1 to 10 items");
      const format = params.format ?? "markdown";
      const maxChars = params.max_chars_per_item ?? 20_000;
      if (!Number.isInteger(maxChars) || maxChars < 2000 || maxChars > 50_000)
        throw new Error("fetch_content: max_chars_per_item must be an integer from 2000 to 50000");
      const local = await mapConcurrent(
        params.urls,
        concurrency,
        (url) =>
          fetchOne(url, format, maxChars, Boolean(params.force_refresh), {
            cacheRoot,
            ttlMs,
            timeoutMs,
            maxBytes,
            maxRedirects,
            fallbackProvider: options.fetchContent?.fallbackProvider,
            env,
            signal,
          }),
        signal,
      );
      if (options.fetchContent?.fallbackProvider === "tavily") {
        await applyTavilyFallback(
          local,
          format,
          maxChars,
          cacheRoot,
          options.fetchContent?.fallbackProvider,
          env.TAVILY_API_KEY ?? "",
          env,
          timeoutMs,
          signal,
        );
      }
      const outcomes = local.map((entry) => entry.outcome);
      return textResult(render(outcomes), { format, outcomes });
    },
  };
}

async function fetchOne(
  input: string,
  format: ContentFormat,
  maxChars: number,
  forceRefresh: boolean,
  runtime: {
    cacheRoot: string;
    ttlMs: number;
    timeoutMs: number;
    maxBytes: number;
    maxRedirects: number;
    fallbackProvider?: "tavily";
    env: NodeJS.ProcessEnv;
    signal?: AbortSignal;
  },
): Promise<LocalResult> {
  const started = Date.now();
  const cacheState = forceRefresh ? ("bypass" as const) : ("miss" as const);
  try {
    const requestedUrl = canonicalUrl(input);
    const key = makeCacheKey("content", {
      url: requestedUrl,
      format,
      extractor: "local-first-v1",
      fallbackProvider: runtime.fallbackProvider ?? null,
    });
    if (!forceRefresh) {
      const cached = await readCache<CachedContent>(
        runtime.cacheRoot,
        "content",
        key,
        runtime.ttlMs,
      );
      if (isCachedContent(cached) && (await documentExists(cached.documentPath)))
        return {
          outcome: bound(cached, maxChars, "hit", Date.now() - started),
          fallbackEligible: false,
        };
    }
    const response = await guardedRequest(requestedUrl, {
      signal: runtime.signal,
      timeoutMs: runtime.timeoutMs,
      maxRedirects: runtime.maxRedirects,
      maxBytes: runtime.maxBytes,
      env: runtime.env,
    });
    if (response.status < 200 || response.status >= 300) {
      throw new WebToolError(
        "HTTP_ERROR",
        `HTTP ${response.status} for ${requestedUrl}`,
        response.status === 429 || response.status >= 500,
      );
    }
    const contentType = header(response.headers, "content-type");
    const mediaType = classifyMedia(contentType, response.body);
    if (
      mediaType !== "pdf" &&
      response.body.byteLength > Math.min(runtime.maxBytes, 5 * 1024 * 1024)
    ) {
      throw new WebToolError(
        "RESPONSE_TOO_LARGE",
        "HTML, text, and JSON responses are limited to 5 MiB",
      );
    }
    const charset = charsetFromContentType(contentType);
    const extracted = await extract(
      response.body,
      mediaType,
      charset,
      response.finalUrl,
      format,
      runtime.signal,
    );
    const documentPath = await writeDocument(runtime.cacheRoot, key, format, extracted.content);
    const cached: CachedContent = {
      requestedUrl,
      finalUrl: response.finalUrl,
      title: extracted.title,
      mediaType,
      extractor: "local",
      content: extracted.content,
      bytesDownloaded: response.body.byteLength,
      redirectCount: response.redirectCount,
      documentPath,
    };
    await writeCache(runtime.cacheRoot, "content", key, cached);
    return {
      outcome: bound(cached, maxChars, cacheState, Date.now() - started),
      fallbackEligible: false,
    };
  } catch (error) {
    if (runtime.signal?.aborted) throw error;
    const publicError = toWebItemError(error, "EXTRACTION_FAILED");
    return {
      outcome: {
        ok: false,
        requestedUrl: input,
        error: publicError,
        cache: cacheState,
        durationMs: Date.now() - started,
      },
      fallbackEligible:
        publicError.code === "EXTRACTION_FAILED" ||
        (publicError.code === "HTTP_ERROR" && /HTTP (401|403|429)/.test(publicError.message)),
    };
  }
}

async function extract(
  bytes: Uint8Array,
  mediaType: MediaType,
  charset: string,
  finalUrl: string,
  format: ContentFormat,
  signal?: AbortSignal,
): Promise<{ title: string | null; content: string }> {
  if (mediaType === "html")
    return extractHtml(decodeText(bytes, charset), finalUrl, format, signal);
  if (mediaType === "json") return { title: null, content: extractJson(bytes, charset) };
  if (mediaType === "pdf") return extractPdf(bytes, format, signal);
  return { title: null, content: normalizeText(decodeText(bytes, charset)) };
}

function bound(
  cached: CachedContent,
  maxChars: number,
  cache: FetchSuccess["cache"],
  durationMs: number,
): FetchSuccess {
  const truncated = cached.content.length > maxChars;
  let preview = cached.content;
  if (truncated) {
    const cut = cached.content.lastIndexOf("\n", maxChars);
    preview = cached.content.slice(0, cut > maxChars / 2 ? cut : maxChars);
    preview += `\n\n[Content truncated: ${cached.content.length} characters total. Full text: ${cached.documentPath}]`;
  }
  return {
    ok: true,
    requestedUrl: cached.requestedUrl,
    finalUrl: cached.finalUrl,
    title: cached.title,
    mediaType: cached.mediaType,
    extractor: cached.extractor,
    content: preview,
    bytesDownloaded: cached.bytesDownloaded,
    redirectCount: cached.redirectCount,
    cache,
    durationMs,
    originalChars: cached.content.length,
    originalLines: cached.content.split("\n").length,
    truncated,
    cachePath: cached.documentPath,
  };
}

async function applyTavilyFallback(
  entries: LocalResult[],
  format: ContentFormat,
  maxChars: number,
  cacheRoot: string,
  fallbackProvider: "tavily" | undefined,
  apiKey: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  const indexes = entries.flatMap((entry, index) => (entry.fallbackEligible ? [index] : []));
  if (indexes.length === 0) return;
  const urls = indexes.map((index) => {
    const outcome = entries[index].outcome;
    parsePublicUrl(outcome.requestedUrl);
    return outcome.requestedUrl;
  });
  let response: Awaited<ReturnType<typeof providerJsonRequest>>;
  try {
    response = await providerJsonRequest("https://api.tavily.com/extract", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ urls, extract_depth: "basic", format }),
      signal,
      timeoutMs,
      env,
    });
    if (response.status === 401 || response.status === 403)
      throw new WebToolError("PROVIDER_AUTH", "Tavily rejected the API key");
    if (response.status === 429)
      throw new WebToolError("PROVIDER_RATE_LIMIT", "Tavily rate limit exceeded", true);
    if (response.status < 200 || response.status >= 300)
      throw new WebToolError(
        "PROVIDER_ERROR",
        `Tavily returned HTTP ${response.status}`,
        response.status >= 500,
      );
  } catch (error) {
    if (signal?.aborted) throw error;
    const publicError = toWebItemError(error, "PROVIDER_ERROR");
    for (const index of indexes) {
      entries[index].outcome = {
        ok: false,
        requestedUrl: entries[index].outcome.requestedUrl,
        error: publicError,
        cache: failureCacheState(entries[index].outcome),
        durationMs: entries[index].outcome.durationMs,
      };
    }
    return;
  }
  const payload = response.json as {
    results?: Array<{ url?: string; raw_content?: string }>;
    failed_results?: Array<{ url?: string; error?: string }>;
  };
  const successes = new Map(
    (payload.results ?? [])
      .filter((item) => item.url && typeof item.raw_content === "string")
      .map((item) => [item.url as string, item.raw_content as string]),
  );
  const failures = new Map(
    (payload.failed_results ?? [])
      .filter((item) => item.url)
      .map((item) => [item.url as string, item.error ?? "Tavily extraction failed"]),
  );
  for (let offset = 0; offset < indexes.length; offset++) {
    const index = indexes[offset];
    const url = urls[offset];
    const content = successes.get(url);
    if (content === undefined) {
      entries[index].outcome = {
        ok: false,
        requestedUrl: url,
        error: {
          code: "PROVIDER_ERROR",
          message: failures.get(url) ?? "Tavily returned no result",
          retryable: true,
        },
        cache: failureCacheState(entries[index].outcome),
        durationMs: entries[index].outcome.durationMs,
      };
      continue;
    }
    const key = makeCacheKey("content", {
      url: canonicalUrl(url),
      format,
      extractor: "local-first-v1",
      fallbackProvider: fallbackProvider ?? null,
    });
    const normalized = normalizeText(content);
    const documentPath = await writeDocument(cacheRoot, key, format, normalized);
    const cached: CachedContent = {
      requestedUrl: url,
      finalUrl: url,
      title: null,
      mediaType: "html",
      extractor: "tavily",
      content: normalized,
      bytesDownloaded: null,
      redirectCount: 0,
      documentPath,
    };
    await writeCache(cacheRoot, "content", key, cached);
    entries[index].outcome = bound(
      cached,
      maxChars,
      failureCacheState(entries[index].outcome),
      entries[index].outcome.durationMs,
    );
  }
}

function header(headers: Record<string, string | string[]>, name: string): string {
  const value = headers[name];
  return Array.isArray(value) ? value.join(", ") : (value ?? "");
}

function render(outcomes: FetchOutcome[]): string {
  return outcomes
    .map((outcome, index) => {
      const heading = `## ${index + 1}. ${outcome.requestedUrl}`;
      if (!outcome.ok)
        return `${heading}\n\nError [${outcome.error.code}]: ${outcome.error.message}`;
      const metadata = `Final URL: ${outcome.finalUrl}\nExtractor: ${outcome.extractor}\nCache: ${outcome.cache}`;
      return `${heading}\n\n${metadata}\n\n${outcome.content}`;
    })
    .join("\n\n");
}

function clamp(value: number | undefined, min: number, max: number, fallback: number): number {
  return value === undefined || !Number.isFinite(value)
    ? fallback
    : Math.max(min, Math.min(max, Math.floor(value)));
}

async function documentExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function failureCacheState(outcome: FetchOutcome): "miss" | "bypass" {
  return outcome.cache === "bypass" ? "bypass" : "miss";
}

function isCachedContent(value: unknown): value is CachedContent {
  if (value === null || typeof value !== "object") return false;
  const entry = value as Partial<CachedContent>;
  return (
    typeof entry.requestedUrl === "string" &&
    typeof entry.finalUrl === "string" &&
    (entry.title === null || typeof entry.title === "string") &&
    ["html", "text", "json", "pdf"].includes(entry.mediaType ?? "") &&
    (entry.extractor === "local" || entry.extractor === "tavily") &&
    typeof entry.content === "string" &&
    typeof entry.redirectCount === "number" &&
    typeof entry.documentPath === "string"
  );
}
