/** Create MCP client transports from resolved server configs. */

import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  isHttpServerConfig,
  isStdioServerConfig,
  type McpServerConfig,
} from "./types.js";

export interface CreateMcpTransportOptions {
  /** Workspace cwd used when a stdio server does not set its own cwd. */
  workspaceCwd?: string;
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
    const headers = config.headers ? { ...config.headers } : undefined;
    return new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: headers ? { headers } : undefined,
    });
  }
  throw new Error("unsupported MCP server transport config");
}
