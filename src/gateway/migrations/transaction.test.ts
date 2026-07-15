import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGatewayBackup } from "./backup.js";
import { createGatewayStateRegistry } from "./registry.js";
import { restoreGatewayBackup } from "./transaction.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "novi-restore-"));
  roots.push(root);
  const noviDir = path.join(root, "home");
  const cwd = path.join(root, "project");
  const backupsRoot = path.join(noviDir, "backups", "gateway");
  await mkdir(noviDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
  const config = path.join(noviDir, "gateway.json");
  const pairing = path.join(noviDir, "gateway-pairing.json");
  await writeFile(config, '{"version":1,"value":"old"}\n', { mode: 0o600 });
  const registry = await createGatewayStateRegistry({ noviDir, cwd });
  const backup = await createGatewayBackup(registry, { backupsRoot, cwd });
  return { registry, backup, config, pairing };
}

describe("Gateway backup restore transaction", () => {
  it("restores both originally present and absent roots", async () => {
    const { registry, backup, config, pairing } = await fixture();
    await writeFile(config, '{"version":1,"value":"new"}\n');
    await writeFile(pairing, '{"version":1,"authorized":{},"pending":[]}\n');
    await restoreGatewayBackup(backup.backupDir, registry);
    expect(await readFile(config, "utf8")).toContain('"old"');
    await expect(readFile(pairing, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("compensates failures after every publish boundary", async () => {
    for (let failIndex = 0; failIndex < 3; failIndex++) {
      const { registry, backup, config, pairing } = await fixture();
      await writeFile(config, `{"version":1,"value":"current-${failIndex}"}\n`);
      await writeFile(pairing, '{"version":1,"authorized":{"x":["y"]},"pending":[]}\n');
      const beforeConfig = await readFile(config, "utf8");
      const beforePairing = await readFile(pairing, "utf8");
      await expect(
        restoreGatewayBackup(backup.backupDir, registry, {
          afterPublish: (_id, index) => {
            if (index === failIndex) throw new Error("injected publish failure");
          },
        }),
      ).rejects.toThrow("injected publish failure");
      expect(await readFile(config, "utf8")).toBe(beforeConfig);
      expect(await readFile(pairing, "utf8")).toBe(beforePairing);
    }
  });

  it("rejects restoring into a registry with a changed path", async () => {
    const { registry, backup } = await fixture();
    const changed = registry.map((entry, index) =>
      index === 0 ? { ...entry, path: `${entry.path}.other` } : entry,
    );
    await expect(restoreGatewayBackup(backup.backupDir, changed)).rejects.toThrow(/not approved/);
  });
});
