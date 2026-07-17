import { describe, expect, it } from "vitest";
import { DEFAULT_SUBAGENT_SETTINGS, resolveSubagentSettings } from "./config.js";

describe("resolveSubagentSettings", () => {
  it("provides runtime defaults that allow at least three concurrent children", () => {
    const result = resolveSubagentSettings({ global: null, project: null });
    expect(result.values).toEqual(DEFAULT_SUBAGENT_SETTINGS);
    expect(result.values.maxConcurrent).toBeGreaterThanOrEqual(3);
    expect(result.values.maxChildrenPerParent).toBeGreaterThanOrEqual(3);
  });

  it("lets global settings choose limits and project settings only tighten them", () => {
    const result = resolveSubagentSettings({
      global: {
        subagents: {
          enabled: false,
          maxConcurrent: 12,
          maxChildrenPerParent: 7,
          allowedModels: ["anthropic/a", "openai/b"],
        },
      },
      project: {
        subagents: {
          enabled: true,
          maxConcurrent: 9,
          maxChildrenPerParent: 8,
          allowedModels: ["openai/b", "other/c"],
        },
      },
    });

    expect(result.values.enabled).toBe(false);
    expect(result.values.maxConcurrent).toBe(9);
    expect(result.values.maxChildrenPerParent).toBe(7);
    expect(result.values.allowedModels).toEqual(["openai/b"]);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.stringContaining("cannot re-enable"),
        expect.stringContaining("maxChildrenPerParent cannot raise"),
        expect.stringContaining("allowedModels cannot add"),
      ]),
    );
  });

  it("intersects profile capabilities and rejects project-created profiles", () => {
    const result = resolveSubagentSettings({
      global: {
        subagents: {
          profiles: {
            audit: {
              tools: { allow: ["read_file", "grep"], deny: ["bash"] },
              skills: ["one", "two"],
              writable: false,
              maxThinking: "medium",
            },
          },
        },
      },
      project: {
        subagents: {
          profiles: {
            audit: {
              tools: { allow: ["read_file", "write_file"], deny: ["edit_file"] },
              skills: ["two", "three"],
              writable: true,
              maxThinking: "high",
            },
            injected: { writable: true },
          },
        },
      },
    });

    expect(result.values.profiles.audit).toMatchObject({
      tools: { allow: ["read_file"], deny: ["bash", "edit_file"] },
      skills: ["two"],
      writable: false,
      maxThinking: "medium",
    });
    expect(result.values.profiles.injected).toBeUndefined();
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.stringContaining("writable cannot add writes"),
        expect.stringContaining("cannot create a profile"),
      ]),
    );
  });
});
