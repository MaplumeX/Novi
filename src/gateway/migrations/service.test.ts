import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGatewayStateRegistry } from "./registry.js";
import { GatewayMigrationService, simulatedMigrationCrash } from "./service.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(crashAfter?: number) {
  const root = await mkdtemp(path.join(tmpdir(), "novi-migrate-"));
  roots.push(root);
  const noviDir = path.join(root, "home");
  const cwd = path.join(root, "project");
  await mkdir(noviDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
  const config = path.join(noviDir, "gateway.json");
  const pairing = path.join(noviDir, "gateway-pairing.json");
  await writeFile(config, '{"channels":[]}\n', { mode: 0o600 });
  await writeFile(pairing, '{"authorized":{},"pending":[]}\n', { mode: 0o600 });
  const registry = await createGatewayStateRegistry({ noviDir, cwd });
  const journalPath = path.join(noviDir, "migrations", "active.json");
  const service = new GatewayMigrationService({
    registry,
    backupsRoot: path.join(noviDir, "backups", "gateway"),
    journalPath,
    runtimePaths: {
      runtimeDir: path.join(root, "runtime"),
      socketPath: path.join(root, "runtime", "gateway.sock"),
    },
    jobsRoot: path.join(noviDir, "jobs"),
    cwd,
    hooks:
      crashAfter === undefined
        ? undefined
        : {
            afterPublish: (_id, index) => {
              if (index === crashAfter) throw simulatedMigrationCrash();
            },
          },
  });
  return { root, noviDir, config, pairing, journalPath, service, registry, cwd };
}

describe("Gateway migration service", () => {
  it("dry-run performs zero writes", async () => {
    const state = await fixture();
    const before = await treeHash(state.root);
    const result = await state.service.migrate(true);
    expect(result.plan?.steps).toHaveLength(2);
    expect(await treeHash(state.root)).toBe(before);
  });

  it("migrates legacy state and creates a verified backup", async () => {
    const state = await fixture();
    const result = await state.service.migrate();
    expect(JSON.parse(await readFile(state.config, "utf8"))).toMatchObject({ version: 1 });
    expect(JSON.parse(await readFile(state.pairing, "utf8"))).toMatchObject({ version: 1 });
    expect(result.backupId).toBeTruthy();
    await expect(lstat(state.journalPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("leaves a crash journal and recovers the complete pre-migration state", async () => {
    const state = await fixture(0);
    await expect(state.service.migrate()).rejects.toThrow("simulated migration crash");
    expect(JSON.parse(await readFile(state.config, "utf8"))).toMatchObject({ version: 1 });
    expect(await lstat(state.journalPath)).toBeTruthy();

    const recovery = new GatewayMigrationService({
      registry: state.registry,
      backupsRoot: path.join(state.noviDir, "backups", "gateway"),
      journalPath: state.journalPath,
      runtimePaths: {
        runtimeDir: path.join(state.root, "runtime"),
        socketPath: path.join(state.root, "runtime", "gateway.sock"),
      },
      jobsRoot: path.join(state.noviDir, "jobs"),
      cwd: state.cwd,
    });
    await recovery.recover();
    expect(JSON.parse(await readFile(state.config, "utf8"))).not.toHaveProperty("version");
    expect(JSON.parse(await readFile(state.pairing, "utf8"))).not.toHaveProperty("version");
    await expect(lstat(state.journalPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rollback restores absent roots and creates a pre-rollback backup", async () => {
    const state = await fixture();
    const migrated = await state.service.migrate();
    await writeFile(state.config, '{"version":1,"channels":[],"changed":true}\n');
    await rm(state.pairing);
    const result = await state.service.rollback(migrated.backupId!);
    expect(JSON.parse(await readFile(state.config, "utf8"))).not.toHaveProperty("version");
    expect(JSON.parse(await readFile(state.pairing, "utf8"))).not.toHaveProperty("version");
    expect(result.preRollbackBackupId).toBeTruthy();
  });

  it("rejects an active journal whose cleanup path escapes the registry", async () => {
    const state = await fixture(0);
    await expect(state.service.migrate()).rejects.toThrow("simulated migration crash");
    const journal = JSON.parse(await readFile(state.journalPath, "utf8")) as {
      steps: Array<{ stagingPath: string }>;
    };
    journal.steps[0]!.stagingPath = path.join(state.root, "unrelated.txt");
    await writeFile(state.journalPath, `${JSON.stringify(journal)}\n`, { mode: 0o600 });
    await expect(state.service.recover()).rejects.toThrow(/staging path is unsafe/);
  });
});

async function treeHash(root: string): Promise<string> {
  const hash = createHash("sha256");
  const visit = async (directory: string, relative = ""): Promise<void> => {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      const next = relative ? `${relative}/${entry.name}` : entry.name;
      const filePath = path.join(directory, entry.name);
      const stats = await lstat(filePath);
      hash.update(`${next}\0${stats.mode & 0o777}\0`);
      if (entry.isDirectory()) await visit(filePath, next);
      else hash.update(await readFile(filePath));
    }
  };
  await visit(root);
  return hash.digest("hex");
}
