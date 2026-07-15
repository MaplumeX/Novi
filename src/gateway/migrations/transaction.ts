import { randomBytes } from "node:crypto";
import { lstat, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import {
  copyGatewayBackupPayload,
  verifyGatewayBackup,
  type GatewayBackupManifest,
} from "./backup.js";
import type { GatewayStateDescriptor } from "./types.js";

export interface RestoreFaultHooks {
  beforePublish?: (logicalId: string, index: number) => void | Promise<void>;
  afterPublish?: (logicalId: string, index: number) => void | Promise<void>;
}

/** Restore present/absent roots transactionally, compensating every caught publish failure. */
export async function restoreGatewayBackup(
  backupDir: string,
  registry: GatewayStateDescriptor[],
  hooks: RestoreFaultHooks = {},
): Promise<GatewayBackupManifest> {
  const manifest = await verifyGatewayBackup(backupDir);
  assertBackupMatchesRegistry(manifest, registry);
  const suffix = `${process.pid}.${randomBytes(6).toString("hex")}`;
  const prepared: Array<{
    descriptor: GatewayStateDescriptor;
    existed: boolean;
    stage: string;
    quarantine: string;
    hadCurrent: boolean;
    published: boolean;
  }> = [];
  try {
    for (const descriptor of registry) {
      const root = manifest.roots.find(
        (candidate) => candidate.logicalId === descriptor.logicalId,
      )!;
      const stage = `${descriptor.path}.restore.${suffix}.tmp`;
      const quarantine = `${descriptor.path}.restore.${suffix}.old`;
      await assertSafeCurrent(descriptor);
      await mkdir(path.dirname(descriptor.path), { recursive: true, mode: 0o700 });
      if (root.existed) await copyGatewayBackupPayload(backupDir, root, stage);
      prepared.push({
        descriptor,
        existed: root.existed,
        stage,
        quarantine,
        hadCurrent: await exists(descriptor.path),
        published: false,
      });
    }
    for (let index = 0; index < prepared.length; index++) {
      const entry = prepared[index]!;
      await hooks.beforePublish?.(entry.descriptor.logicalId, index);
      if (entry.hadCurrent) await rename(entry.descriptor.path, entry.quarantine);
      try {
        if (entry.existed) await rename(entry.stage, entry.descriptor.path);
        entry.published = true;
      } catch (error) {
        if (entry.hadCurrent) await rename(entry.quarantine, entry.descriptor.path);
        throw error;
      }
      await hooks.afterPublish?.(entry.descriptor.logicalId, index);
    }
    await Promise.all(
      prepared.map((entry) => rm(entry.quarantine, { recursive: true, force: true })),
    );
    return manifest;
  } catch (error) {
    for (const entry of [...prepared].reverse()) {
      if (entry.published) {
        await rm(entry.descriptor.path, { recursive: true, force: true }).catch(() => undefined);
        if (entry.hadCurrent) {
          await rename(entry.quarantine, entry.descriptor.path).catch(() => undefined);
        }
      }
      await rm(entry.stage, { recursive: true, force: true }).catch(() => undefined);
    }
    throw error;
  } finally {
    await Promise.all(prepared.map((entry) => rm(entry.stage, { recursive: true, force: true })));
  }
}

export function assertBackupMatchesRegistry(
  manifest: GatewayBackupManifest,
  registry: GatewayStateDescriptor[],
): void {
  if (manifest.roots.length !== registry.length) throw new Error("backup registry size mismatch");
  for (const descriptor of registry) {
    const root = manifest.roots.find((candidate) => candidate.logicalId === descriptor.logicalId);
    if (
      !root ||
      root.originalPath !== descriptor.path ||
      root.kind !== descriptor.kind ||
      root.schema !== descriptor.schema
    ) {
      throw new Error(`backup root is not approved by this invocation: ${descriptor.logicalId}`);
    }
  }
}

async function assertSafeCurrent(descriptor: GatewayStateDescriptor): Promise<void> {
  try {
    const stats = await lstat(descriptor.path);
    if (stats.isSymbolicLink())
      throw new Error(`restore refuses symbolic link: ${descriptor.path}`);
    if (
      (descriptor.kind === "file" && !stats.isFile()) ||
      (descriptor.kind === "directory" && !stats.isDirectory())
    ) {
      throw new Error(`restore state kind mismatch: ${descriptor.path}`);
    }
  } catch (error) {
    if (readErrorCode(error) !== "ENOENT") throw error;
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (readErrorCode(error) === "ENOENT") return false;
    throw error;
  }
}

function readErrorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}
