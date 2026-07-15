import { createHash } from "node:crypto";
import path from "node:path";
import {
  NOVI_GATEWAY_UNIT,
  type GatewayServiceManifest,
  type GatewayServiceSpec,
} from "./types.js";

export function validateServicePath(value: string, label: string): string {
  if (!path.isAbsolute(value)) throw new Error(`${label} must be an absolute path`);
  if (hasControlCharacter(value)) throw new Error(`${label} contains a control character`);
  return path.resolve(value);
}

/** Quote one systemd token; percent is doubled to disable specifier expansion. */
export function quoteSystemd(value: string): string {
  if (hasControlCharacter(value)) throw new Error("systemd value contains a control character");
  return `"${value.replaceAll("%", "%%").replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/** Escape a path-valued directive without adding quotes that become path bytes. */
export function escapeSystemdPath(value: string): string {
  if (hasControlCharacter(value)) throw new Error("systemd path contains a control character");
  return value
    .replaceAll("%", "%%")
    .replaceAll("\\", "\\x5c")
    .replaceAll('"', "\\x22")
    .replaceAll(" ", "\\x20");
}

export function serviceArgv(spec: GatewayServiceSpec): string[] {
  const argv = [
    spec.nodePath,
    spec.cliPath,
    "--gateway",
    "--cwd",
    spec.cwd,
    ...(spec.configPath ? ["--config", spec.configPath] : []),
  ];
  return argv;
}

export function renderGatewayUnit(input: GatewayServiceSpec): string {
  const spec = validateGatewayServiceSpec(input);
  const lines = [
    "[Unit]",
    "Description=Novi personal agent gateway",
    "Wants=network-online.target",
    "After=network-online.target",
    "StartLimitIntervalSec=60",
    "StartLimitBurst=5",
    "",
    "[Service]",
    "Type=exec",
    `WorkingDirectory=${escapeSystemdPath(spec.cwd)}`,
    `Environment=${quoteSystemd(`NOVI_HOME=${spec.noviHome}`)}`,
    ...(spec.environmentFile ? [`EnvironmentFile=${escapeSystemdPath(spec.environmentFile)}`] : []),
    "RuntimeDirectory=novi",
    "RuntimeDirectoryMode=0700",
    `ExecStart=${serviceArgv(spec).map(quoteSystemd).join(" ")}`,
    "Restart=on-failure",
    "RestartSec=5s",
    "TimeoutStopSec=60s",
    "KillSignal=SIGTERM",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ];
  return lines.join("\n");
}

export function validateGatewayServiceSpec(input: GatewayServiceSpec): GatewayServiceSpec {
  return {
    nodePath: validateServicePath(input.nodePath, "Node executable"),
    cliPath: validateServicePath(input.cliPath, "compiled Novi CLI"),
    cwd: validateServicePath(input.cwd, "working directory"),
    noviHome: validateServicePath(input.noviHome, "NOVI_HOME"),
    ...(input.configPath
      ? { configPath: validateServicePath(input.configPath, "gateway config") }
      : {}),
    ...(input.environmentFile
      ? { environmentFile: validateServicePath(input.environmentFile, "environment file") }
      : {}),
  };
}

export function hashUnit(unit: string): string {
  return createHash("sha256").update(unit).digest("hex");
}

export function createServiceManifest(
  spec: GatewayServiceSpec,
  unitPath: string,
  unit: string,
  now = new Date(),
): GatewayServiceManifest {
  const safe = validateGatewayServiceSpec(spec);
  return {
    version: 1,
    unitName: NOVI_GATEWAY_UNIT,
    unitPath: validateServicePath(unitPath, "systemd unit"),
    unitSha256: hashUnit(unit),
    installedAt: now.toISOString(),
    argv: serviceArgv(safe),
    cwd: safe.cwd,
    noviHome: safe.noviHome,
    ...(safe.configPath ? { configPath: safe.configPath } : {}),
    ...(safe.environmentFile ? { environmentFile: safe.environmentFile } : {}),
  };
}

/** Bounded semantic diff containing only unit directives, never environment contents. */
export function diffUnits(current: string, candidate: string, maxLines = 40): string {
  const before = current.split("\n");
  const after = candidate.split("\n");
  const lines: string[] = [];
  const length = Math.max(before.length, after.length);
  for (let index = 0; index < length && lines.length < maxLines; index++) {
    if (before[index] === after[index]) continue;
    if (before[index] !== undefined) lines.push(`- ${bound(redactDirective(before[index]!))}`);
    if (after[index] !== undefined && lines.length < maxLines)
      lines.push(`+ ${bound(redactDirective(after[index]!))}`);
  }
  if (lines.length === maxLines) lines.push("… diff truncated");
  return lines.join("\n");
}

function redactDirective(value: string): string {
  if (
    /^(Environment|ExecStart|SetCredential|LoadCredential|PassEnvironment)=/i.test(value) ||
    /(token|secret|password|api[_-]?key)/i.test(value)
  ) {
    return `${value.split("=", 1)[0]}=<redacted>`;
  }
  return value;
}

function bound(value: string): string {
  return value.length <= 300 ? value : `${value.slice(0, 299)}…`;
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}
