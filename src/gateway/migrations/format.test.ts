import { describe, expect, it } from "vitest";
import { formatGatewayMigrationResult } from "./format.js";
import type { GatewayMigrationResult } from "./service.js";

describe("Gateway migration format", () => {
  it("prints metadata without state bodies", () => {
    const result: GatewayMigrationResult = {
      operation: "plan",
      plan: {
        version: 1,
        createdAt: "2026-07-15T00:00:00.000Z",
        dryRun: true,
        backupRequired: true,
        fileCount: 1,
        estimatedBytes: 99,
        inspections: [
          {
            descriptor: {
              logicalId: "config-global",
              aliases: [],
              path: "/safe/gateway.json",
              schema: "config",
              kind: "file",
              currentVersion: 1,
              excludedRootNames: [],
            },
            state: "legacy-migratable",
            sourceVersion: 0,
            targetVersion: 1,
            fileCount: 1,
            bytes: 99,
          },
        ],
        steps: [
          {
            logicalId: "config-global",
            schema: "config",
            path: "/safe/gateway.json",
            sourceVersion: 0,
            targetVersion: 1,
            risk: "low",
          },
        ],
      },
    };
    for (const json of [false, true]) {
      const output = formatGatewayMigrationResult(result, json);
      expect(output).toContain("config-global");
      expect(output).not.toContain("bot-token-secret");
    }
  });

  it("labels rollback dry-runs without claiming restoration", () => {
    const output = formatGatewayMigrationResult(
      { operation: "rollback", restoredBackupId: "backup-1", dryRun: true },
      false,
    );
    expect(output).toContain("Dry run only");
    expect(output).not.toContain("Restored Gateway state");
  });
});
