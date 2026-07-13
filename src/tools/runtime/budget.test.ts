import { describe, expect, it } from "vitest";
import type { SettingsLayers } from "../../settings.js";
import {
  DEFAULT_TOOL_EXECUTION_BUDGET,
  parseToolBudgetOverrides,
  resolveToolExecutionBudget,
} from "./budget.js";

describe("tool execution budget", () => {
  it("resolves default, global, project tighten-only, then CLI", () => {
    const layers: SettingsLayers = {
      global: { toolBudgets: { modelBytes: 100_000, traversalFiles: 100 } },
      project: { toolBudgets: { modelBytes: 80_000, traversalFiles: 200 } },
    };
    const result = resolveToolExecutionBudget(layers, { modelBytes: 120_000 });
    expect(result.values.modelBytes).toBe(120_000);
    expect(result.sources.modelBytes).toBe("cli");
    expect(result.values.traversalFiles).toBe(100);
    expect(result.sources.traversalFiles).toBe("global");
    expect(result.diagnostics.some((line) => line.includes("project traversalFiles"))).toBe(true);
    expect(result.values.timeoutMs).toBe(DEFAULT_TOOL_EXECUTION_BUDGET.timeoutMs);
  });

  it("allows project to disable artifacts but never force-enable them", () => {
    const disabled = resolveToolExecutionBudget({
      global: { artifacts: { enabled: false } },
      project: { artifacts: { enabled: true } },
    });
    expect(disabled.artifactsEnabled).toBe(false);
    expect(disabled.diagnostics).toContain(
      "tool resources: project artifacts.enabled=true ignored (tighten-only)",
    );
    const tightened = resolveToolExecutionBudget({
      global: { artifacts: { enabled: true } },
      project: { artifacts: { enabled: false } },
    });
    expect(tightened.artifactsEnabled).toBe(false);
    expect(tightened.artifactsEnabledSource).toBe("project");
  });

  it("strictly parses repeatable CLI overrides", () => {
    expect(parseToolBudgetOverrides(["modelBytes=42", "timeoutMs=7"])).toEqual({
      modelBytes: 42,
      timeoutMs: 7,
    });
    expect(() => parseToolBudgetOverrides(["unknown=1"])).toThrow(/unknown tool budget/);
    expect(() => parseToolBudgetOverrides(["modelBytes=0"])).toThrow(/positive safe integer/);
    expect(() => parseToolBudgetOverrides(["modelBytes=1", "modelBytes=2"])).toThrow(/conflicting/);
  });
});
