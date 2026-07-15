import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { SkillLockEntry, SkillLockFile } from "./types.js";
import {
  readLock,
  writeLock,
  addEntry,
  removeEntry,
  getEntry,
  getEntryAsync,
} from "./provenance.js";

const cleanups: Array<() => Promise<void>> = [];
const realNoviHome = process.env.NOVI_HOME;
let noviHome: string;

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  if (noviHome) await rm(noviHome, { recursive: true, force: true });
  if (realNoviHome === undefined) delete process.env.NOVI_HOME;
  else process.env.NOVI_HOME = realNoviHome;
});

async function setup(): Promise<{ env: NodeExecutionEnv; cwd: string }> {
  noviHome = await mkdtemp(path.join(tmpdir(), "novi-prov-home-"));
  process.env.NOVI_HOME = noviHome;
  const cwd = await mkdtemp(path.join(tmpdir(), "novi-prov-cwd-"));
  const env = new NodeExecutionEnv({ cwd, shellEnv: process.env });
  cleanups.push(async () => {
    await env.cleanup();
    await rm(cwd, { recursive: true, force: true });
  });
  return { env, cwd };
}

function sampleEntry(overrides: Partial<SkillLockEntry> = {}): SkillLockEntry {
  return {
    name: "my-skill",
    source: "octocat/hello-world",
    sourceType: "skills-sh",
    sourceUrl: "https://github.com/octocat/hello-world",
    contentHash: "abc123",
    installedAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("provenance", () => {
  describe("readLock", () => {
    it("returns empty lock when file is missing", async () => {
      const { env } = await setup();
      const lock = await readLock(env);
      expect(lock).toEqual({ version: 1, skills: {} });
    });

    it("returns empty lock for corrupt JSON", async () => {
      const { env } = await setup();
      const filePath = path.join(noviHome, "skills", ".hub", "lock.json");
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, "not valid json{{{");
      const lock = await readLock(env);
      expect(lock).toEqual({ version: 1, skills: {} });
    });

    it("returns empty lock for version mismatch", async () => {
      const { env } = await setup();
      const filePath = path.join(noviHome, "skills", ".hub", "lock.json");
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, JSON.stringify({ version: 999, skills: {} }));
      const lock = await readLock(env);
      expect(lock).toEqual({ version: 1, skills: {} });
    });

    it("reads a valid lock file", async () => {
      const { env } = await setup();
      const entry = sampleEntry();
      const lockFile: SkillLockFile = { version: 1, skills: { "my-skill": entry } };
      const filePath = path.join(noviHome, "skills", ".hub", "lock.json");
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, JSON.stringify(lockFile, null, 2));
      const lock = await readLock(env);
      expect(lock.skills["my-skill"]).toEqual(entry);
    });
  });

  describe("writeLock", () => {
    it("writes a lock file atomically (tmp + rename)", async () => {
      const { env } = await setup();
      const lock: SkillLockFile = { version: 1, skills: {} };
      await writeLock(env, lock);
      const filePath = path.join(noviHome, "skills", ".hub", "lock.json");
      const raw = await readFile(filePath, "utf8");
      expect(JSON.parse(raw)).toEqual(lock);
    });

    it("creates the .hub directory if missing", async () => {
      const { env } = await setup();
      await writeLock(env, { version: 1, skills: {} });
      const filePath = path.join(noviHome, "skills", ".hub", "lock.json");
      const raw = await readFile(filePath, "utf8");
      expect(JSON.parse(raw).version).toBe(1);
    });

    it("overwrites an existing lock file", async () => {
      const { env } = await setup();
      await writeLock(env, { version: 1, skills: {} });
      const entry = sampleEntry();
      await writeLock(env, { version: 1, skills: { "my-skill": entry } });
      const lock = await readLock(env);
      expect(lock.skills["my-skill"]).toEqual(entry);
    });
  });

  describe("addEntry / removeEntry", () => {
    it("addEntry persists a new entry", async () => {
      const { env } = await setup();
      const entry = sampleEntry();
      await addEntry(env, entry);
      const lock = await readLock(env);
      expect(lock.skills["my-skill"]).toEqual(entry);
    });

    it("addEntry replaces an existing entry", async () => {
      const { env } = await setup();
      await addEntry(env, sampleEntry({ contentHash: "old" }));
      await addEntry(env, sampleEntry({ contentHash: "new" }));
      const lock = await readLock(env);
      expect(lock.skills["my-skill"]!.contentHash).toBe("new");
    });

    it("removeEntry deletes an entry", async () => {
      const { env } = await setup();
      await addEntry(env, sampleEntry());
      await removeEntry(env, "my-skill");
      const lock = await readLock(env);
      expect(lock.skills["my-skill"]).toBeUndefined();
    });

    it("removeEntry is a no-op for missing entry", async () => {
      const { env } = await setup();
      await removeEntry(env, "nonexistent");
      const lock = await readLock(env);
      expect(lock.skills).toEqual({});
    });
  });

  describe("getEntry", () => {
    it("returns the entry when present", () => {
      const entry = sampleEntry();
      const lock: SkillLockFile = { version: 1, skills: { "my-skill": entry } };
      expect(getEntry(lock, "my-skill")).toEqual(entry);
    });

    it("returns undefined when absent", () => {
      const lock: SkillLockFile = { version: 1, skills: {} };
      expect(getEntry(lock, "missing")).toBeUndefined();
    });
  });

  describe("getEntryAsync", () => {
    it("reads and returns the entry", async () => {
      const { env } = await setup();
      await addEntry(env, sampleEntry());
      const entry = await getEntryAsync(env, "my-skill");
      expect(entry).toBeDefined();
      expect(entry!.name).toBe("my-skill");
    });

    it("returns undefined for missing entry", async () => {
      const { env } = await setup();
      const entry = await getEntryAsync(env, "missing");
      expect(entry).toBeUndefined();
    });
  });

  describe("atomic write integrity", () => {
    it("does not leave a temp file on success", async () => {
      const { env } = await setup();
      await writeLock(env, { version: 1, skills: {} });
      const dir = path.join(noviHome, "skills", ".hub");
      const { readdir } = await import("node:fs/promises");
      const files = await readdir(dir);
      expect(files).toEqual(["lock.json"]);
    });
  });
});
