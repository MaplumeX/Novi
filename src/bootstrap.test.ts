import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { SessionPermissionStore } from "./permissions/index.js";
import { bootstrap, permissionStoreForHarness } from "./bootstrap.js";

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

describe("bootstrap session target", () => {
  it("routes both new and resume through the shared harness assembly", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "novi-bootstrap-session-"));
    const previousHome = process.env.NOVI_HOME;
    const previousKey = process.env.ANTHROPIC_API_KEY;
    process.env.NOVI_HOME = path.join(root, "home");
    process.env.ANTHROPIC_API_KEY = "test-key";
    let first: Awaited<ReturnType<typeof bootstrap>> | undefined;
    let resumed: Awaited<ReturnType<typeof bootstrap>> | undefined;
    try {
      first = await bootstrap({ cwd: root, trusted: false, toolMode: "print" });
      const expected = await first.session.getMetadata();
      resumed = await bootstrap({
        cwd: root,
        trusted: false,
        toolMode: "print",
        resumePath: first.sessionPath,
      });
      expect(await resumed.session.getMetadata()).toEqual(expected);
      expect(resumed.sessionPath).toBe(first.sessionPath);
      expect(resumed.toolCatalog.descriptors).toEqual(first.toolCatalog.descriptors);
    } finally {
      await resumed?.mcp?.close();
      await first?.mcp?.close();
      await resumed?.env.cleanup();
      await first?.env.cleanup();
      if (previousHome === undefined) delete process.env.NOVI_HOME;
      else process.env.NOVI_HOME = previousHome;
      if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previousKey;
      await rm(root, { recursive: true, force: true });
    }
  });
});
