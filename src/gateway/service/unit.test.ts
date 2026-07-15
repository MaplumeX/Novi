import { describe, expect, it } from "vitest";
import {
  createServiceManifest,
  diffUnits,
  escapeSystemdPath,
  renderGatewayUnit,
  validateServicePath,
} from "./unit.js";

describe("systemd Gateway unit renderer", () => {
  it("quotes special paths and contains the reliability contract", () => {
    const unit = renderGatewayUnit({
      nodePath: '/opt/Novi %/node "runtime"',
      cliPath: "/opt/Novi %/dist\\cli.js",
      cwd: "/home/user/My Project",
      noviHome: "/home/user/.novi%profile",
      configPath: "/home/user/config files/gateway.json",
      environmentFile: "/home/user/.config/novi env",
    });
    expect(unit).toContain('ExecStart="/opt/Novi %%/node \\"runtime\\""');
    expect(unit).toContain('"/opt/Novi %%/dist\\\\cli.js"');
    expect(unit).toContain("WorkingDirectory=/home/user/My\\x20Project");
    expect(unit).toContain("EnvironmentFile=/home/user/.config/novi\\x20env");
    expect(unit).toContain("Type=exec");
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("RestartSec=5s");
    expect(unit).toContain("TimeoutStopSec=60s");
    expect(unit).toContain("RuntimeDirectory=novi");
    expect(unit).toContain("RuntimeDirectoryMode=0700");
    expect(unit).toContain("KillSignal=SIGTERM");
    expect(unit).not.toContain("bot-token-secret");
  });

  it("rejects relative and control-character paths", () => {
    expect(() => validateServicePath("relative/node", "node")).toThrow(/absolute/);
    expect(() => validateServicePath("/tmp/bad\npath", "node")).toThrow(/control/);
    expect(() => validateServicePath("/tmp/bad\0path", "node")).toThrow(/control/);
  });

  it("escapes path directives without wrapping them in literal quotes", () => {
    expect(escapeSystemdPath('/tmp/a b\\c"d%')).toBe("/tmp/a\\x20b\\x5cc\\x22d%%");
  });

  it("keeps state bodies out of the manifest", () => {
    const spec = {
      nodePath: "/usr/bin/node",
      cliPath: "/opt/novi/dist/cli.js",
      cwd: "/work",
      noviHome: "/home/user/.novi",
    };
    const manifest = createServiceManifest(
      spec,
      "/home/user/.config/systemd/user/novi-gateway.service",
      renderGatewayUnit(spec),
    );
    expect(JSON.stringify(manifest)).not.toContain("bot-token-secret");
    expect(manifest.argv).toEqual([
      "/usr/bin/node",
      "/opt/novi/dist/cli.js",
      "--gateway",
      "--cwd",
      "/work",
    ]);
  });

  it("redacts secret-looking directives from replacement diffs", () => {
    const diff = diffUnits(
      "Environment=BOT_TOKEN=bot-token-secret\n",
      "Environment=NOVI_HOME=/safe\n",
    );
    expect(diff).not.toContain("bot-token-secret");
    expect(diff).toContain("<redacted>");
  });
});
