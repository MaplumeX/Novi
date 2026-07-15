import { lstat, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareGatewayRuntimeDir, resolveGatewayRuntimePaths } from "./paths.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "novi-runtime-paths-"));
  roots.push(root);
  return root;
}

describe("Gateway runtime paths", () => {
  it("uses the documented environment priority", () => {
    expect(
      resolveGatewayRuntimePaths(
        {
          NOVI_RUNTIME_DIR: "/explicit",
          RUNTIME_DIRECTORY: "/systemd",
          XDG_RUNTIME_DIR: "/xdg",
        },
        "/novi",
      ).runtimeDir,
    ).toBe("/explicit");
    expect(
      resolveGatewayRuntimePaths(
        { RUNTIME_DIRECTORY: "/systemd", XDG_RUNTIME_DIR: "/xdg" },
        "/novi",
      ).runtimeDir,
    ).toBe("/systemd");
    expect(resolveGatewayRuntimePaths({ XDG_RUNTIME_DIR: "/xdg" }, "/novi").runtimeDir).toBe(
      "/xdg/novi",
    );
    expect(resolveGatewayRuntimePaths({}, "/novi").runtimeDir).toBe("/novi/run");
  });

  it("rejects relative runtime directories", () => {
    expect(() => resolveGatewayRuntimePaths({ NOVI_RUNTIME_DIR: "relative" }, "/novi")).toThrow(
      /absolute path/,
    );
  });

  it("creates a private current-user directory and tightens its mode", async () => {
    const root = await tempRoot();
    const runtimeDir = path.join(root, "nested", "run");
    await prepareGatewayRuntimeDir(runtimeDir);
    const stats = await lstat(runtimeDir);

    expect(stats.isDirectory()).toBe(true);
    expect(stats.mode & 0o777).toBe(0o700);
    if (process.getuid !== undefined) expect(stats.uid).toBe(process.getuid());
  });

  it("refuses a symlink runtime directory", async () => {
    const root = await tempRoot();
    const target = path.join(root, "target");
    const link = path.join(root, "runtime");
    await prepareGatewayRuntimeDir(target);
    await symlink(target, link);

    await expect(prepareGatewayRuntimeDir(link)).rejects.toThrow(/not a safe directory/);
  });
});
