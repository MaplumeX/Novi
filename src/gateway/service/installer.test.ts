import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayServiceInstaller, validateEnvironmentFile } from "./installer.js";
import type { CommandResult, CommandRunner } from "./types.js";

class FakeRunner implements CommandRunner {
  calls: Array<{ command: string; args: string[] }> = [];
  failNextMutation = false;
  async run(command: string, args: string[]): Promise<CommandResult> {
    this.calls.push({ command, args });
    const mutation = command === "systemctl" && args.includes("daemon-reload");
    if (mutation && this.failNextMutation) {
      this.failNextMutation = false;
      return { code: 1, stdout: "", stderr: "bus failure" };
    }
    if (command === "systemctl" && args[0] === "--version") {
      return { code: 0, stdout: "systemd 255 (255.4)\n", stderr: "" };
    }
    if (command === "loginctl" && args[0] === "show-user") {
      return { code: 0, stdout: "no\n", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  }
}

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "novi-systemd-"));
  roots.push(root);
  const nodePath = path.join(root, "bin", "node");
  const cliPath = path.join(root, "dist", "cli.js");
  const unitPath = path.join(root, ".config", "systemd", "user", "novi-gateway.service");
  const manifestPath = path.join(root, ".novi", "service", "systemd.json");
  await mkdir(path.dirname(nodePath), { recursive: true });
  await mkdir(path.dirname(cliPath), { recursive: true });
  await writeFile(nodePath, "node");
  await chmod(nodePath, 0o755);
  await writeFile(cliPath, "cli");
  const runner = new FakeRunner();
  const preflight = vi.fn(async () => undefined);
  const create = (cwd = root) =>
    new GatewayServiceInstaller({
      runner,
      spec: { nodePath, cliPath, cwd, noviHome: path.join(root, ".novi") },
      unitPath,
      manifestPath,
      preflight,
      now: () => new Date("2026-07-15T00:00:00.000Z"),
    });
  return { root, runner, preflight, create, unitPath, manifestPath };
}

describe("Gateway systemd installer", () => {
  it("installs, enables and starts with argv-only systemctl calls", async () => {
    const state = await fixture();
    const result = await state.create().install();
    expect(result).toMatchObject({ changed: true, installed: true, enabled: true, started: true });
    expect(state.preflight).toHaveBeenCalledOnce();
    expect(state.runner.calls).toContainEqual({
      command: "systemctl",
      args: ["--user", "daemon-reload"],
    });
    expect(state.runner.calls).toContainEqual({
      command: "systemctl",
      args: ["--user", "enable", "--now", "novi-gateway.service"],
    });
    expect((await lstat(state.unitPath)).mode & 0o777).toBe(0o644);
    expect((await lstat(state.manifestPath)).mode & 0o777).toBe(0o600);
  });

  it("is file-idempotent and rejects a changed candidate without mutation", async () => {
    const state = await fixture();
    await state.create().install({ enable: false, start: false });
    const original = await readFile(state.unitPath, "utf8");
    const daemonReloads = state.runner.calls.filter((call) =>
      call.args.includes("daemon-reload"),
    ).length;
    const identical = await state.create().install({ enable: false, start: false });
    expect(identical.changed).toBe(false);
    expect(state.runner.calls.filter((call) => call.args.includes("daemon-reload"))).toHaveLength(
      daemonReloads,
    );

    const beforeCalls = state.runner.calls.length;
    await expect(state.create(path.join(state.root, "different cwd")).install()).rejects.toThrow(
      /--replace/,
    );
    expect(await readFile(state.unitPath, "utf8")).toBe(original);
    expect(state.runner.calls.slice(beforeCalls).some((call) => call.args.includes("enable"))).toBe(
      false,
    );
  });

  it("keeps a published unit recoverable when daemon-reload fails", async () => {
    const state = await fixture();
    state.runner.failNextMutation = true;
    await expect(state.create().install()).rejects.toThrow(/daemon-reload failed/);
    expect(await readFile(state.unitPath, "utf8")).toContain("Type=exec");
    expect(JSON.parse(await readFile(state.manifestPath, "utf8"))).toMatchObject({ version: 1 });
  });

  it("does not publish or mutate systemd when preflight fails", async () => {
    const state = await fixture();
    state.preflight.mockRejectedValueOnce(new Error("schema preflight failed"));
    await expect(state.create().install()).rejects.toThrow("schema preflight failed");
    await expect(lstat(state.unitPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      state.runner.calls.some(
        (call) => call.command === "systemctl" && call.args[0] === "--user" && call.args.length > 2,
      ),
    ).toBe(false);
  });

  it("changes linger only when explicit and honors no-enable/no-start", async () => {
    const state = await fixture();
    await state.create().install({ enable: false, start: false, linger: true });
    expect(state.runner.calls).toContainEqual({
      command: "loginctl",
      args: ["enable-linger", String(process.getuid?.())],
    });
    expect(
      state.runner.calls.some(
        (call) => call.command === "systemctl" && ["enable", "start"].includes(call.args[1] ?? ""),
      ),
    ).toBe(false);
  });

  it("preserves modified units unless force is explicit and never changes linger", async () => {
    const state = await fixture();
    await state.create().install({ enable: false, start: false });
    await writeFile(state.unitPath, "[Unit]\nDescription=modified\n");
    await expect(state.create().uninstall()).rejects.toThrow(/modified or foreign/);
    expect(await readFile(state.unitPath, "utf8")).toContain("modified");
    const result = await state.create().uninstall(true);
    expect(result).toMatchObject({ removed: true, linger: "disabled" });
    expect(
      state.runner.calls.some(
        (call) => call.command === "loginctl" && call.args[0] === "disable-linger",
      ),
    ).toBe(false);
  });

  it("refuses symlink units even with force", async () => {
    const state = await fixture();
    await mkdir(path.dirname(state.unitPath), { recursive: true });
    const target = path.join(state.root, "foreign.service");
    await writeFile(target, "foreign");
    await symlink(target, state.unitPath);
    await expect(state.create().uninstall(true)).rejects.toThrow(/regular file/);
  });
});

describe("EnvironmentFile validation", () => {
  it("requires a private current-user regular file", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "novi-env-file-"));
    roots.push(root);
    const envFile = path.join(root, "gateway.env");
    await writeFile(envFile, "TOKEN=bot-token-secret\n", { mode: 0o600 });
    await expect(validateEnvironmentFile(envFile)).resolves.toBeUndefined();
    await chmod(envFile, 0o640);
    await expect(validateEnvironmentFile(envFile)).rejects.toThrow(/mode 0600/);
  });
});
