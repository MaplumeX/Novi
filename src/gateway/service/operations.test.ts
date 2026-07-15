import { describe, expect, it, vi } from "vitest";
import {
  deriveServiceHealth,
  readGatewayServiceStatus,
  serviceLifecycle,
  streamGatewayServiceLogs,
} from "./operations.js";
import type { CommandResult, CommandRunner } from "./types.js";

class FakeRunner implements CommandRunner {
  calls: Array<{ command: string; args: string[]; inherit?: boolean }> = [];
  async run(
    command: string,
    args: string[],
    options?: { inherit?: boolean },
  ): Promise<CommandResult> {
    this.calls.push({ command, args, inherit: options?.inherit });
    if (command === "systemctl" && args[0] === "--version") {
      return { code: 0, stdout: "systemd 255\n", stderr: "" };
    }
    if (command === "systemctl" && args.includes("show")) {
      return { code: 0, stdout: "ActiveState=active\nSubState=running\n", stderr: "" };
    }
    if (command === "systemctl" && args.includes("is-enabled")) {
      return { code: 0, stdout: "enabled\n", stderr: "" };
    }
    if (command === "loginctl") return { code: 0, stdout: "yes\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  }
}

describe("Gateway systemd operations", () => {
  it("preflights start/restart and uses fixed argv", async () => {
    for (const action of ["start", "restart", "stop", "enable", "disable"] as const) {
      const runner = new FakeRunner();
      const preflight = vi.fn(async () => undefined);
      await serviceLifecycle(runner, action, preflight);
      expect(preflight).toHaveBeenCalledTimes(action === "start" || action === "restart" ? 1 : 0);
      expect(runner.calls).toContainEqual({
        command: "systemctl",
        args: ["--user", action, "novi-gateway.service"],
        inherit: undefined,
      });
    }
  });

  it("bounds log lines and disables the pager", async () => {
    const runner = new FakeRunner();
    await streamGatewayServiceLogs(runner, 500, true);
    expect(runner.calls).toContainEqual({
      command: "journalctl",
      args: ["--user", "-u", "novi-gateway.service", "--no-pager", "--lines", "500", "--follow"],
      inherit: true,
    });
    await expect(streamGatewayServiceLogs(runner, 10_001, false)).rejects.toThrow(
      /between 1 and 10000/,
    );
  });

  it("distinguishes ready, degraded, stopped, and active-not-ready runtimes", () => {
    expect(deriveServiceHealth("ready")).toBe("ready");
    expect(deriveServiceHealth("degraded")).toBe("degraded");
    expect(deriveServiceHealth("stopped")).toBe("stopped");
    expect(deriveServiceHealth("starting")).toBe("not-ready");
    expect(deriveServiceHealth("unhealthy")).toBe("not-ready");
  });

  it("reports systemd active while the runtime socket is stopped", async () => {
    const runner = new FakeRunner();
    const status = await readGatewayServiceStatus(runner, {
      runtimeDir: "/tmp/novi-status-does-not-exist",
      socketPath: "/tmp/novi-status-does-not-exist/gateway.sock",
    });
    expect(status).toMatchObject({
      activeState: "active",
      subState: "running",
      enabled: "enabled",
      linger: "enabled",
      runtimeState: "stopped",
      health: "stopped",
    });
  });
});
