import { describe, expect, it } from "vitest";
import {
  completeSlashSelection,
  buildSlashItems,
  filterSlashItems,
} from "./InputBox.js";
import type { Command } from "./commands.js";
import { COMMANDS } from "./commands.js";

const cmd = (name: string): { name: string } => ({ name });

describe("buildSlashItems / filterSlashItems", () => {
  it("includes skill:<name> entries with descriptions", () => {
    const items = buildSlashItems([
      { name: "review", description: "Review code" },
      { name: "deploy", description: "Deploy app" },
    ]);
    const skillItems = items.filter((i) => i.name.startsWith("skill:"));
    expect(skillItems).toEqual([
      { name: "skill:review", description: "Review code" },
      { name: "skill:deploy", description: "Deploy app" },
    ]);
    // Static commands still present.
    expect(items.some((i) => i.name === "quit")).toBe(true);
    expect(items.length).toBe(COMMANDS.length + 2);
  });

  it("filters by query matching skill: prefix or skill name", () => {
    const items = buildSlashItems([{ name: "review", description: "Review code" }]);
    const bySkill = filterSlashItems(items, "skill");
    expect(bySkill.some((i) => i.name === "skill:review")).toBe(true);

    const byName = filterSlashItems(items, "review");
    expect(byName.map((i) => i.name)).toEqual(["skill:review"]);

    const empty = filterSlashItems(items, "zzz-no-match");
    expect(empty).toEqual([]);
  });

  it("returns all items when query is empty", () => {
    const items = buildSlashItems([{ name: "a", description: "A" }]);
    expect(filterSlashItems(items, "")).toEqual(items);
  });
});

describe("completeSlashSelection", () => {
  it("single match: completes to `/<name> ` with trailing space (no args)", () => {
    const result = completeSlashSelection([cmd("help")], 0, "");
    expect(result).toEqual({ text: "/help ", cursor: 6 });
  });

  it("single match: preserves already-typed args (no extra trailing space)", () => {
    const result = completeSlashSelection([cmd("thinking")], 0, " high");
    expect(result).toEqual({ text: "/thinking high", cursor: 14 });
  });

  it("multiple matches: completes to the highlighted item's name (first selected)", () => {
    const result = completeSlashSelection(
      [cmd("tools"), cmd("tree"), cmd("templates")],
      0,
      "",
    );
    expect(result).toEqual({ text: "/tools", cursor: 6 });
  });

  it("multiple matches: completes to the second highlighted item when ↓ moves selection", () => {
    const result = completeSlashSelection(
      [cmd("tools"), cmd("tree"), cmd("templates")],
      1,
      "",
    );
    expect(result).toEqual({ text: "/tree", cursor: 5 });
  });

  it("multiple matches: completes to the third highlighted item", () => {
    const result = completeSlashSelection(
      [cmd("tools"), cmd("tree"), cmd("templates")],
      2,
      "",
    );
    expect(result).toEqual({ text: "/templates", cursor: 10 });
  });

  it("multiple matches: preserves slashArgs after the completed name", () => {
    const result = completeSlashSelection(
      [cmd("tools"), cmd("thinking")],
      1,
      " high",
    );
    expect(result).toEqual({ text: "/thinking high", cursor: 14 });
  });

  it("clamps the selected index to the last match when out of range", () => {
    const result = completeSlashSelection(
      [cmd("tools"), cmd("tree")],
      99,
      "",
    );
    expect(result).toEqual({ text: "/tree", cursor: 5 });
  });

  it("returns null for an empty match list", () => {
    expect(completeSlashSelection([], 0, "")).toBeNull();
  });

  it("uses the Command name (works with real Command objects)", () => {
    const real: Pick<Command, "name"> = { name: "compact" };
    const result = completeSlashSelection([real, { name: "clear" }], 0, "");
    expect(result).toEqual({ text: "/compact", cursor: 8 });
  });
});
