export const NOVI_GATEWAY_UNIT = "novi-gateway.service";
export const SYSTEMD_MANIFEST_VERSION = 1;

export interface GatewayServiceSpec {
  nodePath: string;
  cliPath: string;
  cwd: string;
  noviHome: string;
  configPath?: string;
  environmentFile?: string;
}

export interface GatewayServiceManifest {
  version: 1;
  unitName: typeof NOVI_GATEWAY_UNIT;
  unitPath: string;
  unitSha256: string;
  installedAt: string;
  argv: string[];
  cwd: string;
  noviHome: string;
  configPath?: string;
  environmentFile?: string;
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CommandRunner {
  run(command: string, args: string[], options?: { inherit?: boolean }): Promise<CommandResult>;
}

export type GatewayServiceAction =
  "install" | "uninstall" | "start" | "stop" | "restart" | "enable" | "disable" | "status" | "logs";

export interface GatewayServiceStatus {
  version: 1;
  unit: typeof NOVI_GATEWAY_UNIT;
  activeState: string;
  subState: string;
  enabled: "enabled" | "disabled" | "unknown";
  linger: "enabled" | "disabled" | "unknown";
  runtimeState: string;
  health: "ready" | "degraded" | "not-ready" | "stopped";
}
