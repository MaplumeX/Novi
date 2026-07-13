import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent, EnvHttpProxyAgent, request as undiciRequest, type Dispatcher } from "undici";
import { WebToolError, throwIfAborted } from "./errors.js";
import { isPublicIp, parsePublicUrl } from "./urls.js";

export interface NetworkResponse {
  requestedUrl: string;
  finalUrl: string;
  status: number;
  headers: Record<string, string | string[]>;
  body: Uint8Array;
  redirectCount: number;
}

export interface NetworkOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxRedirects?: number;
  maxBytes?: number;
  headers?: Record<string, string>;
  /** Process environment used to resolve HTTP(S)_PROXY and NO_PROXY. */
  env?: NodeJS.ProcessEnv;
  resolve?: (hostname: string) => Promise<Array<{ address: string; family: 4 | 6 }>>;
  /** Request injection for deterministic network-policy tests; runtime leaves this unset. */
  request?: typeof undiciRequest;
}

async function resolvePublic(
  hostname: string,
  resolve?: NetworkOptions["resolve"],
): Promise<Array<{ address: string; family: 4 | 6 }>> {
  if (isIP(hostname)) {
    if (!isPublicIp(hostname))
      throw new WebToolError("PRIVATE_ADDRESS", `Blocked address: ${hostname}`);
    return [{ address: hostname, family: isIP(hostname) as 4 | 6 }];
  }
  let records: Array<{ address: string; family: 4 | 6 }>;
  try {
    records = resolve
      ? await resolve(hostname)
      : (await dnsLookup(hostname, { all: true, verbatim: true })).map((entry) => ({
          address: entry.address,
          family: entry.family as 4 | 6,
        }));
  } catch {
    throw new WebToolError("DNS_FAILURE", `DNS resolution failed for ${hostname}`, true);
  }
  if (records.length === 0)
    throw new WebToolError("DNS_FAILURE", `DNS returned no addresses for ${hostname}`, true);
  if (records.some((entry) => !isPublicIp(entry.address))) {
    throw new WebToolError(
      "PRIVATE_ADDRESS",
      `DNS for ${hostname} returned a private or non-public address`,
    );
  }
  return records;
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
  return await Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => reject(signal.reason ?? new DOMException("Aborted", "AbortError")),
        { once: true },
      );
    }),
  ]);
}

function pinnedAgent(records: Array<{ address: string; family: 4 | 6 }>): Agent {
  let cursor = 0;
  return new Agent({
    connect: {
      lookup: (_hostname, options, callback) => {
        const all = typeof options === "object" && options.all === true;
        if (all) {
          callback(null, records);
          return;
        }
        const entry = records[cursor++ % records.length];
        callback(null, entry.address, entry.family);
      },
    },
  });
}

function requestDispatcher(
  records: Array<{ address: string; family: 4 | 6 }>,
  env: NodeJS.ProcessEnv = process.env,
): Dispatcher {
  const httpProxy = env.http_proxy ?? env.HTTP_PROXY;
  const httpsProxy = env.https_proxy ?? env.HTTPS_PROXY;
  if (!httpProxy && !httpsProxy) return pinnedAgent(records);
  return new EnvHttpProxyAgent({
    httpProxy,
    httpsProxy,
    noProxy: env.no_proxy ?? env.NO_PROXY,
    connect: {
      lookup: (_hostname, options, callback) => {
        if (typeof options === "object" && options.all === true) {
          callback(null, records);
          return;
        }
        const entry = records[0];
        callback(null, entry.address, entry.family);
      },
    },
  });
}

async function consume(
  body: Dispatcher.ResponseData["body"],
  maxBytes: number,
): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of body) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) {
      body.destroy();
      throw new WebToolError("RESPONSE_TOO_LARGE", `Response exceeded ${maxBytes} bytes`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/** Guarded public HTTP request with DNS pinning, redirect revalidation, timeout, and byte caps. */
export async function guardedRequest(
  input: string,
  options: NetworkOptions = {},
): Promise<NetworkResponse> {
  const requestedUrl = parsePublicUrl(input).toString();
  const maxRedirects = options.maxRedirects ?? 3;
  const maxBytes = options.maxBytes ?? 25 * 1024 * 1024;
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 20_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let current = requestedUrl;
  let redirectCount = 0;
  while (true) {
    throwIfAborted(signal);
    const url = parsePublicUrl(current);
    let records: Array<{ address: string; family: 4 | 6 }>;
    try {
      records = await abortable(
        resolvePublic(url.hostname.replace(/^\[|\]$/g, ""), options.resolve),
        signal,
      );
    } catch (error) {
      if (signal.aborted) {
        if (options.signal?.aborted)
          throw options.signal.reason ?? new DOMException("Aborted", "AbortError");
        throw new WebToolError(
          "TIMEOUT",
          `Request timed out after ${options.timeoutMs ?? 20_000}ms`,
          true,
        );
      }
      throw error;
    }
    const dispatcher = requestDispatcher(records, options.env);
    try {
      const response = await (options.request ?? undiciRequest)(url, {
        dispatcher,
        method: "GET",
        signal,
        headers: {
          "user-agent": "Novi/0.0.0",
          accept:
            "text/html,application/xhtml+xml,application/json,text/plain,application/pdf;q=0.9,*/*;q=0.1",
          ...options.headers,
        },
        headersTimeout: options.timeoutMs ?? 20_000,
        bodyTimeout: options.timeoutMs ?? 20_000,
      });
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        response.body.destroy();
        if (redirectCount >= maxRedirects)
          throw new WebToolError("HTTP_ERROR", "Too many redirects");
        const location = response.headers.location;
        if (typeof location !== "string")
          throw new WebToolError("HTTP_ERROR", "Redirect response is missing Location");
        current = parsePublicUrl(new URL(location, url).toString()).toString();
        redirectCount++;
        continue;
      }
      const body = await consume(response.body, maxBytes);
      return {
        requestedUrl,
        finalUrl: current,
        status: response.statusCode,
        headers: Object.fromEntries(
          Object.entries(response.headers).filter(
            (entry): entry is [string, string | string[]] => entry[1] !== undefined,
          ),
        ),
        body,
        redirectCount,
      };
    } catch (error) {
      if (signal.aborted) {
        if (options.signal?.aborted)
          throw options.signal.reason ?? new DOMException("Aborted", "AbortError");
        throw new WebToolError(
          "TIMEOUT",
          `Request timed out after ${options.timeoutMs ?? 20_000}ms`,
          true,
        );
      }
      if (error instanceof WebToolError) throw error;
      throw new WebToolError(
        "HTTP_ERROR",
        error instanceof Error ? error.message : String(error),
        true,
      );
    } finally {
      await dispatcher.close();
    }
  }
}

export async function providerJsonRequest(
  url: string,
  init: {
    method?: "GET" | "POST";
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
    maxBytes?: number;
    env?: NodeJS.ProcessEnv;
    /** Request injection for deterministic proxy tests; runtime leaves this unset. */
    request?: typeof undiciRequest;
  },
): Promise<{ status: number; json: unknown }> {
  const timeout = AbortSignal.timeout(init.timeoutMs ?? 15_000);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  const env = init.env ?? process.env;
  const httpProxy = env.http_proxy ?? env.HTTP_PROXY;
  const httpsProxy = env.https_proxy ?? env.HTTPS_PROXY;
  const dispatcher =
    httpProxy || httpsProxy
      ? new EnvHttpProxyAgent({
          httpProxy,
          httpsProxy,
          noProxy: env.no_proxy ?? env.NO_PROXY,
        })
      : undefined;
  try {
    const response = await (init.request ?? undiciRequest)(url, {
      method: init.method ?? "GET",
      headers: init.headers,
      body: init.body,
      signal,
      ...(dispatcher ? { dispatcher } : {}),
    });
    const bytes = await consume(response.body, init.maxBytes ?? 2 * 1024 * 1024);
    let json: unknown;
    try {
      json = JSON.parse(Buffer.from(bytes).toString("utf8"));
    } catch {
      throw new WebToolError("PROVIDER_ERROR", "Provider returned invalid JSON", true);
    }
    return { status: response.statusCode, json };
  } catch (error) {
    if (init.signal?.aborted) throw init.signal.reason ?? new DOMException("Aborted", "AbortError");
    if (signal.aborted) throw new WebToolError("TIMEOUT", "Provider request timed out", true);
    throw error;
  } finally {
    await dispatcher?.close();
  }
}
