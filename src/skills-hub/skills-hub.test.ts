import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";

// Mock the network module.
vi.mock("../tools/web/network.js", () => ({
  guardedRequest: vi.fn(),
}));

// Mock child_process execFile for git clones.
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

import { execFile as execFileCb } from "node:child_process";
import { guardedRequest } from "../tools/web/network.js";

/** Callback signature for the mocked execFile. */
type ExecCallback = (err: Error | null, stdout?: string, stderr?: string) => void;
import { install, uninstall, list, update, search } from "./skills-hub.js";
import { readLock } from "./provenance.js";

const mockedExecFile = vi.mocked(execFileCb) as unknown as Mock;
const mockedGuardedRequest = vi.mocked(guardedRequest);

const cleanups: Array<() => Promise<void>> = [];
const realNoviHome = process.env.NOVI_HOME;
let noviHome: string;

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  if (noviHome) await rm(noviHome, { recursive: true, force: true }).catch(() => {});
  if (realNoviHome === undefined) delete process.env.NOVI_HOME;
  else process.env.NOVI_HOME = realNoviHome;
  vi.clearAllMocks();
});

async function setup(): Promise<{ env: NodeExecutionEnv; cwd: string }> {
  noviHome = await mkdtemp(path.join(tmpdir(), "novi-hub-home-"));
  process.env.NOVI_HOME = noviHome;
  const cwd = await mkdtemp(path.join(tmpdir(), "novi-hub-cwd-"));
  const env = new NodeExecutionEnv({ cwd, shellEnv: process.env });
  cleanups.push(async () => {
    await env.cleanup();
    await rm(cwd, { recursive: true, force: true });
  });
  return { env, cwd };
}

function mockNetResponse(status: number, body: unknown) {
  return {
    requestedUrl: "https://mock",
    finalUrl: "https://mock",
    status,
    headers: {},
    body: Buffer.from(typeof body === "string" ? body : JSON.stringify(body), "utf8"),
    redirectCount: 0,
  };
}

const SKILL_MD = `---
name: test-skill
version: "1.0.0"
---
# Test Skill
This is a test skill.`;

describe("skills-hub facade", () => {
  describe("search", () => {
    it("delegates to registry-client.searchSkills", async () => {
      mockedGuardedRequest.mockResolvedValue(
        mockNetResponse(200, {
          skills: [{ id: "1", name: "my-skill", source: "octocat/repo", installs: 5 }],
        }),
      );
      const results = await search("test");
      expect(results).toHaveLength(1);
      expect(results[0]!.name).toBe("my-skill");
    });
  });

  describe("install (local source)", () => {
    it("installs from a local directory and writes provenance", async () => {
      const { env } = await setup();
      const src = await mkdtemp(path.join(tmpdir(), "novi-src-"));
      cleanups.push(() => rm(src, { recursive: true, force: true }));
      await writeFile(path.join(src, "SKILL.md"), SKILL_MD);

      const confirm = vi.fn(() => Promise.resolve(true));
      const result = await install(env, src, { confirm });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.name).toBe("test-skill");
        expect(result.verdict).toBe("unknown");
        expect(result.entry.sourceType).toBe("local");
        expect(result.entry.contentHash).toMatch(/^[0-9a-f]{64}$/);

        // Verify lock file was written
        const lock = await readLock(env);
        expect(lock.skills["test-skill"]).toBeDefined();
        expect(lock.skills["test-skill"]!.version).toBe("1.0.0");

        // Verify SKILL.md was installed
        const installed = await readFile(
          path.join(noviHome, "skills", "test-skill", "SKILL.md"),
          "utf8",
        );
        expect(installed).toBe(SKILL_MD);
      }
      // Confirm was called for non-skills-sh source
      expect(confirm).toHaveBeenCalled();
    });

    it("returns error when confirm is denied for non-skills-sh source", async () => {
      const { env } = await setup();
      const src = await mkdtemp(path.join(tmpdir(), "novi-src-"));
      cleanups.push(() => rm(src, { recursive: true, force: true }));
      await writeFile(path.join(src, "SKILL.md"), SKILL_MD);

      const confirm = vi.fn(() => Promise.resolve(false));
      const result = await install(env, src, { confirm });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain("trust not confirmed");
      }
    });
  });

  describe("install (url source)", () => {
    it("installs from a URL and writes provenance", async () => {
      const { env } = await setup();
      mockedGuardedRequest.mockResolvedValue(mockNetResponse(200, SKILL_MD));

      const confirm = vi.fn(() => Promise.resolve(true));
      const result = await install(env, "https://example.com/SKILL.md", { confirm });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.name).toBe("test-skill");
        expect(result.entry.sourceType).toBe("url");
        expect(result.entry.sourceUrl).toBe("https://example.com/SKILL.md");
      }
      expect(confirm).toHaveBeenCalled();
    });
  });

  describe("install (git source)", () => {
    it("installs from a git repo via git clone", async () => {
      const { env } = await setup();

      // Mock git clone: create a fake repo dir with SKILL.md
      mockedExecFile.mockImplementation(
        (_cmd: string, args: string[], _opts: unknown, cb: ExecCallback) => {
          if (args.includes("clone")) {
            const targetDir = args[args.length - 1]!;
            mkdir(targetDir, { recursive: true })
              .then(() => writeFile(path.join(targetDir, "SKILL.md"), SKILL_MD))
              .then(() => cb(null, "", ""))
              .catch((err) => cb(err));
          } else {
            cb(null, "", "");
          }
        },
      );

      const confirm = vi.fn(() => Promise.resolve(true));
      const result = await install(env, "git:octocat/hello-world", { confirm });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.entry.sourceType).toBe("git");
        expect(result.entry.sourceUrl).toBe("https://github.com/octocat/hello-world");
      }
      expect(confirm).toHaveBeenCalled();
    });

    it("fails when git binary is missing", async () => {
      const { env } = await setup();
      mockedExecFile.mockImplementation(
        (_cmd: string, _args: string[], _opts: unknown, cb: ExecCallback) => {
          cb(Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" }));
        },
      );

      const confirm = vi.fn(() => Promise.resolve(true));
      await expect(install(env, "git:octocat/hello-world", { confirm })).rejects.toThrow(
        "git binary not found",
      );
    });
  });

  describe("install (skills-sh source)", () => {
    it("blocks on dangerous scan verdict", async () => {
      const { env } = await setup();

      // Mock git clone
      mockedExecFile.mockImplementation(
        (_cmd: string, args: string[], _opts: unknown, cb: ExecCallback) => {
          if (args.includes("clone")) {
            const targetDir = args[args.length - 1]!;
            mkdir(targetDir, { recursive: true })
              .then(() => writeFile(path.join(targetDir, "SKILL.md"), SKILL_MD))
              .then(() => cb(null, "", ""))
              .catch((err) => cb(err));
          } else {
            cb(null, "", "");
          }
        },
      );

      // Mock audit: dangerous
      mockedGuardedRequest.mockResolvedValue(
        mockNetResponse(200, {
          "hello-world": {
            snyk: { risk: "critical", analyzedAt: "2025-01-01T00:00:00Z" },
          },
        }),
      );

      const confirm = vi.fn(() => Promise.resolve(true));
      const result = await install(env, "octocat/hello-world", {
        confirm,
        force: true,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain("dangerous");
      }
      // Confirm should NOT be called because dangerous blocks before confirm
      expect(confirm).not.toHaveBeenCalled();
    });

    it("allows warn with force", async () => {
      const { env } = await setup();

      mockedExecFile.mockImplementation(
        (_cmd: string, args: string[], _opts: unknown, cb: ExecCallback) => {
          if (args.includes("clone")) {
            const targetDir = args[args.length - 1]!;
            mkdir(targetDir, { recursive: true })
              .then(() => writeFile(path.join(targetDir, "SKILL.md"), SKILL_MD))
              .then(() => cb(null, "", ""))
              .catch((err) => cb(err));
          } else {
            cb(null, "", "");
          }
        },
      );

      mockedGuardedRequest.mockResolvedValue(
        mockNetResponse(200, {
          "hello-world": {
            socket: { risk: "medium", alerts: 2, analyzedAt: "2025-01-01T00:00:00Z" },
          },
        }),
      );

      const confirm = vi.fn(() => Promise.resolve(true));
      const result = await install(env, "octocat/hello-world", {
        confirm,
        force: true,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.verdict).toBe("warn");
        expect(result.entry.scan).not.toBeNull();
        expect(result.entry.scan!.verdicts.socket!.alerts).toBe(2);
      }
      // shouldBlock("warn", true) = false → no confirm needed
      expect(confirm).not.toHaveBeenCalled();
    });

    it("requires confirm for warn without force", async () => {
      const { env } = await setup();

      mockedExecFile.mockImplementation(
        (_cmd: string, args: string[], _opts: unknown, cb: ExecCallback) => {
          if (args.includes("clone")) {
            const targetDir = args[args.length - 1]!;
            mkdir(targetDir, { recursive: true })
              .then(() => writeFile(path.join(targetDir, "SKILL.md"), SKILL_MD))
              .then(() => cb(null, "", ""))
              .catch((err) => cb(err));
          } else {
            cb(null, "", "");
          }
        },
      );

      mockedGuardedRequest.mockResolvedValue(
        mockNetResponse(200, {
          "hello-world": {
            socket: { risk: "medium", alerts: 1, analyzedAt: "2025-01-01T00:00:00Z" },
          },
        }),
      );

      const confirm = vi.fn(() => Promise.resolve(true));
      const result = await install(env, "octocat/hello-world", {
        confirm,
        force: false,
      });

      expect(result.ok).toBe(true);
      expect(confirm).toHaveBeenCalled();
    });

    it("cancels on warn without force when confirm denied", async () => {
      const { env } = await setup();

      mockedExecFile.mockImplementation(
        (_cmd: string, args: string[], _opts: unknown, cb: ExecCallback) => {
          if (args.includes("clone")) {
            const targetDir = args[args.length - 1]!;
            mkdir(targetDir, { recursive: true })
              .then(() => writeFile(path.join(targetDir, "SKILL.md"), SKILL_MD))
              .then(() => cb(null, "", ""))
              .catch((err) => cb(err));
          } else {
            cb(null, "", "");
          }
        },
      );

      mockedGuardedRequest.mockResolvedValue(
        mockNetResponse(200, {
          "hello-world": {
            socket: { risk: "medium", alerts: 1, analyzedAt: "2025-01-01T00:00:00Z" },
          },
        }),
      );

      const confirm = vi.fn(() => Promise.resolve(false));
      const result = await install(env, "octocat/hello-world", {
        confirm,
        force: false,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain("cancelled");
      }
    });

    it("installs on pass verdict", async () => {
      const { env } = await setup();

      mockedExecFile.mockImplementation(
        (_cmd: string, args: string[], _opts: unknown, cb: ExecCallback) => {
          if (args.includes("clone")) {
            const targetDir = args[args.length - 1]!;
            mkdir(targetDir, { recursive: true })
              .then(() => writeFile(path.join(targetDir, "SKILL.md"), SKILL_MD))
              .then(() => cb(null, "", ""))
              .catch((err) => cb(err));
          } else {
            cb(null, "", "");
          }
        },
      );

      mockedGuardedRequest.mockResolvedValue(
        mockNetResponse(200, {
          "hello-world": {
            snyk: { risk: "safe", analyzedAt: "2025-01-01T00:00:00Z" },
            ath: { risk: "low", analyzedAt: "2025-01-01T00:00:00Z" },
          },
        }),
      );

      const confirm = vi.fn(() => Promise.resolve(true));
      const result = await install(env, "octocat/hello-world", { confirm });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.verdict).toBe("pass");
        expect(result.entry.scan).not.toBeNull();
      }
      expect(confirm).not.toHaveBeenCalled();
    });
  });

  describe("install (unrecognized ref)", () => {
    it("returns error for unrecognized source ref", async () => {
      const { env } = await setup();
      const confirm = vi.fn(() => Promise.resolve(true));
      const result = await install(env, "", { confirm });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain("unrecognized");
      }
    });
  });

  describe("install (incompatible)", () => {
    it("blocks on platform mismatch", async () => {
      const { env } = await setup();
      const src = await mkdtemp(path.join(tmpdir(), "novi-src-"));
      cleanups.push(() => rm(src, { recursive: true, force: true }));
      await writeFile(
        path.join(src, "SKILL.md"),
        `---
name: mac-skill
platforms: [macos]
---
content`,
      );

      const confirm = vi.fn(() => Promise.resolve(true));
      const result = await install(env, src, { confirm });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain("incompatible");
      }
      expect(confirm).not.toHaveBeenCalled();
    });
  });

  describe("uninstall", () => {
    it("returns not hub-installed for unknown skill", async () => {
      const { env } = await setup();
      const result = await uninstall(env, "unknown");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("not hub-installed");
      }
    });

    it("removes a hub-installed skill", async () => {
      const { env } = await setup();
      const src = await mkdtemp(path.join(tmpdir(), "novi-src-"));
      cleanups.push(() => rm(src, { recursive: true, force: true }));
      await writeFile(path.join(src, "SKILL.md"), SKILL_MD);

      const confirm = vi.fn(() => Promise.resolve(true));
      const installResult = await install(env, src, { confirm });
      expect(installResult.ok).toBe(true);

      const result = await uninstall(env, "test-skill");
      expect(result.ok).toBe(true);

      // Verify lock entry removed
      const lock = await readLock(env);
      expect(lock.skills["test-skill"]).toBeUndefined();

      // Verify directory removed
      const exists = await env.exists(path.join(noviHome, "skills", "test-skill"));
      expect(exists.ok).toBe(true);
      if (exists.ok) expect(exists.value).toBe(false);
    });
  });

  describe("list", () => {
    it("returns empty array when no skills installed", async () => {
      const { env } = await setup();
      const entries = await list(env);
      expect(entries).toEqual([]);
    });

    it("returns installed skills from lock", async () => {
      const { env } = await setup();
      const src = await mkdtemp(path.join(tmpdir(), "novi-src-"));
      cleanups.push(() => rm(src, { recursive: true, force: true }));
      await writeFile(path.join(src, "SKILL.md"), SKILL_MD);

      const confirm = vi.fn(() => Promise.resolve(true));
      await install(env, src, { confirm });

      const entries = await list(env);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.name).toBe("test-skill");
      expect(entries[0]!.version).toBe("1.0.0");
    });
  });

  describe("update", () => {
    it("marks installed skill as up-to-date when hash matches", async () => {
      const { env } = await setup();
      const src = await mkdtemp(path.join(tmpdir(), "novi-src-"));
      cleanups.push(() => rm(src, { recursive: true, force: true }));
      await writeFile(path.join(src, "SKILL.md"), SKILL_MD);

      const confirm = vi.fn(() => Promise.resolve(true));
      await install(env, src, { confirm });

      // Re-run update — content is same → up-to-date
      const result = await update(env, { confirm });
      expect(result.upToDate).toContain("test-skill");
      expect(result.updated).toHaveLength(0);
    });

    it("updates when content changes", async () => {
      const { env } = await setup();
      const src = await mkdtemp(path.join(tmpdir(), "novi-src-"));
      cleanups.push(() => rm(src, { recursive: true, force: true }));
      await writeFile(path.join(src, "SKILL.md"), SKILL_MD);

      const confirm = vi.fn(() => Promise.resolve(true));
      await install(env, src, { confirm });

      // Change the source content
      const newSkillMd = `---
name: test-skill
version: "1.1.0"
---
# Updated Skill`;
      await writeFile(path.join(src, "SKILL.md"), newSkillMd);

      const result = await update(env, { confirm });
      expect(result.updated).toContain("test-skill");
      expect(result.upToDate).toHaveLength(0);

      // Verify lock entry updated
      const lock = await readLock(env);
      expect(lock.skills["test-skill"]!.version).toBe("1.1.0");
    });

    it("handles named update", async () => {
      const { env } = await setup();
      const src = await mkdtemp(path.join(tmpdir(), "novi-src-"));
      cleanups.push(() => rm(src, { recursive: true, force: true }));
      await writeFile(path.join(src, "SKILL.md"), SKILL_MD);

      const confirm = vi.fn(() => Promise.resolve(true));
      await install(env, src, { confirm });

      const result = await update(env, { name: "test-skill", confirm });
      expect(result.upToDate).toContain("test-skill");
    });

    it("reports failed for unknown name", async () => {
      const { env } = await setup();
      const confirm = vi.fn(() => Promise.resolve(true));
      const result = await update(env, { name: "nonexistent", confirm });
      expect(result.updated).toHaveLength(0);
      expect(result.upToDate).toHaveLength(0);
      expect(result.failed).toHaveLength(0);
    });
  });
});
