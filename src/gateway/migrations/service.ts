import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { GatewayRuntimePaths } from "../runtime/paths.js";
import { createGatewayBackup, verifyGatewayBackup } from "./backup.js";
import { assertGatewayOffline } from "./guard.js";
import {
  createMigrationJournal,
  readMigrationJournal,
  writeMigrationJournal,
  type GatewayMigrationJournal,
} from "./journal.js";
import { inspectGatewayState, planGatewayMigration } from "./inspect.js";
import { migrateGatewayJson } from "./migrators.js";
import { assertBackupMatchesRegistry, restoreGatewayBackup } from "./transaction.js";
import type {
  GatewayMigrationPlan,
  GatewayStateDescriptor,
  GatewayStateInspection,
} from "./types.js";

export interface GatewayMigrationServiceOptions {
  registry: GatewayStateDescriptor[];
  backupsRoot: string;
  journalPath: string;
  runtimePaths: GatewayRuntimePaths;
  jobsRoot: string;
  cwd: string;
  now?: () => Date;
  hooks?: {
    afterPublish?: (logicalId: string, index: number) => void | Promise<void>;
  };
}

export interface GatewayMigrationResult {
  operation: "plan" | "migrate" | "recover" | "rollback";
  plan?: GatewayMigrationPlan;
  backupId?: string;
  restoredBackupId?: string;
  preRollbackBackupId?: string;
  dryRun?: boolean;
}

export class GatewayMigrationService {
  constructor(private readonly options: GatewayMigrationServiceOptions) {}

  async plan(dryRun = true): Promise<GatewayMigrationPlan> {
    return planGatewayMigration(await inspectGatewayState(this.options.registry), {
      dryRun,
      now: this.options.now,
    });
  }

  async migrate(dryRun = false): Promise<GatewayMigrationResult> {
    const plan = await this.plan(dryRun);
    assertMigratable(plan.inspections);
    if (dryRun || plan.steps.length === 0) return { operation: dryRun ? "plan" : "migrate", plan };
    await this.assertOffline();
    const backup = await createGatewayBackup(this.options.registry, this.backupOptions());
    const suffix = randomBytes(6).toString("hex");
    const journal: GatewayMigrationJournal = {
      formatVersion: 1,
      operation: "migrate",
      createdAt: this.now().toISOString(),
      backupId: backup.manifest.backupId,
      backupDir: backup.backupDir,
      steps: plan.steps.map((step) => ({
        logicalId: step.logicalId,
        schema: step.schema as "config" | "pairing",
        sourceVersion: step.sourceVersion,
        targetVersion: step.targetVersion,
        risk: step.risk,
        targetPath: step.path,
        stagingPath: `${step.path}.migrate.${process.pid}.${suffix}.tmp`,
        status: "pending",
      })),
    };
    await createMigrationJournal(this.options.journalPath, journal);
    try {
      for (let index = 0; index < plan.steps.length; index++) {
        const step = plan.steps[index]!;
        const entry = journal.steps[index]!;
        const output = migrateGatewayJson(step, await readFile(step.path, "utf8"));
        await writePrivateFile(entry.stagingPath, output);
        entry.status = "prepared";
        await writeMigrationJournal(this.options.journalPath, journal);
        await rename(entry.stagingPath, entry.targetPath);
        entry.status = "published";
        await writeMigrationJournal(this.options.journalPath, journal);
        await this.options.hooks?.afterPublish?.(entry.logicalId, index);
      }
      assertCurrent(await inspectGatewayState(this.options.registry));
      await rm(this.options.journalPath, { force: true });
      return { operation: "migrate", plan, backupId: backup.manifest.backupId };
    } catch (error) {
      if (isSimulatedCrash(error)) throw error;
      await restoreGatewayBackup(backup.backupDir, this.options.registry);
      await this.cleanupJournal(journal);
      throw error;
    }
  }

  async recover(): Promise<GatewayMigrationResult> {
    await this.assertOffline(true);
    const journal = await readMigrationJournal(this.options.journalPath);
    this.assertJournalScope(journal);
    await verifyGatewayBackup(journal.backupDir);
    await restoreGatewayBackup(journal.backupDir, this.options.registry);
    await this.cleanupJournal(journal);
    assertRecoverable(await inspectGatewayState(this.options.registry));
    return { operation: "recover", restoredBackupId: journal.backupId };
  }

  async rollback(backupId: string, dryRun = false): Promise<GatewayMigrationResult> {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(backupId)) throw new Error("invalid backup id");
    const requestedDir = path.join(this.options.backupsRoot, backupId);
    const requested = await verifyGatewayBackup(requestedDir);
    if (requested.backupId !== backupId) throw new Error("backup id does not match directory");
    assertBackupMatchesRegistry(requested, this.options.registry);
    if (dryRun) {
      return { operation: "rollback", restoredBackupId: backupId, dryRun: true };
    }
    await this.assertOffline();
    const pre = await createGatewayBackup(this.options.registry, this.backupOptions());
    const journal: GatewayMigrationJournal = {
      formatVersion: 1,
      operation: "rollback",
      createdAt: this.now().toISOString(),
      backupId: pre.manifest.backupId,
      backupDir: pre.backupDir,
      steps: [],
    };
    await createMigrationJournal(this.options.journalPath, journal);
    try {
      await restoreGatewayBackup(requestedDir, this.options.registry);
      assertRecoverable(await inspectGatewayState(this.options.registry));
      await rm(this.options.journalPath, { force: true });
      return {
        operation: "rollback",
        restoredBackupId: backupId,
        preRollbackBackupId: pre.manifest.backupId,
      };
    } catch (error) {
      if (isSimulatedCrash(error)) throw error;
      await restoreGatewayBackup(pre.backupDir, this.options.registry);
      await this.cleanupJournal(journal);
      throw error;
    }
  }

  private async assertOffline(allowJournal = false): Promise<void> {
    await assertGatewayOffline(this.options.runtimePaths, this.options.jobsRoot);
    if (allowJournal) return;
    try {
      await lstat(this.options.journalPath);
      throw new Error("an incomplete Gateway migration exists; run migrate --recover");
    } catch (error) {
      if (readErrorCode(error) !== "ENOENT") throw error;
    }
  }

  private async cleanupJournal(journal: GatewayMigrationJournal): Promise<void> {
    await Promise.all(journal.steps.map((step) => rm(step.stagingPath, { force: true })));
    await rm(this.options.journalPath, { force: true });
  }

  private backupOptions() {
    return { backupsRoot: this.options.backupsRoot, cwd: this.options.cwd, now: this.options.now };
  }

  private assertJournalScope(journal: GatewayMigrationJournal): void {
    const expectedBackupDir = path.join(this.options.backupsRoot, journal.backupId);
    if (journal.backupDir !== expectedBackupDir) {
      throw new Error("active migration journal backup is outside the approved backup root");
    }
    if (journal.operation === "rollback" && journal.steps.length !== 0) {
      throw new Error("rollback recovery journal must not contain migration steps");
    }
    const seen = new Set<string>();
    for (const step of journal.steps) {
      const descriptor = this.options.registry.find(
        (entry) =>
          entry.logicalId === step.logicalId &&
          entry.path === step.targetPath &&
          entry.schema === step.schema,
      );
      if (!descriptor || descriptor.kind !== "file") {
        throw new Error(
          `active migration step is outside the approved registry: ${step.logicalId}`,
        );
      }
      if (
        seen.has(step.logicalId) ||
        !step.stagingPath.startsWith(`${step.targetPath}.migrate.`) ||
        !step.stagingPath.endsWith(".tmp")
      ) {
        throw new Error(`active migration staging path is unsafe: ${step.logicalId}`);
      }
      seen.add(step.logicalId);
    }
  }

  private now(): Date {
    return (this.options.now ?? (() => new Date()))();
  }
}

export function simulatedMigrationCrash(message = "simulated migration crash"): Error {
  return Object.assign(new Error(message), { simulatedMigrationCrash: true });
}

function isSimulatedCrash(error: unknown): boolean {
  return (error as { simulatedMigrationCrash?: unknown } | null)?.simulatedMigrationCrash === true;
}
function assertMigratable(inspections: GatewayStateInspection[]): void {
  const blocked = inspections.find((item) =>
    ["future-unsupported", "corrupt"].includes(item.state),
  );
  if (blocked) throw new Error(`Gateway state ${blocked.state}: ${blocked.descriptor.path}`);
}
function assertCurrent(inspections: GatewayStateInspection[]): void {
  const blocked = inspections.find((item) => item.state !== "missing" && item.state !== "current");
  if (blocked) throw new Error(`migration validation failed: ${blocked.descriptor.path}`);
}
function assertRecoverable(inspections: GatewayStateInspection[]): void {
  const blocked = inspections.find((item) =>
    ["future-unsupported", "corrupt"].includes(item.state),
  );
  if (blocked) throw new Error(`restored state is ${blocked.state}: ${blocked.descriptor.path}`);
}
async function writePrivateFile(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await writeFile(filePath, content, { encoding: "utf8", mode: 0o600 });
  await chmod(filePath, 0o600);
  const handle = await open(filePath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
function readErrorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}
