import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { GatewaySessionStore } from "../core/session-store.js";
import { JobStore } from "../jobs/store.js";
import { GatewayMessageStore } from "../messages/store.js";
import { decodePairingStore } from "../core/pairing-store.js";
import type {
  GatewayMigrationPlan,
  GatewayMigrationStep,
  GatewayStateDescriptor,
  GatewayStateInspection,
} from "./types.js";

export async function inspectGatewayState(
  registry: GatewayStateDescriptor[],
): Promise<GatewayStateInspection[]> {
  const inspections: GatewayStateInspection[] = [];
  for (const descriptor of registry) inspections.push(await inspectDescriptor(descriptor));
  return inspections;
}

export function planGatewayMigration(
  inspections: GatewayStateInspection[],
  options: { dryRun: boolean; now?: () => Date } = { dryRun: true },
): GatewayMigrationPlan {
  const steps: GatewayMigrationStep[] = inspections
    .filter((inspection) => inspection.state === "legacy-migratable")
    .map((inspection) => ({
      logicalId: inspection.descriptor.logicalId,
      schema: inspection.descriptor.schema,
      path: inspection.descriptor.path,
      sourceVersion: inspection.sourceVersion ?? 0,
      targetVersion: 1,
      risk: inspection.descriptor.schema === "pairing" ? "medium" : "low",
    }));
  return {
    version: 1,
    createdAt: (options.now ?? (() => new Date()))().toISOString(),
    dryRun: options.dryRun,
    backupRequired: steps.length > 0,
    fileCount: inspections.reduce((total, inspection) => total + inspection.fileCount, 0),
    estimatedBytes: inspections.reduce((total, inspection) => total + inspection.bytes, 0),
    inspections,
    steps,
  };
}

export async function assertGatewayStateReady(
  registry: GatewayStateDescriptor[],
  activeJournalPath: string,
): Promise<void> {
  if (await exists(activeJournalPath)) {
    throw new Error(
      `Gateway state migration is incomplete; run "novi --gateway migrate --recover" before starting`,
    );
  }
  const inspections = await inspectGatewayState(registry);
  const blocked = inspections.find(
    (inspection) => inspection.state !== "missing" && inspection.state !== "current",
  );
  if (!blocked) return;
  const guidance =
    blocked.state === "legacy-migratable"
      ? 'run "novi --gateway migrate --dry-run" then "novi --gateway migrate"'
      : "repair or restore the state before starting";
  throw new Error(`Gateway state ${blocked.state} at ${blocked.descriptor.path}; ${guidance}`);
}

async function inspectDescriptor(
  descriptor: GatewayStateDescriptor,
): Promise<GatewayStateInspection> {
  let stats;
  try {
    stats = await lstat(descriptor.path);
  } catch (error) {
    if (readErrorCode(error) === "ENOENT") return base(descriptor, "missing", 0, 0);
    return corrupt(descriptor, error);
  }
  if (stats.isSymbolicLink()) return corrupt(descriptor, new Error("symbolic links are forbidden"));
  if (descriptor.kind === "file" && !stats.isFile()) {
    return corrupt(descriptor, new Error("expected a regular file"));
  }
  if (descriptor.kind === "directory" && !stats.isDirectory()) {
    return corrupt(descriptor, new Error("expected a directory"));
  }

  const inventory = await countTree(descriptor).catch((error: unknown) => ({
    fileCount: 0,
    bytes: 0,
    error,
  }));
  if ("error" in inventory) return corrupt(descriptor, inventory.error);
  try {
    const sourceVersion = await validateSchema(descriptor);
    if (sourceVersion === 1) {
      return {
        ...base(descriptor, "current", inventory.fileCount, inventory.bytes),
        sourceVersion,
      };
    }
    if (
      sourceVersion === 0 &&
      (descriptor.schema === "config" || descriptor.schema === "pairing")
    ) {
      return {
        ...base(descriptor, "legacy-migratable", inventory.fileCount, inventory.bytes),
        sourceVersion,
      };
    }
    return {
      ...base(descriptor, "future-unsupported", inventory.fileCount, inventory.bytes),
      sourceVersion,
      reason: `unsupported schema version ${sourceVersion}`,
    };
  } catch (error) {
    return {
      ...corrupt(descriptor, error),
      fileCount: inventory.fileCount,
      bytes: inventory.bytes,
    };
  }
}

async function validateSchema(descriptor: GatewayStateDescriptor): Promise<number> {
  if (descriptor.schema === "config" || descriptor.schema === "pairing") {
    const parsed = parseJson(await readFile(descriptor.path, "utf8"));
    if (!isObject(parsed)) throw new Error(`${descriptor.schema} root must be an object`);
    const version = parsed.version;
    if (version === undefined) {
      if (descriptor.schema === "pairing") decodePairingStore({ ...parsed, version: 1 });
      return 0;
    }
    if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) {
      throw new Error(`${descriptor.schema} version is invalid`);
    }
    if (version === 1) {
      if (descriptor.schema === "pairing") decodePairingStore(parsed);
      return 1;
    }
    return version;
  }
  if (descriptor.schema === "sessions") {
    const parsed = parseJson(await readFile(descriptor.path, "utf8"));
    const version = readVersion(parsed, "sessions");
    if (version === 1) await GatewaySessionStore.open(descriptor.path);
    return version;
  }
  if (descriptor.schema === "jobs") {
    const storePath = path.join(descriptor.path, "store.json");
    let raw: string;
    try {
      raw = await readFile(storePath, "utf8");
    } catch (error) {
      if (readErrorCode(error) !== "ENOENT") throw error;
      const store = await JobStore.open(descriptor.path);
      await store.listRuns();
      return 1;
    }
    const parsed = parseJson(raw);
    const version = readVersion(parsed, "jobs");
    if (version === 1) {
      const store = await JobStore.open(descriptor.path);
      await store.listRuns();
    }
    return version;
  }
  const manifestPath = path.join(descriptor.path, "manifest.json");
  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf8");
  } catch (error) {
    if (readErrorCode(error) !== "ENOENT") throw error;
    await GatewayMessageStore.open(descriptor.path);
    return 1;
  }
  const parsed = parseJson(raw);
  const version = readVersion(parsed, "messages");
  if (version === 1) await GatewayMessageStore.open(descriptor.path);
  return version;
}

async function countTree(
  descriptor: GatewayStateDescriptor,
): Promise<{ fileCount: number; bytes: number }> {
  if (descriptor.kind === "file") {
    const stats = await lstat(descriptor.path);
    return { fileCount: 1, bytes: stats.size };
  }
  let fileCount = 0;
  let bytes = 0;
  const visit = async (directory: string, root = false): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (root && descriptor.excludedRootNames.includes(entry.name)) continue;
      const filePath = path.join(directory, entry.name);
      const stats = await lstat(filePath);
      if (stats.isSymbolicLink()) throw new Error(`symbolic link is forbidden: ${filePath}`);
      if (stats.isDirectory()) await visit(filePath);
      else if (stats.isFile()) {
        fileCount += 1;
        bytes += stats.size;
      } else throw new Error(`non-regular Gateway state entry: ${filePath}`);
    }
  };
  await visit(descriptor.path, true);
  return { fileCount, bytes };
}

function readVersion(value: unknown, label: string): number {
  if (
    !isObject(value) ||
    typeof value.version !== "number" ||
    !Number.isSafeInteger(value.version)
  ) {
    throw new Error(`${label} version is invalid`);
  }
  return value.version;
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Gateway state is not valid JSON");
  }
}

function base(
  descriptor: GatewayStateDescriptor,
  state: GatewayStateInspection["state"],
  fileCount: number,
  bytes: number,
): GatewayStateInspection {
  return { descriptor, state, targetVersion: 1, fileCount, bytes };
}

function corrupt(descriptor: GatewayStateDescriptor, error: unknown): GatewayStateInspection {
  return {
    ...base(descriptor, "corrupt", 0, 0),
    reason: error instanceof Error ? error.message : String(error),
  };
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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
