import { describe, expect, it } from "vitest";
import { SessionPermissionStore } from "./permissions/index.js";
import { permissionStoreForHarness } from "./bootstrap.js";

describe("permissionStoreForHarness", () => {
  it("reuses the interactive store across harness rebuilds", () => {
    const shared = new SessionPermissionStore();
    expect(permissionStoreForHarness("tui", shared)).toBe(shared);
  });

  it("creates an independent store for every Gateway session", () => {
    const shared = new SessionPermissionStore();
    const first = permissionStoreForHarness("gateway", shared);
    const second = permissionStoreForHarness("gateway", shared);
    expect(first).not.toBe(shared);
    expect(second).not.toBe(shared);
    expect(first).not.toBe(second);
  });
});
