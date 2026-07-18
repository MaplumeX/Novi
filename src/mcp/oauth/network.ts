import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { connect as tlsConnect } from "node:tls";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { Agent, fetch as undiciFetch } from "undici";
import { isPublicIp } from "../../tools/web/urls.js";
import { mcpOAuthError } from "./errors.js";

export interface McpOAuthFetchOptions {
  serverUrl: string | URL;
  fetch?: FetchLike;
  resolve?: (hostname: string) => Promise<string[]>;
  maxRedirects?: number;
  maxResponseBytes?: number;
}

const DEFAULT_MAX_OAUTH_RESPONSE_BYTES = 1024 * 1024;

/** HTTPS-only OAuth fetch with DNS trust-class checks and redirect revalidation. */
export function createMcpOAuthFetch(options: McpOAuthFetchOptions): FetchLike {
  const resolve = options.resolve ?? resolveHostname;
  const server = new URL(options.serverUrl);
  return async (input, init) => {
    let current = new URL(input);
    const serverPublic = (await resolveAndClassify(server.hostname, resolve)).isPublic;
    const maxRedirects = options.maxRedirects ?? 3;
    const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_OAUTH_RESPONSE_BYTES;
    for (let redirects = 0; ; redirects++) {
      const endpoint = await validateEndpoint(current, serverPublic, resolve);
      const response = options.fetch
        ? await options.fetch(current, { ...init, redirect: "manual" })
        : await pinnedFetch(current, init, endpoint.addresses, maxResponseBytes);
      if (![301, 302, 303, 307, 308].includes(response.status)) {
        return await boundedResponse(response, maxResponseBytes);
      }
      if (redirects >= maxRedirects) {
        throw mcpOAuthError("MCP_AUTH_ENDPOINT_UNSAFE", "OAuth endpoint redirected too many times");
      }
      const location = response.headers.get("location");
      if (!location) {
        throw mcpOAuthError("MCP_AUTH_ENDPOINT_UNSAFE", "OAuth redirect omitted Location");
      }
      await response.body?.cancel();
      current = new URL(location, current);
    }
  };
}

async function boundedResponse(response: Response, limit: number): Promise<Response> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    await response.body?.cancel();
    throw mcpOAuthError("MCP_AUTH_DISCOVERY_FAILED", "OAuth response exceeded the size limit");
  }
  if (!response.body) return response;

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw mcpOAuthError("MCP_AUTH_DISCOVERY_FAILED", "OAuth response exceeded the size limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export function validateLoopbackRedirect(url: string | URL): URL {
  const parsed = new URL(url);
  if (
    parsed.protocol !== "http:" ||
    parsed.hostname !== "127.0.0.1" ||
    parsed.username ||
    parsed.password ||
    parsed.hash
  ) {
    throw mcpOAuthError(
      "MCP_AUTH_ENDPOINT_UNSAFE",
      "OAuth callback must use http://127.0.0.1 without credentials or fragment",
    );
  }
  return parsed;
}

/** Validate an OAuth endpoint before it is used outside the guarded fetch path (for example, browser navigation). */
export async function validateMcpOAuthEndpoint(
  serverUrl: string | URL,
  endpointUrl: string | URL,
  resolve: (hostname: string) => Promise<string[]> = resolveHostname,
): Promise<URL> {
  const server = new URL(serverUrl);
  const endpoint = new URL(endpointUrl);
  const serverPublic = (await resolveAndClassify(server.hostname, resolve)).isPublic;
  await validateEndpoint(endpoint, serverPublic, resolve);
  return endpoint;
}

async function validateEndpoint(
  url: URL,
  serverPublic: boolean,
  resolve: (hostname: string) => Promise<string[]>,
): Promise<{ addresses: string[] }> {
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw mcpOAuthError(
      "MCP_AUTH_ENDPOINT_UNSAFE",
      "OAuth endpoints must use HTTPS without credentials or fragments",
    );
  }
  const endpoint = await resolveAndClassify(url.hostname, resolve);
  if (serverPublic !== endpoint.isPublic) {
    throw mcpOAuthError(
      "MCP_AUTH_ENDPOINT_UNSAFE",
      "MCP resources and OAuth endpoints must use the same network trust class",
    );
  }
  return { addresses: endpoint.addresses };
}

async function resolveAndClassify(
  hostname: string,
  resolve: (hostname: string) => Promise<string[]>,
): Promise<{ addresses: string[]; isPublic: boolean }> {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const addresses = isIP(normalized) ? [normalized] : await resolve(normalized);
  if (addresses.length === 0) {
    throw mcpOAuthError("MCP_AUTH_DISCOVERY_FAILED", `DNS returned no addresses for ${normalized}`);
  }
  const publicFlags = addresses.map(isPublicIp);
  if (publicFlags.some((value) => value !== publicFlags[0])) {
    throw mcpOAuthError(
      "MCP_AUTH_ENDPOINT_UNSAFE",
      `DNS for ${normalized} mixes public and private addresses`,
    );
  }
  return { addresses, isPublic: publicFlags[0] ?? false };
}

async function pinnedFetch(
  url: URL,
  init: RequestInit | undefined,
  addresses: string[],
  maxResponseBytes: number,
): Promise<Response> {
  let cursor = 0;
  const expectedHostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const dispatcher = new Agent({
    connect: (options, callback) => {
      const actualHostname = options.hostname.replace(/^\[|\]$/g, "").toLowerCase();
      if (actualHostname !== expectedHostname) {
        callback(new Error("OAuth connector hostname changed after validation"), null);
        return;
      }
      const address = addresses[cursor++ % addresses.length]!;
      const socket = tlsConnect({
        host: address,
        port: Number(options.port || 443),
        servername: expectedHostname,
        ALPNProtocols: ["http/1.1"],
      });
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (error) callback(error, null);
        else callback(null, socket);
      };
      socket.once("secureConnect", () => finish());
      socket.once("error", finish);
    },
  });
  try {
    const response = await undiciFetch(url, {
      ...(init as import("undici").RequestInit | undefined),
      redirect: "manual",
      dispatcher,
    });
    return await boundedResponse(response as unknown as Response, maxResponseBytes);
  } finally {
    await dispatcher.close();
  }
}

async function resolveHostname(hostname: string): Promise<string[]> {
  try {
    return (await dnsLookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);
  } catch {
    throw mcpOAuthError("MCP_AUTH_DISCOVERY_FAILED", `DNS resolution failed for ${hostname}`);
  }
}
