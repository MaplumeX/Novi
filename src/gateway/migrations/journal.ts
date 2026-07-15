import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";

export type GatewayMigrationOperation = "migrate" | "rollback";
export interface GatewayMigrationJournal {
  formatVersion: 1;
  operation: GatewayMigrationOperation;
  createdAt: string;
  backupId: string;
  backupDir: string;
  steps: Array<{
    logicalId: string;
    schema: "config" | "pairing";
    sourceVersion: number;
    targetVersion: 1;
    risk: "low" | "medium";
    targetPath: string;
    stagingPath: string;
    status: "pending" | "prepared" | "published";
  }>;
}

export async function createMigrationJournal(
  journalPath: string,
  journal: GatewayMigrationJournal,
): Promise<void> {
  validateMigrationJournal(journal);
  await mkdir(path.dirname(journalPath), { recursive: true, mode: 0o700 });
  await chmod(path.dirname(journalPath), 0o700);
  const handle = await open(journalPath, "wx", 0o600).catch((error: unknown) => {
    if (readErrorCode(error) === "EEXIST") {
      throw new Error("an incomplete Gateway migration exists; run migrate --recover");
    }
    throw error;
  });
  try {
    await handle.writeFile(`${JSON.stringify(journal, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function writeMigrationJournal(
  journalPath: string,
  journal: GatewayMigrationJournal,
): Promise<void> {
  validateMigrationJournal(journal);
  const temporary = `${journalPath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(journal, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, journalPath);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function readMigrationJournal(journalPath: string): Promise<GatewayMigrationJournal> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(journalPath, "utf8"));
  } catch (error) {
    throw new Error(`cannot read active Gateway migration journal: ${errorMessage(error)}`);
  }
  return validateMigrationJournal(value);
}

export function validateMigrationJournal(value: unknown): GatewayMigrationJournal {
  if (!isObject(value) || value.formatVersion !== 1) throw new Error("invalid migration journal");
  if (value.operation !== "migrate" && value.operation !== "rollback") {
    throw new Error("invalid migration journal operation");
  }
  if (!safeId(value.backupId) || !absolute(value.backupDir) || !iso(value.createdAt)) {
    throw new Error("invalid migration journal metadata");
  }
  if (!Array.isArray(value.steps)) throw new Error("invalid migration journal steps");
  const steps = value.steps.map((raw) => {
    if (
      !isObject(raw) ||
      !safeId(raw.logicalId) ||
      (raw.schema !== "config" && raw.schema !== "pairing") ||
      !Number.isSafeInteger(raw.sourceVersion) ||
      (raw.sourceVersion as number) < 0 ||
      raw.targetVersion !== 1 ||
      (raw.risk !== "low" && raw.risk !== "medium") ||
      !absolute(raw.targetPath) ||
      !absolute(raw.stagingPath) ||
      !["pending", "prepared", "published"].includes(String(raw.status))
    ) {
      throw new Error("invalid migration journal step");
    }
    return raw as GatewayMigrationJournal["steps"][number];
  });
  return { ...value, steps } as GatewayMigrationJournal;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function safeId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
}
function absolute(value: unknown): value is string {
  return typeof value === "string" && path.isAbsolute(value) && path.resolve(value) === value;
}
function iso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
function readErrorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
