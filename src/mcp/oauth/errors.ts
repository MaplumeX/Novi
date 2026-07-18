/** Stable public error codes for MCP OAuth boundaries. */
export type McpOAuthErrorCode =
  | "MCP_AUTH_REQUIRED"
  | "MCP_AUTH_SCOPE_REQUIRED"
  | "MCP_AUTH_DISABLED"
  | "MCP_AUTH_IN_PROGRESS"
  | "MCP_AUTH_CONFIG_INVALID"
  | "MCP_AUTH_STORE_INVALID"
  | "MCP_AUTH_DISCOVERY_FAILED"
  | "MCP_AUTH_REGISTRATION_UNAVAILABLE"
  | "MCP_AUTH_ENDPOINT_UNSAFE"
  | "MCP_AUTH_CALLBACK_INVALID"
  | "MCP_AUTH_TIMEOUT"
  | "MCP_AUTH_CANCELLED"
  | "MCP_AUTH_REVOKE_FAILED";

const MAX_PUBLIC_MESSAGE_LENGTH = 500;
const SECRET_KEY_RE =
  /(["']?(?:access_token|refresh_token|client_secret|authorization_code|code_verifier)["']?\s*[:=]\s*["']?)([^\s,"'&}]+)/gi;
const AUTH_RE = /\b(Bearer|Basic)\s+[^\s,;]+/gi;
const QUERY_SECRET_RE = /([?&](?:code|state|token|client_secret|code_verifier)=)[^&#\s]*/gi;

/** Remove OAuth credentials and unsafe response material before public projection. */
export function sanitizeMcpOAuthMessage(message: string): string {
  return message
    .replace(AUTH_RE, "$1 [redacted]")
    .replace(SECRET_KEY_RE, "$1[redacted]")
    .replace(QUERY_SECRET_RE, "$1[redacted]")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, MAX_PUBLIC_MESSAGE_LENGTH);
}

/** Encode an OAuth boundary failure through Novi's shared tool error channel. */
export function mcpOAuthError(code: McpOAuthErrorCode, message: string): Error {
  const safe = sanitizeMcpOAuthMessage(message) || "MCP OAuth operation failed";
  return new Error(`NOVI_ERROR:${code}:${safe}`);
}

/** Actionable non-secret guidance shared by CLI/TUI/runtime diagnostics. */
export function mcpOAuthGuidance(code: McpOAuthErrorCode, serverName: string): string {
  if (code === "MCP_AUTH_SCOPE_REQUIRED") {
    return `Run "novi mcp reauthorize ${serverName}" to grant the required scope`;
  }
  if (code === "MCP_AUTH_REQUIRED") {
    return `Run "novi mcp login ${serverName}" to authorize this server`;
  }
  return `Check MCP OAuth configuration for server "${serverName}"`;
}
