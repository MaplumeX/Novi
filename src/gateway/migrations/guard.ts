import { connectGatewayControl } from "../runtime/control-client.js";
import type { GatewayRuntimePaths } from "../runtime/paths.js";
import { inspectSchedulerLock } from "../jobs/store.js";
import { lstat } from "node:fs/promises";

/** Fail closed unless both Gateway runtime and scheduler owner are confirmed stopped. */
export async function assertGatewayOffline(
  runtimePaths: GatewayRuntimePaths,
  jobsRoot: string,
): Promise<void> {
  const socketStats = await pathStats(runtimePaths.socketPath);
  if (socketStats !== undefined) {
    if (socketStats.isSymbolicLink() || !socketStats.isSocket()) {
      throw new Error("Gateway migration cannot prove the control socket is safe");
    }
    try {
      const socket = await connectGatewayControl(runtimePaths.socketPath, 500);
      socket.destroy();
      throw new Error("Gateway migration requires the running Gateway to stop first");
    } catch (error) {
      const code = readErrorCode(error);
      if (code !== "ENOENT" && code !== "ECONNREFUSED") throw error;
    }
  }
  const lock = await inspectSchedulerLock(jobsRoot);
  if (lock.state === "live") {
    throw new Error(`Gateway migration requires scheduler pid ${lock.pid} to stop first`);
  }
  if (lock.state === "invalid") {
    throw new Error("Gateway migration cannot prove scheduler ownership is stopped");
  }
}

async function pathStats(filePath: string) {
  try {
    return await lstat(filePath);
  } catch (error) {
    if (readErrorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

function readErrorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}
