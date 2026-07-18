import { createHash } from "node:crypto";
import path from "node:path";
import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { McpPlanEntry, McpOAuthGrantType } from "../types.js";

export interface McpOAuthBindingIdentity {
  origin: "user" | "project";
  projectRoot?: string;
  serverName: string;
  serverFingerprint: string;
}

export type McpOAuthRegistrationMode = "pre_registered" | "cimd" | "dcr";

export interface McpOAuthRecordV1 {
  binding: McpOAuthBindingIdentity;
  resource?: string;
  issuer?: string;
  grantType: McpOAuthGrantType;
  registrationMode?: McpOAuthRegistrationMode;
  discovery?: OAuthDiscoveryState;
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  tokenObtainedAt?: string;
  grantedScopes: string[];
  pendingScopes: string[];
  generation: number;
  updatedAt: string;
}

export interface McpOAuthFileV1 {
  version: 1;
  records: Record<string, McpOAuthRecordV1>;
}

/** Build the declaration-scoped identity used by approval-adjacent OAuth state. */
export function createMcpOAuthBinding(
  entry: Pick<McpPlanEntry, "name" | "origin" | "fingerprint">,
  cwd: string,
): McpOAuthBindingIdentity {
  return {
    origin: entry.origin,
    ...(entry.origin === "project" ? { projectRoot: path.resolve(cwd) } : {}),
    serverName: entry.name,
    serverFingerprint: entry.fingerprint,
  };
}

/** Stable non-secret key for one exact MCP declaration identity. */
export function mcpOAuthBindingKey(binding: McpOAuthBindingIdentity): string {
  const canonical = JSON.stringify({
    origin: binding.origin,
    projectRoot: binding.projectRoot ?? null,
    serverName: binding.serverName,
    serverFingerprint: binding.serverFingerprint,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
