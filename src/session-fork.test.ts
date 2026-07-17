import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { JsonlSessionRepo, NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("JsonlSessionRepo fork contract", () => {
  it("forks at a fixed leaf, records its parent, and appends independently", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "novi-session-fork-"));
    roots.push(root);
    const env = new NodeExecutionEnv({ cwd: root, shellEnv: process.env });
    const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: path.join(root, "sessions") });

    try {
      const parent = await repo.create({ cwd: root, id: "parent" });
      const forkLeaf = await parent.appendCustomEntry("contract", { value: "fork-point" });
      const laterParentEntry = await parent.appendCustomEntry("contract", { value: "parent-only" });
      const parentMetadata = await parent.getMetadata();

      const child = await repo.fork(parentMetadata, {
        cwd: root,
        id: "child",
        entryId: forkLeaf,
        position: "at",
      });
      const childMetadata = await child.getMetadata();

      expect(childMetadata.parentSessionPath).toBe(parentMetadata.path);
      expect(await child.getLeafId()).toBe(forkLeaf);
      expect(await child.getEntry(forkLeaf)).toBeDefined();
      expect(await child.getEntry(laterParentEntry)).toBeUndefined();

      const childOnlyEntry = await child.appendCustomEntry("contract", { value: "child-only" });
      expect(await parent.getEntry(childOnlyEntry)).toBeUndefined();
      expect(await parent.getLeafId()).toBe(laterParentEntry);
    } finally {
      await env.cleanup();
    }
  });
});
