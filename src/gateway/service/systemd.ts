import { spawn } from "node:child_process";
import type { CommandResult, CommandRunner } from "./types.js";

export class SpawnCommandRunner implements CommandRunner {
  async run(
    command: string,
    args: string[],
    options: { inherit?: boolean } = {},
  ): Promise<CommandResult> {
    return await new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        shell: false,
        stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
      child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
      child.once("error", reject);
      child.once("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    });
  }
}

export async function assertSystemdAvailable(runner: CommandRunner): Promise<void> {
  if (process.platform !== "linux")
    throw new Error("systemd user services are supported on Linux only");
  const version = await runner.run("systemctl", ["--version"]);
  if (version.code !== 0) throw commandError("systemctl --version", version);
  const match = /systemd\s+(\d+)/.exec(version.stdout);
  if (!match || Number(match[1]) < 240) {
    throw new Error("Novi requires systemd 240 or newer for user service management");
  }
  const bus = await runner.run("systemctl", ["--user", "show-environment"]);
  if (bus.code !== 0) {
    throw new Error(
      `systemd user manager is unavailable; log in with a user session or enable linger (${bounded(bus.stderr)})`,
    );
  }
}

export async function runSystemctl(
  runner: CommandRunner,
  args: string[],
  options: { allowFailure?: boolean; inherit?: boolean } = {},
): Promise<CommandResult> {
  const result = await runner.run("systemctl", ["--user", ...args], {
    inherit: options.inherit,
  });
  if (result.code !== 0 && !options.allowFailure) {
    throw commandError(`systemctl --user ${args.join(" ")}`, result);
  }
  return result;
}

export async function lingerState(
  runner: CommandRunner,
): Promise<"enabled" | "disabled" | "unknown"> {
  const uid = process.getuid?.();
  if (uid === undefined) return "unknown";
  const result = await runner.run("loginctl", [
    "show-user",
    String(uid),
    "-p",
    "Linger",
    "--value",
  ]);
  if (result.code !== 0) return "unknown";
  return result.stdout.trim() === "yes" ? "enabled" : "disabled";
}

export async function enableLinger(runner: CommandRunner): Promise<void> {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("cannot determine current uid for linger");
  const result = await runner.run("loginctl", ["enable-linger", String(uid)]);
  if (result.code !== 0) throw commandError("loginctl enable-linger", result);
}

function commandError(command: string, result: CommandResult): Error {
  return new Error(
    `${command} failed (${result.code}): ${bounded(result.stderr || result.stdout)}`,
  );
}

function bounded(value: string): string {
  const single = value.replace(/[\r\n]+/g, " ").trim();
  return single.length <= 500 ? single : `${single.slice(0, 499)}…`;
}
