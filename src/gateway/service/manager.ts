import { lstat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { getNoviDir } from "../../config.js";
import { loadGatewayConfig } from "../config.js";
import { assertGatewayStateReady } from "../migrations/inspect.js";
import { createGatewayStateRegistry } from "../migrations/registry.js";
import { resolveGatewayRuntimePaths } from "../runtime/paths.js";
import { GatewayServiceInstaller } from "./installer.js";
import {
  readGatewayServiceStatus,
  serviceLifecycle,
  streamGatewayServiceLogs,
} from "./operations.js";
import { SpawnCommandRunner } from "./systemd.js";
import type { GatewayServiceAction } from "./types.js";

export interface RunGatewayServiceOptions {
  action: GatewayServiceAction;
  cwd: string;
  configPath?: string;
  environmentFile?: string;
  replace?: boolean;
  force?: boolean;
  noEnable?: boolean;
  noStart?: boolean;
  linger?: boolean;
  lines?: number;
  follow?: boolean;
  json?: boolean;
}

export async function runGatewayService(options: RunGatewayServiceOptions): Promise<void> {
  const runner = new SpawnCommandRunner();
  const noviHome = getNoviDir();
  const cwd = path.resolve(options.cwd);
  const configPath = options.configPath ? path.resolve(options.configPath) : undefined;
  const environmentFile = options.environmentFile
    ? path.resolve(options.environmentFile)
    : undefined;
  const unitPath = path.join(os.homedir(), ".config", "systemd", "user", "novi-gateway.service");
  const manifestPath = path.join(noviHome, "service", "systemd.json");
  const cliPath =
    options.action === "install" ? await compiledCliPath() : resolvedCompiledCliPath();
  const preflight = async (): Promise<void> => {
    const registry = await createGatewayStateRegistry({ noviDir: noviHome, cwd, configPath });
    await assertGatewayStateReady(registry, path.join(noviHome, "migrations", "active.json"));
    const env = new NodeExecutionEnv({ cwd, shellEnv: process.env });
    try {
      const loaded = await loadGatewayConfig(env, { filePath: configPath, cwd, trusted: false });
      if (loaded.warnings.length > 0) {
        throw new Error(`Gateway configuration preflight failed: ${loaded.warnings.join("; ")}`);
      }
      if (loaded.config.channels.length === 0) {
        throw new Error("Gateway configuration preflight found no channels");
      }
    } finally {
      await env.cleanup();
    }
  };
  const installer = new GatewayServiceInstaller({
    runner,
    spec: {
      nodePath: path.resolve(process.execPath),
      cliPath,
      cwd,
      noviHome,
      ...(configPath ? { configPath } : {}),
      ...(environmentFile ? { environmentFile } : {}),
    },
    unitPath,
    manifestPath,
    preflight,
  });

  if (options.action === "install") {
    const result = await installer.install({
      replace: options.replace,
      enable: !options.noEnable,
      start: !options.noStart,
      linger: options.linger,
    });
    writeResult(result, options.json);
    return;
  }
  if (options.action === "uninstall") {
    writeResult(await installer.uninstall(options.force), options.json);
    return;
  }
  if (options.action === "status") {
    writeResult(
      await readGatewayServiceStatus(runner, resolveGatewayRuntimePaths(process.env, noviHome)),
      options.json,
    );
    return;
  }
  if (options.action === "logs") {
    await streamGatewayServiceLogs(runner, options.lines ?? 200, options.follow === true);
    return;
  }
  await serviceLifecycle(runner, options.action, preflight);
  writeResult({ action: options.action, ok: true }, options.json);
}

async function compiledCliPath(): Promise<string> {
  const candidate = resolvedCompiledCliPath();
  try {
    const stats = await lstat(candidate);
    if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("not a regular file");
    return candidate;
  } catch {
    throw new Error(
      "systemd install requires the compiled Novi CLI; run npm run build or install a packaged release",
    );
  }
}

function resolvedCompiledCliPath(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../cli.js");
}

function writeResult(value: unknown, json = false): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(value)}\n`);
    return;
  }
  if (isStatus(value)) {
    process.stdout.write(
      [
        `systemd: ${value.activeState}/${value.subState} (${value.enabled})`,
        `runtime: ${value.runtimeState} (${value.health})`,
        `linger: ${value.linger}`,
      ].join("\n") + "\n",
    );
    return;
  }
  const record = value as Record<string, unknown>;
  const lines = [`service ${String(record.action)}: ok`];
  if (record.note) lines.push(String(record.note));
  if (record.linger) lines.push(`linger: ${String(record.linger)}`);
  process.stdout.write(`${lines.join("\n")}\n`);
}

function isStatus(value: unknown): value is Awaited<ReturnType<typeof readGatewayServiceStatus>> {
  return (
    typeof value === "object" && value !== null && "activeState" in value && "runtimeState" in value
  );
}
