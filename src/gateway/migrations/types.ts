export type GatewayStateSchema = "config" | "pairing" | "sessions" | "jobs" | "messages";
export type GatewaySchemaState =
  "missing" | "current" | "legacy-migratable" | "future-unsupported" | "corrupt";

export interface GatewayStateDescriptor {
  logicalId: string;
  aliases: string[];
  path: string;
  schema: GatewayStateSchema;
  kind: "file" | "directory";
  currentVersion: 1;
  excludedRootNames: string[];
}

export interface GatewayStateInspection {
  descriptor: GatewayStateDescriptor;
  state: GatewaySchemaState;
  sourceVersion?: number;
  targetVersion: 1;
  fileCount: number;
  bytes: number;
  reason?: string;
}

export interface GatewayMigrationStep {
  logicalId: string;
  schema: GatewayStateSchema;
  path: string;
  sourceVersion: number;
  targetVersion: 1;
  risk: "low" | "medium";
}

export interface GatewayMigrationPlan {
  version: 1;
  createdAt: string;
  dryRun: boolean;
  backupRequired: boolean;
  fileCount: number;
  estimatedBytes: number;
  inspections: GatewayStateInspection[];
  steps: GatewayMigrationStep[];
}

export interface GatewayStateRegistryOptions {
  noviDir: string;
  cwd: string;
  configPath?: string;
  includeProject?: boolean;
}
