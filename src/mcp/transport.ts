/** Create MCP client transports from resolved server configs. */

import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { extractWWWAuthenticateParams } from "@modelcontextprotocol/sdk/client/auth.js";
import type { FetchLike, Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpOAuthChallenge, McpOAuthCredentialSnapshot } from "./oauth/coordinator.js";
import { isHttpServerConfig, isStdioServerConfig, type McpServerConfig } from "./types.js";

export interface CreateMcpTransportOptions {
  /** Workspace cwd used when a stdio server does not set its own cwd. */
  workspaceCwd?: string;
  oauthCredential?: McpOAuthCredentialSnapshot;
  challengeRecorder?: McpOAuthChallengeRecorder;
  fetch?: FetchLike;
}

/** Per-transport sanitized view of the latest HTTP Bearer challenge. */
export class McpOAuthChallengeRecorder {
  private challenge?: McpOAuthChallenge;

  record(response: Response): void {
    if (response.status !== 401 && response.status !== 403) return;
    const parsed = extractWWWAuthenticateParams(response);
    const header = response.headers.get("www-authenticate") ?? "";
    if (!/\bBearer\b/i.test(header)) return;
    this.challenge = {
      status: response.status,
      resourceMetadataUrl: parsed.resourceMetadataUrl,
      scope: parsed.scope,
      error: parsed.error,
    };
  }

  latest(): McpOAuthChallenge | undefined {
    return this.challenge ? { ...this.challenge } : undefined;
  }

  take(): McpOAuthChallenge | undefined {
    const challenge = this.latest();
    this.challenge = undefined;
    return challenge;
  }
}

/**
 * Build a transport for a fully placeholder-resolved server config.
 *
 * stdio: spawns `command` with args/env; stderr is piped for bounded diagnostics.
 * HTTP: Streamable HTTP with optional headers.
 */
export function createMcpTransport(
  config: McpServerConfig,
  options: CreateMcpTransportOptions = {},
): Transport {
  if (isStdioServerConfig(config)) {
    return new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: config.env,
      cwd: config.cwd ?? options.workspaceCwd,
      stderr: "pipe",
    });
  }
  if (isHttpServerConfig(config)) {
    const headers = { ...(config.headers ?? {}) };
    if (options.oauthCredential?.accessToken) {
      headers.Authorization = `Bearer ${options.oauthCredential.accessToken}`;
    }
    const baseFetch = options.fetch ?? globalThis.fetch;
    const fetch: FetchLike | undefined = options.challengeRecorder
      ? async (url, init) => {
          const response = await baseFetch(url, init);
          options.challengeRecorder!.record(response);
          return response;
        }
      : options.fetch;
    return new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: Object.keys(headers).length > 0 ? { headers } : undefined,
      ...(fetch ? { fetch } : {}),
    });
  }
  throw new Error("unsupported MCP server transport config");
}
