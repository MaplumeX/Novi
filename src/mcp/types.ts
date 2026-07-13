/** MCP server config, plan, and approval types (config/approval domain only). */

export type McpStdioServerConfig = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
};

export type McpHttpServerConfig = {
  url: string;
  headers?: Record<string, string>;
};

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;

export interface McpConfigFile {
  mcpServers?: Record<string, McpServerConfig>;
}

export type McpServerOrigin = "user" | "project";

export interface ResolvedMcpServerDeclaration {
  name: string;
  origin: McpServerOrigin;
  /** Present when the server config is structurally valid. */
  config?: McpServerConfig;
  fingerprint: string;
  diagnostics: string[];
  invalid: boolean;
  reason?: string;
}

export type McpApprovalDecision = "approved" | "denied";

export interface McpApprovalEntry {
  serverName: string;
  fingerprint: string;
  decision: McpApprovalDecision;
  origin: McpServerOrigin;
  /** Absolute normalized project root for project-scoped entries. */
  projectRoot?: string;
  updatedAt: string;
}

export interface McpApprovalFile {
  entries: McpApprovalEntry[];
}

export interface SetMcpApprovalInput {
  serverName: string;
  fingerprint: string;
  decision: McpApprovalDecision;
  origin: McpServerOrigin;
  /** Required when origin is `"project"`. Absolute or relative; stored normalized. */
  projectRoot?: string;
}

export type McpPlanEntryStatus = "connectable" | "pending" | "denied" | "invalid";

export interface McpPlanEntry {
  name: string;
  origin: McpServerOrigin;
  status: McpPlanEntryStatus;
  config?: McpServerConfig;
  fingerprint: string;
  reason?: string;
}

export interface McpPlan {
  entries: McpPlanEntry[];
  diagnostics: string[];
}

export interface McpDeclarationsResult {
  servers: ResolvedMcpServerDeclaration[];
  diagnostics: string[];
}

export function isStdioServerConfig(config: McpServerConfig): config is McpStdioServerConfig {
  return "command" in config && typeof (config as McpStdioServerConfig).command === "string";
}

export function isHttpServerConfig(config: McpServerConfig): config is McpHttpServerConfig {
  return "url" in config && typeof (config as McpHttpServerConfig).url === "string";
}
