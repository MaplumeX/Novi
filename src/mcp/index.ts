/** Public MCP config/approval domain API (no transport connect). */

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
