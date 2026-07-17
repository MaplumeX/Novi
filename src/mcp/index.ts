/** Public MCP domain API: config/approval + client/transport/adapter. */

export type {
  McpApprovalDecision,
  McpApprovalEntry,
  McpApprovalFile,
  McpConfigFile,
  McpDeclarationsResult,
  McpHttpServerConfig,
  McpPlan,
  McpPlanEntry,
  McpPlanEntryStatus,
  McpServerConfig,
  McpServerOrigin,
  McpStdioServerConfig,
  ResolvedMcpServerDeclaration,
  SetMcpApprovalInput,
} from "./types.js";

export { isHttpServerConfig, isStdioServerConfig } from "./types.js";

export {
  computeServerFingerprint,
  getProjectMcpConfigPrimaryPath,
  getProjectMcpConfigSecondaryPath,
  getUserMcpConfigPath,
  loadMcpConfig,
  loadMcpDeclarations,
  resolveEnvPlaceholders,
  resolveServerConfigPlaceholders,
  validateServerEntry,
} from "./config.js";

export {
  findMcpApproval,
  getMcpApprovalsPath,
  listMcpApprovals,
  loadMcpApprovals,
  setMcpApproval,
} from "./approval.js";

export { resolveMcpPlan } from "./plan.js";

export { createMcpTransport, type CreateMcpTransportOptions } from "./transport.js";

export {
  DEFAULT_MCP_CALL_TIMEOUT_MS,
  DEFAULT_MCP_CONNECT_TIMEOUT_MS,
  DEFAULT_MCP_REFRESH_DEBOUNCE_MS,
  McpClientManager,
  type McpClientManagerOptions,
  type McpServerConnectionStatus,
  type McpServerRuntimeState,
  type McpTransportFactory,
} from "./client-manager.js";

export {
  MAX_MCP_CATALOG_BYTES,
  MAX_MCP_CATALOG_TOOLS,
  MAX_MCP_LIST_PAGES,
  MAX_MCP_TOOL_NAME_BYTES,
  assertMcpCatalogLimits,
  buildMcpCatalogSnapshot,
  buildMcpServerCatalogSnapshot,
  canonicalStringify,
  diffMcpCatalog,
  digestCanonical,
  markMcpCatalogDegraded,
  type BuildMcpServerCatalogInput,
  type McpCatalogChange,
  type McpCatalogHealth,
  type McpCatalogSnapshot,
  type McpCatalogToolEntry,
  type McpServerCatalogSnapshot,
  type McpTransportKind,
} from "./catalog.js";

export {
  adaptMcpTools,
  buildMcpToolName,
  createMcpToolDescriptor,
  mapMcpCapabilities,
  mapMcpRisk,
  mcpInputSchemaToTypeBox,
  mcpResultToPreview,
  resolveMcpPermissionIntents,
  sanitizeNamePart,
  type AdaptedMcpTool,
  type AdaptMcpToolsOptions,
  type CreateMcpToolDescriptorOptions,
} from "./tool-adapter.js";
