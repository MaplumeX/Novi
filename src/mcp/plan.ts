import path from "node:path";
import type { ExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { findMcpApproval, loadMcpApprovals } from "./approval.js";
import { loadMcpDeclarations } from "./config.js";
import type { McpPlan, McpPlanEntry } from "./types.js";

/**
 * Resolve the current MCP connection plan for `cwd`.
 *
 * Status rules:
 * - invalid config → `invalid`
 * - user origin → `connectable` (approval not required for connection)
 * - project origin:
 *   - no matching approval / stale fingerprint → `pending`
 *   - approved + matching fingerprint → `connectable`
 *   - denied → `denied`
 */
export async function resolveMcpPlan(env: ExecutionEnv, cwd: string): Promise<McpPlan> {
  const absCwd = path.resolve(cwd);
  const { servers, diagnostics: declDiagnostics } = await loadMcpDeclarations(env, absCwd);
  const { file: approvals, diagnostics: approvalDiagnostics } = await loadMcpApprovals(env);
  const diagnostics = [...declDiagnostics, ...approvalDiagnostics];

  const entries: McpPlanEntry[] = servers.map((server) => {
    if (server.invalid || !server.config) {
      return {
        name: server.name,
        origin: server.origin,
        status: "invalid" as const,
        fingerprint: server.fingerprint,
        reason: server.reason ?? server.diagnostics[0] ?? "invalid MCP server config",
      };
    }

    if (server.origin === "user") {
      return {
        name: server.name,
        origin: server.origin,
        status: "connectable" as const,
        config: server.config,
        fingerprint: server.fingerprint,
        reason: "user servers do not require approval for connection",
      };
    }

    const match = findMcpApproval(approvals, {
      serverName: server.name,
      fingerprint: server.fingerprint,
      origin: "project",
      projectRoot: absCwd,
    });

    if (!match) {
      return {
        name: server.name,
        origin: server.origin,
        status: "pending" as const,
        config: server.config,
        fingerprint: server.fingerprint,
        reason: "project server awaiting approval",
      };
    }

    if (match.decision === "denied") {
      return {
        name: server.name,
        origin: server.origin,
        status: "denied" as const,
        config: server.config,
        fingerprint: server.fingerprint,
        reason: "project server denied",
      };
    }

    return {
      name: server.name,
      origin: server.origin,
      status: "connectable" as const,
      config: server.config,
      fingerprint: server.fingerprint,
    };
  });

  return { entries, diagnostics };
}
