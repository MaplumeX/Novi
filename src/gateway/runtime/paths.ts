import { lstat, mkdir, chmod } from "node:fs/promises";
import path from "node:path";
import { getNoviDir } from "../../config.js";

export const GATEWAY_CONTROL_SOCKET_NAME = "gateway.sock";

export interface GatewayRuntimePaths {
  runtimeDir: string;
  socketPath: string;
}

/** Resolve the private Gateway runtime directory without mutating the filesystem. */
export function resolveGatewayRuntimePaths(
  env: NodeJS.ProcessEnv = process.env,
  noviDir = getNoviDir(),
): GatewayRuntimePaths {
  const explicit = nonEmpty(env.NOVI_RUNTIME_DIR);
  const systemd = nonEmpty(env.RUNTIME_DIRECTORY);
  const xdg = nonEmpty(env.XDG_RUNTIME_DIR);
  const runtimeDir =
    explicit ?? systemd ?? (xdg === undefined ? path.join(noviDir, "run") : path.join(xdg, "novi"));

  if (!path.isAbsolute(runtimeDir)) {
    throw new Error("Gateway runtime directory must be an absolute path");
  }
  return { runtimeDir, socketPath: path.join(runtimeDir, GATEWAY_CONTROL_SOCKET_NAME) };
}

/** Create and validate a current-user-only runtime directory. */
export async function prepareGatewayRuntimeDir(runtimeDir: string): Promise<void> {
  if (!path.isAbsolute(runtimeDir)) {
    throw new Error("Gateway runtime directory must be an absolute path");
  }

  await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  const before = await lstat(runtimeDir);
  if (before.isSymbolicLink() || !before.isDirectory()) {
    throw new Error("Gateway runtime path is not a safe directory");
  }
  const uid = process.getuid?.();
  if (uid !== undefined && before.uid !== uid) {
    throw new Error("Gateway runtime directory is not owned by the current user");
  }

  await chmod(runtimeDir, 0o700);
  const after = await lstat(runtimeDir);
  if (after.isSymbolicLink() || !after.isDirectory() || (after.mode & 0o077) !== 0) {
    throw new Error("Gateway runtime directory permissions are unsafe");
  }
  if (uid !== undefined && after.uid !== uid) {
    throw new Error("Gateway runtime directory ownership changed during setup");
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}
