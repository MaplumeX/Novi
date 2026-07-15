import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGatewayBackup, decodeGatewayBackupManifest, verifyGatewayBackup } from "./backup.js";
import { createGatewayStateRegistry } from "./registry.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "novi-backup-"));
  roots.push(root);
  const noviDir = path.join(root, "home");
  const cwd = path.join(root, "project");
  const backupsRoot = path.join(noviDir, "backups", "gateway");
  await mkdir(path.join(cwd, ".novi"), { recursive: true });
  await mkdir(noviDir, { recursive: true });
  return { root, noviDir, cwd, backupsRoot };
}

describe("Gateway state backup", () => {
  it("publishes a verified private backup without leaking content into its manifest", async () => {
    const { noviDir, cwd, backupsRoot } = await fixture();
    const configPath = path.join(noviDir, "gateway.json");
    await writeFile(
      configPath,
      JSON.stringify({ version: 1, channels: [{ botToken: "super-secret-token" }] }),
      { mode: 0o640 },
    );
    await mkdir(path.join(noviDir, "jobs", "runs", "job-1"), { recursive: true, mode: 0o750 });
    await writeFile(path.join(noviDir, "jobs", "store.json"), JSON.stringify({ version: 1 }), {
      mode: 0o644,
    });
    await writeFile(path.join(noviDir, "jobs", "runs", "job-1", "run.json"), "run", {
      mode: 0o640,
    });
    await writeFile(path.join(noviDir, "jobs", "scheduler.lock"), "ephemeral", { mode: 0o600 });
    const registry = await createGatewayStateRegistry({ noviDir, cwd });

    const created = await createGatewayBackup(registry, {
      backupsRoot,
      cwd,
      now: () => new Date("2026-07-15T00:00:00.000Z"),
      randomId: () => "fixture",
      noviVersion: "1.2.3",
    });
    const verified = await verifyGatewayBackup(created.backupDir);
    const manifestText = await readFile(path.join(created.backupDir, "manifest.json"), "utf8");

    expect(verified).toMatchObject({ formatVersion: 1, noviVersion: "1.2.3" });
    expect(manifestText).not.toContain("super-secret-token");
    expect(
      await readFile(path.join(created.backupDir, "files", "config-global", "payload"), "utf8"),
    ).toContain("super-secret-token");
    expect(verified.items.some((item) => item.relativePath === "scheduler.lock")).toBe(false);
    expect((await lstat(created.backupDir)).mode & 0o777).toBe(0o700);
    expect((await lstat(path.join(created.backupDir, "manifest.json"))).mode & 0o777).toBe(0o600);
    expect(
      (await lstat(path.join(created.backupDir, "files", "config-global", "payload"))).mode & 0o777,
    ).toBe(0o600);
  });

  it("detects payload tampering and unsafe manifest traversal", async () => {
    const { noviDir, cwd, backupsRoot } = await fixture();
    await writeFile(path.join(noviDir, "gateway.json"), JSON.stringify({ version: 1 }), "utf8");
    const created = await createGatewayBackup(await createGatewayStateRegistry({ noviDir, cwd }), {
      backupsRoot,
      cwd,
      randomId: () => "tamper",
    });
    const payload = path.join(created.backupDir, "files", "config-global", "payload");
    await writeFile(payload, "tampered", "utf8");
    await expect(verifyGatewayBackup(created.backupDir)).rejects.toThrow(
      /size mismatch|hash mismatch/,
    );

    expect(() =>
      decodeGatewayBackupManifest({
        ...created.manifest,
        items: [{ ...created.manifest.items[0], relativePath: "../credentials.json" }],
      }),
    ).toThrow(/unsafe backup relative path/);
  });

  it("refuses symlinks and removes staging evidence", async () => {
    const { root, noviDir, cwd, backupsRoot } = await fixture();
    const target = path.join(root, "target.json");
    await writeFile(target, "secret", "utf8");
    await symlink(target, path.join(noviDir, "gateway.json"));

    await expect(
      createGatewayBackup(await createGatewayStateRegistry({ noviDir, cwd }), {
        backupsRoot,
        cwd,
        randomId: () => "symlink",
      }),
    ).rejects.toThrow(/symbolic link/);
    expect(await readdir(backupsRoot)).toEqual([]);
  });

  it("rejects a backup whose payload mode is widened", async () => {
    const { noviDir, cwd, backupsRoot } = await fixture();
    await writeFile(path.join(noviDir, "gateway.json"), JSON.stringify({ version: 1 }), {
      mode: 0o600,
    });
    const created = await createGatewayBackup(await createGatewayStateRegistry({ noviDir, cwd }), {
      backupsRoot,
      cwd,
      randomId: () => "mode",
    });
    const payload = path.join(created.backupDir, "files", "config-global", "payload");
    await chmod(payload, 0o644);
    await expect(verifyGatewayBackup(created.backupDir)).rejects.toThrow(/mode is too wide/);
  });
});
