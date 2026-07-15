import { lstat } from "node:fs/promises";
import path from "node:path";
import type { GatewayStateDescriptor, GatewayStateRegistryOptions } from "./types.js";

/** Build the exact Gateway-owned state inventory; credentials and JSONL sessions are excluded. */
export async function createGatewayStateRegistry(
  options: GatewayStateRegistryOptions,
): Promise<GatewayStateDescriptor[]> {
  const candidates: GatewayStateDescriptor[] = [
    descriptor("config-global", path.join(options.noviDir, "gateway.json"), "config", "file"),
    ...(options.includeProject === false
      ? []
      : [
          descriptor(
            "config-project",
            path.join(options.cwd, ".novi", "gateway.json"),
            "config",
            "file",
          ),
        ]),
    ...(options.configPath === undefined
      ? []
      : [descriptor("config-explicit", path.resolve(options.configPath), "config", "file")]),
    descriptor("pairing", path.join(options.noviDir, "gateway-pairing.json"), "pairing", "file"),
    descriptor("sessions", path.join(options.noviDir, "gateway-sessions.json"), "sessions", "file"),
    descriptor("jobs", path.join(options.noviDir, "jobs"), "jobs", "directory"),
    descriptor("messages", path.join(options.noviDir, "gateway-messages"), "messages", "directory"),
  ];
  return deduplicate(candidates);
}

function descriptor(
  logicalId: string,
  filePath: string,
  schema: GatewayStateDescriptor["schema"],
  kind: GatewayStateDescriptor["kind"],
): GatewayStateDescriptor {
  if (!path.isAbsolute(filePath))
    throw new Error(`Gateway state path must be absolute: ${logicalId}`);
  return {
    logicalId,
    aliases: [],
    path: path.resolve(filePath),
    schema,
    kind,
    currentVersion: 1,
    excludedRootNames: schema === "jobs" ? ["scheduler.lock"] : [],
  };
}

async function deduplicate(
  candidates: GatewayStateDescriptor[],
): Promise<GatewayStateDescriptor[]> {
  const result: GatewayStateDescriptor[] = [];
  const byIdentity = new Map<string, GatewayStateDescriptor>();
  for (const candidate of candidates) {
    let identity = `path:${candidate.path}`;
    try {
      const stats = await lstat(candidate.path, { bigint: true });
      if (!stats.isSymbolicLink()) identity = `inode:${stats.dev}:${stats.ino}`;
    } catch (error) {
      if (readErrorCode(error) !== "ENOENT") throw error;
    }
    const existing = byIdentity.get(identity);
    if (existing) {
      existing.aliases.push(candidate.logicalId);
      continue;
    }
    byIdentity.set(identity, candidate);
    result.push(candidate);
  }
  return result;
}

function readErrorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}
