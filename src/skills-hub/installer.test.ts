import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";

// Mock the network module so no real HTTP is made.
vi.mock("../tools/web/network.js", () => ({
  guardedRequest: vi.fn(),
}));

// Mock child_process execFile to avoid real git clones.
// The mock invokes the callback (3rd/4th arg) so the promise wrapper in installer.ts resolves.
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

// Import after mock setup.
import { execFile as execFileCb } from "node:child_process";
import { guardedRequest } from "../tools/web/network.js";
import {
  computeContentHash,
  deleteSkillDir,
  installToSkillsDir,
  isPathSafe,
  parseSkillFrontmatter,
  sanitizeName,
} from "./installer.js";

/** Callback signature for the mocked execFile. */
type ExecCallback = (err: Error | null, stdout?: string, stderr?: string) => void;

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
  noviHome = await mkdtemp(path.join(tmpdir(), "novi-inst-home-"));
  process.env.NOVI_HOME = noviHome;
  const cwd = await mkdtemp(path.join(tmpdir(), "novi-inst-cwd-"));
  const env = new NodeExecutionEnv({ cwd, shellEnv: process.env });
  cleanups.push(async () => {
    await env.cleanup();
    await rm(cwd, { recursive: true, force: true });
  });
  return { env, cwd };
}

function mockNetworkResponse(status: number, body: string) {
  return {
    requestedUrl: "https://mock",
    finalUrl: "https://mock",
    status,
    headers: {},
    body: Buffer.from(body, "utf8"),
    redirectCount: 0,
  };
}

describe("sanitizeName", () => {
  it("lowercases and replaces invalid chars with dash", () => {
    expect(sanitizeName("My Cool Skill")).toBe("my-cool-skill");
  });

  it("strips leading/trailing dots and dashes", () => {
    expect(sanitizeName(".-skill-.")).toBe("skill");
  });

  it("preserves allowed chars a-z0-9._-", () => {
    expect(sanitizeName("my_skill.v2-test")).toBe("my_skill.v2-test");
  });

  it("falls back to unnamed-skill for empty input", () => {
    expect(sanitizeName("")).toBe("unnamed-skill");
  });

  it("falls back to unnamed-skill when only invalid chars", () => {
    expect(sanitizeName("!!!")).toBe("unnamed-skill");
  });

  it("caps at 255 chars", () => {
    const long = "a".repeat(300);
    expect(sanitizeName(long).length).toBe(255);
  });
});

describe("isPathSafe", () => {
  it("returns true for a path inside the base", () => {
    expect(isPathSafe("/tmp/skills", "/tmp/skills/my-skill")).toBe(true);
  });

  it("returns false for a path outside the base", () => {
    expect(isPathSafe("/tmp/skills", "/tmp/other/my-skill")).toBe(false);
  });

  it("returns false when target equals base", () => {
    expect(isPathSafe("/tmp/skills", "/tmp/skills")).toBe(false);
  });

  it("rejects traversal with ..", () => {
    expect(isPathSafe("/tmp/skills", "/tmp/skills/../other")).toBe(false);
  });
});

describe("computeContentHash", () => {
  it("is deterministic for same content", () => {
    const h1 = computeContentHash("hello");
    const h2 = computeContentHash("hello");
    expect(h1).toBe(h2);
  });

  it("differs for different content", () => {
    const h1 = computeContentHash("hello");
    const h2 = computeContentHash("world");
    expect(h1).not.toBe(h2);
  });

  it("returns a 64-char hex string", () => {
    const h = computeContentHash("test");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("parseSkillFrontmatter", () => {
  it("parses basic name and version", () => {
    const md = `---
name: my-skill
version: "1.0.0"
---
# My Skill`;
    const fm = parseSkillFrontmatter(md);
    expect(fm.name).toBe("my-skill");
    expect(fm.version).toBe("1.0.0");
  });

  it("parses platforms inline array", () => {
    const md = `---
name: my-skill
platforms: [macos, linux]
---
content`;
    const fm = parseSkillFrontmatter(md);
    expect(fm.platforms).toEqual(["macos", "linux"]);
  });

  it("parses requires with nested block", () => {
    const md = `---
name: my-skill
requires:
  bins:
    - uv
  env:
    - API_KEY
---
content`;
    const fm = parseSkillFrontmatter(md);
    expect(fm.requires?.bins).toEqual(["uv"]);
    expect(fm.requires?.env).toEqual(["API_KEY"]);
  });

  it("parses requires with inline array form", () => {
    const md = `---
name: my-skill
requires:
  bins: [uv, rg]
  env: [API_KEY]
---
content`;
    const fm = parseSkillFrontmatter(md);
    expect(fm.requires?.bins).toEqual(["uv", "rg"]);
    expect(fm.requires?.env).toEqual(["API_KEY"]);
  });

  it("returns empty object when no frontmatter", () => {
    const md = `# Just markdown, no frontmatter`;
    const fm = parseSkillFrontmatter(md);
    expect(fm).toEqual({});
  });

  it("handles single quotes", () => {
    const md = `---
name: 'my-skill'
version: '2.0'
---
content`;
    const fm = parseSkillFrontmatter(md);
    expect(fm.name).toBe("my-skill");
    expect(fm.version).toBe("2.0");
  });

  it("ignores unknown keys", () => {
    const md = `---
name: my-skill
unknown_key: value
---
content`;
    const fm = parseSkillFrontmatter(md);
    expect(fm.name).toBe("my-skill");
  });
});

describe("installToSkillsDir", () => {
  it("installs SKILL.md into ~/.novi/skills/<name>/", async () => {
    const { env } = await setup();
    const src = await mkdtemp(path.join(tmpdir(), "novi-src-"));
    cleanups.push(() => rm(src, { recursive: true, force: true }));
    await writeFile(path.join(src, "SKILL.md"), "---\nname: test\n---\ncontent");

    const result = await installToSkillsDir(env, src, "test");
    expect(result.path).toBe(path.join(noviHome, "skills", "test"));

    const installed = await readFile(path.join(result.path, "SKILL.md"), "utf8");
    expect(installed).toBe("---\nname: test\n---\ncontent");
  });

  it("copies companion directories", async () => {
    const { env } = await setup();
    const src = await mkdtemp(path.join(tmpdir(), "novi-src-"));
    cleanups.push(() => rm(src, { recursive: true, force: true }));
    await writeFile(path.join(src, "SKILL.md"), "content");
    await mkdir(path.join(src, "references"));
    await writeFile(path.join(src, "references", "ref.md"), "ref content");

    const result = await installToSkillsDir(env, src, "with-refs");
    const refContent = await readFile(path.join(result.path, "references", "ref.md"), "utf8");
    expect(refContent).toBe("ref content");
  });

  it("sanitizes the skill name", async () => {
    const { env } = await setup();
    const src = await mkdtemp(path.join(tmpdir(), "novi-src-"));
    cleanups.push(() => rm(src, { recursive: true, force: true }));
    await writeFile(path.join(src, "SKILL.md"), "content");

    const result = await installToSkillsDir(env, src, "My Cool Skill!");
    expect(result.path).toBe(path.join(noviHome, "skills", "my-cool-skill"));
  });

  it("overwrites an existing skill", async () => {
    const { env } = await setup();
    const src = await mkdtemp(path.join(tmpdir(), "novi-src-"));
    cleanups.push(() => rm(src, { recursive: true, force: true }));
    await writeFile(path.join(src, "SKILL.md"), "new content");

    await installToSkillsDir(env, src, "existing");
    const result = await installToSkillsDir(env, src, "existing");
    const installed = await readFile(path.join(result.path, "SKILL.md"), "utf8");
    expect(installed).toBe("new content");
  });
});

describe("deleteSkillDir", () => {
  it("deletes a skill directory", async () => {
    const { env } = await setup();
    const src = await mkdtemp(path.join(tmpdir(), "novi-src-"));
    cleanups.push(() => rm(src, { recursive: true, force: true }));
    await writeFile(path.join(src, "SKILL.md"), "content");
    await installToSkillsDir(env, src, "to-delete");

    const skillPath = path.join(noviHome, "skills", "to-delete");
    await deleteSkillDir(env, "to-delete");

    const exists = await env.exists(skillPath);
    expect(exists.ok).toBe(true);
    if (exists.ok) expect(exists.value).toBe(false);
  });

  it("does not throw when deleting a non-existent skill (force=true)", async () => {
    const { env } = await setup();
    await expect(deleteSkillDir(env, "nonexistent")).resolves.toBeUndefined();
  });
});

describe("fetchSkillFiles (url source)", () => {
  it("fetches SKILL.md from a URL", async () => {
    mockedGuardedRequest.mockResolvedValue(
      mockNetworkResponse(200, "---\nname: url-skill\n---\ncontent"),
    );

    const { fetchSkillFiles } = await import("./installer.js");
    const fetched = await fetchSkillFiles({
      type: "url",
      url: "https://example.com/SKILL.md",
      source: "https://example.com/SKILL.md",
    });
    cleanups.push(() => fetched.cleanup());

    const content = await readFile(path.join(fetched.dir, "SKILL.md"), "utf8");
    expect(content).toBe("---\nname: url-skill\n---\ncontent");
  });

  it("throws on non-200 response", async () => {
    mockedGuardedRequest.mockResolvedValue(mockNetworkResponse(404, "not found"));

    const { fetchSkillFiles } = await import("./installer.js");
    await expect(
      fetchSkillFiles({
        type: "url",
        url: "https://example.com/SKILL.md",
        source: "https://example.com/SKILL.md",
      }),
    ).rejects.toThrow();
  });
});

describe("fetchSkillFiles (local source)", () => {
  it("copies a local directory to a tmpdir", async () => {
    const src = await mkdtemp(path.join(tmpdir(), "novi-local-src-"));
    cleanups.push(() => rm(src, { recursive: true, force: true }));
    await writeFile(path.join(src, "SKILL.md"), "local content");

    const { fetchSkillFiles } = await import("./installer.js");
    const fetched = await fetchSkillFiles({
      type: "local",
      path: src,
      source: src,
    });
    cleanups.push(() => fetched.cleanup());

    const content = await readFile(path.join(fetched.dir, "SKILL.md"), "utf8");
    expect(content).toBe("local content");
  });

  it("throws when local path does not exist", async () => {
    const { fetchSkillFiles } = await import("./installer.js");
    await expect(
      fetchSkillFiles({
        type: "local",
        path: "/nonexistent/path/to/skill",
        source: "/nonexistent/path/to/skill",
      }),
    ).rejects.toThrow("not a directory");
  });
});

describe("fetchSkillFiles (git source)", () => {
  it("calls git clone with correct arguments", async () => {
    mockedExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: ExecCallback) => {
        cb(null, "", "");
      },
    );

    const { fetchSkillFiles } = await import("./installer.js");
    const fetched = await fetchSkillFiles({
      type: "git",
      owner: "octocat",
      repo: "hello-world",
      ref: "main",
      source: "git:octocat/hello-world@main",
    });
    cleanups.push(() => fetched.cleanup());

    expect(mockedExecFile).toHaveBeenCalled();
    const firstCall = mockedExecFile.mock.calls[0];
    expect(firstCall![0]).toBe("git");
    expect(firstCall![1]).toContain("clone");
    expect(firstCall![1]).toContain("https://github.com/octocat/hello-world.git");
  });

  it("throws clear error when git binary is missing", async () => {
    mockedExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: ExecCallback) => {
        cb(Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" }));
      },
    );

    const { fetchSkillFiles } = await import("./installer.js");
    await expect(
      fetchSkillFiles({
        type: "git",
        owner: "octocat",
        repo: "hello-world",
        source: "git:octocat/hello-world",
      }),
    ).rejects.toThrow("git binary not found");
  });
});

describe("fetchSkillFiles (well-known source)", () => {
  it("fetches index then SKILL.md", async () => {
    const indexJson = JSON.stringify({
      skills: [{ url: "https://example.com/skills/my-skill/SKILL.md" }],
    });
    const skillMd = "---\nname: wk-skill\n---\ncontent";

    mockedGuardedRequest
      .mockResolvedValueOnce(mockNetworkResponse(200, indexJson))
      .mockResolvedValueOnce(mockNetworkResponse(200, skillMd));

    const { fetchSkillFiles } = await import("./installer.js");
    const fetched = await fetchSkillFiles({
      type: "well-known",
      url: "https://example.com",
      source: "well-known:https://example.com",
    });
    cleanups.push(() => fetched.cleanup());

    const content = await readFile(path.join(fetched.dir, "SKILL.md"), "utf8");
    expect(content).toBe(skillMd);
    expect(mockedGuardedRequest).toHaveBeenCalledTimes(2);
  });

  it("throws when skill not found in index", async () => {
    mockedGuardedRequest.mockResolvedValue(
      mockNetworkResponse(200, JSON.stringify({ skills: [] })),
    );

    const { fetchSkillFiles } = await import("./installer.js");
    await expect(
      fetchSkillFiles({
        type: "well-known",
        url: "https://example.com",
        source: "well-known:https://example.com",
      }),
    ).rejects.toThrow("not found in well-known index");
  });
});
