import type { GatewayMigrationResult } from "./service.js";

/** Operator output contains inventory metadata only, never state bodies. */
export function formatGatewayMigrationResult(
  result: GatewayMigrationResult,
  json: boolean,
): string {
  const safe = {
    operation: result.operation,
    ...(result.dryRun ? { dryRun: true } : {}),
    ...(result.backupId ? { backupId: result.backupId } : {}),
    ...(result.restoredBackupId ? { restoredBackupId: result.restoredBackupId } : {}),
    ...(result.preRollbackBackupId ? { preRollbackBackupId: result.preRollbackBackupId } : {}),
    ...(result.plan
      ? {
          plan: {
            version: result.plan.version,
            createdAt: result.plan.createdAt,
            dryRun: result.plan.dryRun,
            backupRequired: result.plan.backupRequired,
            fileCount: result.plan.fileCount,
            estimatedBytes: result.plan.estimatedBytes,
            inspections: result.plan.inspections.map((item) => ({
              logicalId: item.descriptor.logicalId,
              aliases: item.descriptor.aliases,
              path: item.descriptor.path,
              schema: item.descriptor.schema,
              state: item.state,
              sourceVersion: item.sourceVersion,
              targetVersion: item.targetVersion,
              fileCount: item.fileCount,
              bytes: item.bytes,
              reason: item.reason,
            })),
            steps: result.plan.steps.map((step) => ({
              logicalId: step.logicalId,
              schema: step.schema,
              path: step.path,
              sourceVersion: step.sourceVersion,
              targetVersion: step.targetVersion,
              risk: step.risk,
            })),
          },
        }
      : {}),
  };
  if (json) return `${JSON.stringify(safe)}\n`;
  if (result.plan) {
    const lines = [
      `Gateway state: ${result.plan.steps.length} migration step(s), ${result.plan.fileCount} file(s), ${result.plan.estimatedBytes} byte(s)`,
      ...result.plan.inspections.map(
        (item) =>
          `${item.descriptor.logicalId}: ${item.state} (${item.sourceVersion ?? "none"}->${item.targetVersion}) ${item.descriptor.path}`,
      ),
      ...result.plan.steps.map(
        (step) =>
          `plan: ${step.logicalId} v${step.sourceVersion}->v${step.targetVersion} risk=${step.risk}`,
      ),
    ];
    if (result.plan.dryRun) lines.push("Dry run only; no files were changed.");
    if (result.backupId) lines.push(`Backup: ${result.backupId}`);
    return `${lines.join("\n")}\n`;
  }
  if (result.operation === "recover") {
    return `Recovered Gateway state from backup ${result.restoredBackupId}.\n`;
  }
  if (result.dryRun) {
    return (
      [
        `Rollback plan verified backup ${result.restoredBackupId}.`,
        "Dry run only; no files were changed.",
        "Gateway rollback does not restore the Novi binary or ordinary session JSONL files.",
      ].join("\n") + "\n"
    );
  }
  return (
    [
      `Restored Gateway state from backup ${result.restoredBackupId}.`,
      ...(result.preRollbackBackupId
        ? [`Pre-rollback backup: ${result.preRollbackBackupId}.`]
        : []),
      "Gateway rollback does not restore the Novi binary or ordinary session JSONL files.",
    ].join("\n") + "\n"
  );
}
