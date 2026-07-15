import { requestGatewayControl } from "../runtime/control-client.js";
import type { GatewayRuntimePaths } from "../runtime/paths.js";
import { assertSystemdAvailable, lingerState, runSystemctl } from "./systemd.js";
import { NOVI_GATEWAY_UNIT, type CommandRunner, type GatewayServiceStatus } from "./types.js";

export async function serviceLifecycle(
  runner: CommandRunner,
  action: "start" | "stop" | "restart" | "enable" | "disable",
  preflight: () => Promise<void>,
): Promise<void> {
  await assertSystemdAvailable(runner);
  if (action === "start" || action === "restart") await preflight();
  await runSystemctl(runner, [action, NOVI_GATEWAY_UNIT]);
}

export async function readGatewayServiceStatus(
  runner: CommandRunner,
  runtimePaths: GatewayRuntimePaths,
): Promise<GatewayServiceStatus> {
  await assertSystemdAvailable(runner);
  const shown = await runSystemctl(
    runner,
    ["show", NOVI_GATEWAY_UNIT, "--property=ActiveState,SubState"],
    { allowFailure: true },
  );
  const properties = Object.fromEntries(
    shown.stdout
      .trim()
      .split("\n")
      .map((line) => line.split("=", 2))
      .filter((entry) => entry.length === 2),
  );
  const activeState = properties.ActiveState || "unknown";
  const subState = properties.SubState || "unknown";
  const enabledResult = await runSystemctl(runner, ["is-enabled", NOVI_GATEWAY_UNIT], {
    allowFailure: true,
  });
  const enabled =
    enabledResult.stdout.trim() === "enabled"
      ? "enabled"
      : enabledResult.stdout.trim() === "disabled"
        ? "disabled"
        : "unknown";
  let runtimeState = "stopped";
  try {
    const response = await requestGatewayControl(
      { socketPath: runtimePaths.socketPath, timeoutMs: 1_000 },
      { id: `service-status-${process.pid}`, method: "status.get" },
    );
    if (response.ok && isObject(response.result) && typeof response.result.state === "string") {
      runtimeState = response.result.state;
    }
  } catch {
    // A missing runtime socket is represented as stopped in the merged status.
  }
  const health = deriveServiceHealth(runtimeState);
  return {
    version: 1,
    unit: NOVI_GATEWAY_UNIT,
    activeState,
    subState,
    enabled,
    linger: await lingerState(runner),
    runtimeState,
    health,
  };
}

export function deriveServiceHealth(runtimeState: string): GatewayServiceStatus["health"] {
  if (runtimeState === "ready") return "ready";
  if (runtimeState === "degraded") return "degraded";
  if (runtimeState === "stopped") return "stopped";
  return "not-ready";
}

export async function streamGatewayServiceLogs(
  runner: CommandRunner,
  lines: number,
  follow: boolean,
): Promise<void> {
  await assertSystemdAvailable(runner);
  if (!Number.isSafeInteger(lines) || lines < 1 || lines > 10_000) {
    throw new Error("service log lines must be an integer between 1 and 10000");
  }
  const result = await runner.run(
    "journalctl",
    [
      "--user",
      "-u",
      NOVI_GATEWAY_UNIT,
      "--no-pager",
      "--lines",
      String(lines),
      ...(follow ? ["--follow"] : []),
    ],
    { inherit: true },
  );
  if (result.code !== 0) throw new Error(`journalctl failed with exit code ${result.code}`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
