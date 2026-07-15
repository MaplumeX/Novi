import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertGatewayStateReady, inspectGatewayState, planGatewayMigration } from "./inspect.js";
import { createGatewayStateRegistry } from "./registry.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "novi-migration-inspect-"));
  roots.push(root);
  const noviDir = path.join(root, "home");
  const cwd = path.join(root, "project");
  await mkdir(path.join(cwd, ".novi"), { recursive: true });
  return { root, noviDir, cwd };
}

describe("Gateway state registry and inspectors", () => {
  it("deduplicates aliased config paths and excludes unrelated state", async () => {
    const { noviDir, cwd } = await fixture();
    await mkdir(noviDir, { recursive: true });
    const globalConfig = path.join(noviDir, "gateway.json");
    await writeFile(globalConfig, JSON.stringify({ version: 1 }), "utf8");
    const registry = await createGatewayStateRegistry({
      noviDir,
      cwd,
      configPath: globalConfig,
    });

    expect(registry.find((entry) => entry.logicalId === "config-global")?.aliases).toEqual([
      "config-explicit",
    ]);
    expect(registry.map((entry) => entry.path)).not.toContain(
      path.join(noviDir, "credentials.json"),
    );
    expect(registry.find((entry) => entry.schema === "jobs")?.excludedRootNames).toEqual([
      "scheduler.lock",
    ]);
  });

  it("classifies current, legacy, future, corrupt, and missing state", async () => {
    const { noviDir, cwd } = await fixture();
    await mkdir(noviDir, { recursive: true });
    await writeFile(path.join(noviDir, "gateway.json"), JSON.stringify({ channels: [] }), "utf8");
    await writeFile(
      path.join(noviDir, "gateway-pairing.json"),
      JSON.stringify({ version: 1, authorized: {}, pending: [] }),
      "utf8",
    );
    await writeFile(
      path.join(noviDir, "gateway-sessions.json"),
      JSON.stringify({ version: 2, bindings: {}, archives: [] }),
      "utf8",
    );
    await mkdir(path.join(noviDir, "jobs"), { recursive: true });
    await writeFile(path.join(noviDir, "jobs", "scheduler.lock"), "not migration state", "utf8");
    await mkdir(path.join(noviDir, "gateway-messages"), { recursive: true });
    await writeFile(path.join(noviDir, "gateway-messages", "manifest.json"), "{broken", "utf8");

    const inspections = await inspectGatewayState(
      await createGatewayStateRegistry({ noviDir, cwd }),
    );
    const states = Object.fromEntries(
      inspections.map((inspection) => [inspection.descriptor.logicalId, inspection.state]),
    );
    expect(states).toMatchObject({
      "config-global": "legacy-migratable",
      "config-project": "missing",
      pairing: "current",
      sessions: "future-unsupported",
      jobs: "current",
      messages: "corrupt",
    });
    expect(inspections.find((entry) => entry.descriptor.schema === "jobs")?.fileCount).toBe(0);
  });

  it("fails closed on a symlink and produces a body-free stable plan", async () => {
    const { root, noviDir, cwd } = await fixture();
    await mkdir(noviDir, { recursive: true });
    const secret = path.join(root, "secret.json");
    await writeFile(secret, JSON.stringify({ token: "super-secret" }), "utf8");
    await symlink(secret, path.join(noviDir, "gateway.json"));
    await writeFile(
      path.join(noviDir, "gateway-pairing.json"),
      JSON.stringify({ authorized: {}, pending: [] }),
      "utf8",
    );
    const inspections = await inspectGatewayState(
      await createGatewayStateRegistry({ noviDir, cwd }),
    );
    const plan = planGatewayMigration(inspections, {
      dryRun: true,
      now: () => new Date("2026-07-15T00:00:00.000Z"),
    });

    expect(inspections.find((entry) => entry.descriptor.logicalId === "config-global")?.state).toBe(
      "corrupt",
    );
    expect(plan.steps).toEqual([
      expect.objectContaining({ logicalId: "pairing", sourceVersion: 0, targetVersion: 1 }),
    ]);
    expect(JSON.stringify(plan)).not.toContain("super-secret");
    expect(await readFile(secret, "utf8")).toContain("super-secret");
    expect(await readdir(path.join(noviDir))).toHaveLength(2);
  });

  it("startup preflight rejects legacy state without writing", async () => {
    const { root, noviDir, cwd } = await fixture();
    await mkdir(noviDir, { recursive: true });
    await writeFile(path.join(noviDir, "gateway.json"), '{"channels":[]}\n', { mode: 0o640 });
    const before = await readdir(noviDir);
    const registry = await createGatewayStateRegistry({ noviDir, cwd });
    await expect(
      assertGatewayStateReady(registry, path.join(noviDir, "migrations", "active.json")),
    ).rejects.toThrow("novi --gateway migrate --dry-run");
    expect(await readdir(noviDir)).toEqual(before);
    expect(await readFile(path.join(noviDir, "gateway.json"), "utf8")).toBe('{"channels":[]}\n');
    expect(root).toBeTruthy();
  });
});
