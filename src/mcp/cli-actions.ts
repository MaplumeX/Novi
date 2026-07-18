import type { ExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { resolveMcpPlan } from "./plan.js";
import {
  McpOAuthCoordinator,
  resolveMcpOAuthTarget,
  type McpOAuthPublicStatus,
} from "./oauth/coordinator.js";
import { openAuthorizationUrl } from "./oauth/browser.js";
import { isHttpServerConfig } from "./types.js";

export interface RunMcpCliOptions {
  env: ExecutionEnv;
  cwd: string;
  args: readonly string[];
  envMap?: Record<string, string | undefined>;
  noOpen?: boolean;
  json?: boolean;
  signal?: AbortSignal;
  coordinator?: McpOAuthCoordinator;
  write(line: string): void;
}

/** Standalone operator commands; deliberately independent from model/bootstrap setup. */
export async function runMcpCli(options: RunMcpCliOptions): Promise<void> {
  const action = options.args[0] ?? "status";
  const serverName = options.args[1];
  const plan = await resolveMcpPlan(options.env, options.cwd);
  const coordinator = options.coordinator ?? new McpOAuthCoordinator();
  const envMap = options.envMap ?? { ...process.env };

  if (action === "status") {
    const names = serverName
      ? [serverName]
      : plan.entries
          .filter(
            (entry) =>
              entry.status === "connectable" && entry.config && isHttpServerConfig(entry.config),
          )
          .map((entry) => entry.name);
    const statuses = [];
    for (const name of names) {
      const target = resolveMcpOAuthTarget(plan, options.cwd, envMap, name);
      statuses.push(await coordinator.publicStatus(target));
    }
    options.write(
      options.json
        ? JSON.stringify({ servers: statuses })
        : statuses.map(formatStatus).join("\n") || "No connectable HTTP MCP servers.",
    );
    return;
  }

  if (!serverName) throw new Error(`novi mcp ${action} requires a server name`);
  const target = resolveMcpOAuthTarget(plan, options.cwd, envMap, serverName);
  if (action === "login" || action === "reauthorize") {
    await coordinator.login(target, {
      reauthorize: action === "reauthorize",
      signal: options.signal,
      onAuthorizationUrl: async (url) => {
        options.write(`Open this URL to authorize ${serverName}:\n${url.toString()}`);
        if (!options.noOpen && !(await openAuthorizationUrl(url))) {
          options.write("warning: failed to open the default browser; use the URL above");
        }
      },
    });
    options.write(`MCP server "${serverName}" authorized.`);
    return;
  }
  if (action === "logout") {
    const result = await coordinator.logout(target);
    options.write(`MCP server "${serverName}" logged out locally.`);
    if (result.revocationFailed) options.write(revocationWarning(serverName));
    return;
  }
  if (action === "reset-auth") {
    const result = await coordinator.resetAuth(target);
    options.write(`MCP server "${serverName}" OAuth state reset.`);
    if (result.revocationFailed) options.write(revocationWarning(serverName));
    return;
  }
  throw new Error("Usage: novi mcp status [server] | login|reauthorize|logout|reset-auth <server>");
}

function revocationWarning(serverName: string): string {
  return `warning: ${serverName} is logged out locally, but a server-side token may still be valid`;
}

function formatStatus(status: McpOAuthPublicStatus): string {
  const state = status.state.replaceAll("_", " ");
  const details = [
    status.grantType,
    status.registrationMode,
    status.issuer ? `issuer=${status.issuer}` : undefined,
    status.resource ? `resource=${status.resource}` : undefined,
    status.grantedScopes.length > 0 ? `scopes=${status.grantedScopes.join(" ")}` : undefined,
    status.pendingScopes.length > 0 ? `pending=${status.pendingScopes.join(" ")}` : undefined,
    status.expiresAt ? `expires=${status.expiresAt}` : undefined,
  ].filter(Boolean);
  return `${status.server}: ${state}${details.length > 0 ? ` (${details.join(", ")})` : ""}`;
}
