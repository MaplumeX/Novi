import { decodePairingStore } from "../core/pairing-store.js";
import type { GatewayMigrationStep } from "./types.js";

/** Apply a schema migration without reading environment variables or touching disk. */
export function migrateGatewayJson(step: GatewayMigrationStep, raw: string): string {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`cannot migrate invalid JSON: ${step.logicalId}`);
  }
  if (!isObject(value)) throw new Error(`cannot migrate non-object state: ${step.logicalId}`);
  if (step.sourceVersion !== 0 || step.targetVersion !== 1) {
    throw new Error(`unsupported migration ${step.sourceVersion}->${step.targetVersion}`);
  }
  if (step.schema !== "config" && step.schema !== "pairing") {
    throw new Error(`schema has no migrator: ${step.schema}`);
  }
  const migrated = { version: 1 as const, ...value };
  if (step.schema === "pairing") decodePairingStore(migrated);
  return `${JSON.stringify(migrated, null, 2)}\n`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
