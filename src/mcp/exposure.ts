/** Pure direct/deferred projection for one committed MCP catalog snapshot. */

import type { ResolvedPermissions } from "../permissions/types.js";
import { resolveWholeToolPermission } from "../permissions/policy.js";
import type { McpExposureMode } from "../settings.js";
import { canonicalStringify } from "./catalog.js";
import type { McpCatalogSnapshot, McpCatalogToolEntry } from "./catalog.js";

export interface McpExposurePolicy {
  mode: McpExposureMode;
  directSchemaBytes: number;
  pinned: readonly string[];
  enabledTools?: Readonly<Record<string, boolean>>;
  enabledSources?: Readonly<Record<string, boolean>>;
  permissions?: ResolvedPermissions;
}

export interface McpExposureProjection {
  eligible: readonly McpCatalogToolEntry[];
  direct: readonly McpCatalogToolEntry[];
  deferred: readonly McpCatalogToolEntry[];
  proxiesActive: boolean;
  eligibleSchemaBytes: number;
  directSchemaBytes: number;
}

/** Compute a deterministic exposure projection without mutating catalog truth. */
export function projectMcpExposure(
  snapshot: McpCatalogSnapshot,
  policy: McpExposurePolicy,
): McpExposureProjection {
  const eligible = snapshot.tools.filter((entry) => isMcpEntryVisible(entry, policy));
  const eligibleSchemaBytes = sumSchemaBytes(eligible);
  let direct: McpCatalogToolEntry[];
  let proxiesActive: boolean;
  if (policy.mode === "direct") {
    direct = [...eligible];
    proxiesActive = false;
  } else if (policy.mode === "deferred") {
    direct = [];
    proxiesActive = snapshot.tools.length > 0;
  } else if (eligible.length === 0 && snapshot.tools.length > 0) {
    // Keep local search callable even when current policy filters every real
    // external tool; it returns an empty result without leaking metadata.
    direct = [];
    proxiesActive = true;
  } else if (eligibleSchemaBytes <= policy.directSchemaBytes) {
    direct = [...eligible];
    proxiesActive = false;
  } else {
    const pinned = new Set(policy.pinned);
    direct = eligible.filter((entry) => pinned.has(entry.publicName));
    proxiesActive = eligible.length > direct.length;
  }
  const directNames = new Set(direct.map((entry) => entry.publicName));
  const deferred = eligible.filter((entry) => !directNames.has(entry.publicName));
  return Object.freeze({
    eligible: Object.freeze([...eligible]),
    direct: Object.freeze(direct),
    deferred: Object.freeze(deferred),
    proxiesActive,
    eligibleSchemaBytes,
    directSchemaBytes: sumSchemaBytes(direct),
  });
}

/** Search and direct exposure use exactly the same static visibility predicate. */
export function isMcpEntryVisible(
  entry: McpCatalogToolEntry,
  policy: Pick<McpExposurePolicy, "enabledTools" | "enabledSources" | "permissions">,
): boolean {
  if (policy.enabledSources?.[entry.sourceId] === false) return false;
  if (policy.enabledTools?.[entry.publicName] === false) return false;
  if (
    policy.permissions &&
    resolveWholeToolPermission(policy.permissions, entry.descriptor).level === "deny"
  ) {
    return false;
  }
  return true;
}

export function mcpAgentToolSchemaBytes(entry: McpCatalogToolEntry): number {
  return Buffer.byteLength(
    canonicalStringify({
      name: entry.publicName,
      description:
        entry.protocolTool.description ??
        `MCP tool ${entry.protocolTool.name} from server ${entry.serverName}`,
      parameters: entry.protocolTool.inputSchema,
    }),
    "utf8",
  );
}

function sumSchemaBytes(entries: readonly McpCatalogToolEntry[]): number {
  return entries.reduce((total, entry) => total + mcpAgentToolSchemaBytes(entry), 0);
}
