import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  NodeExecutionEnv,
  formatSkillsForSystemPrompt,
} from "@earendil-works/pi-agent-core/node";
import { findGitRoot, loadResources, resolveSkillSources } from "./resources.js";

/** Minimal SKILL.md body; the loader joins frontmatter + body. */
function skillFile(
  name: string,
  description: string,
  body = "instructions",
  extraFrontmatter: Record<string, string> = {},
): string {
  const extras = Object.entries(extraFrontmatter)
    .map(([k, v]) => `${k}: ${v}\n`)
    .join("");
  return `---\nname: ${name}\ndescription: ${description}\n${extras}---\n${body}\n`;
}

async function makeSkillDir(
  root: string,
  name: string,
  description: string,
  body?: string,
  extraFrontmatter?: Record<string, string>,
): Promise<void> {
  const dir = path.join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "SKILL.md"),
    skillFile(name, description, body, extraFrontmatter),
    "utf8",
  );
}

describe("loadResources", () => {
  const cleanups: Array<() => Promise<void>> = [];
  const realHome = process.env.HOME;
  let home: string | undefined;

  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()!();
    if (home) await rm(home, { recursive: true, force: true });
    home = undefined;
    process.env.HOME = realHome;
  });

  async function setup(): Promise<{ env: NodeExecutionEnv; cwd: string }> {
    home = await mkdtemp(path.join(tmpdir(), "novi-resources-home-"));
    process.env.HOME = home;
    const cwd = await mkdtemp(path.join(tmpdir(), "novi-resources-"));
    const env = new NodeExecutionEnv({ cwd, shellEnv: process.env });
    cleanups.push(async () => {
      await env.cleanup();
      await rm(cwd, { recursive: true, force: true });
    });
    return { env, cwd };
  }

  it("loads project-level skills from <cwd>/.novi/skills", async () => {
    const { env, cwd } = await setup();
    await makeSkillDir(path.join(cwd, ".novi", "skills"), "fetch-weather", "Get weather");

    const result = await loadResources(env, cwd);

    expect(result.skills.map((s) => s.name)).toEqual(["fetch-weather"]);
    expect(result.skills[0]!.description).toBe("Get weather");
    expect(result.promptTemplates).toEqual([]);
  });

  it("lets project-level skills override user-level skills of the same name", async () => {
    const { env, cwd } = await setup();
    // User-level skill (under ~/.novi/skills). loadResources builds the user
    // path from os.homedir(), so place the fixture there.
    const homeSkills = path.join(home!, ".novi", "skills", "summarize-notes");
    await mkdir(homeSkills, { recursive: true });
    await writeFile(
      path.join(homeSkills, "SKILL.md"),
      skillFile("summarize-notes", "user-level description"),
      "utf8",
    );

    // Project-level override.
    await makeSkillDir(
      path.join(cwd, ".novi", "skills"),
      "summarize-notes",
      "project-level description",
    );

    const result = await loadResources(env, cwd);

    const skill = result.skills.find((s) => s.name === "summarize-notes");
    expect(skill).toBeDefined();
    expect(skill!.description).toBe("project-level description");
    expect(result.skills.filter((s) => s.name === "summarize-notes")).toHaveLength(1);
  });

  it("loads ~/.agents/skills and lets ~/.novi/skills override same name", async () => {
    const { env, cwd } = await setup();
    await makeSkillDir(
      path.join(home!, ".agents", "skills"),
      "shared-skill",
      "agents description",
    );
    await makeSkillDir(
      path.join(home!, ".novi", "skills"),
      "shared-skill",
      "novi description",
    );

    const result = await loadResources(env, cwd, { includeProject: false });
    const skill = result.skills.find((s) => s.name === "shared-skill");
    expect(skill).toBeDefined();
    expect(skill!.description).toBe("novi description");
  });

  it("loads project .agents/skills when trusted", async () => {
    const { env, cwd } = await setup();
    await makeSkillDir(
      path.join(cwd, ".agents", "skills"),
      "project-agents",
      "from project agents",
    );

    const result = await loadResources(env, cwd, { includeProject: true });
    expect(result.skills.map((s) => s.name)).toContain("project-agents");
  });

  it("skips project .agents and .novi skills when untrusted", async () => {
    const { env, cwd } = await setup();
    await makeSkillDir(
      path.join(cwd, ".agents", "skills"),
      "secret-agents",
      "should not load",
    );
    await makeSkillDir(
      path.join(cwd, ".novi", "skills"),
      "secret-novi",
      "should not load",
    );
    await makeSkillDir(
      path.join(home!, ".agents", "skills"),
      "user-agents",
      "user ok",
    );

    const result = await loadResources(env, cwd, { includeProject: false });
    expect(result.skills.map((s) => s.name)).toEqual(["user-agents"]);
  });

  it("loads ancestor .agents/skills from git root → cwd (near wins)", async () => {
    const { env, cwd: root } = await setup();
    // Layout: root/.git, root/.agents/skills/far, root/sub/.agents/skills/near
    // cwd = root/sub
    await mkdir(path.join(root, ".git"), { recursive: true });
    const sub = path.join(root, "sub");
    await mkdir(sub, { recursive: true });
    await makeSkillDir(path.join(root, ".agents", "skills"), "layered", "far");
    await makeSkillDir(path.join(sub, ".agents", "skills"), "layered", "near");

    const result = await loadResources(env, sub, { includeProject: true });
    const skill = result.skills.find((s) => s.name === "layered");
    expect(skill).toBeDefined();
    expect(skill!.description).toBe("near");
  });

  it("non-git project only scans cwd .agents/skills (not parents)", async () => {
    const { env, cwd: root } = await setup();
    // No .git anywhere. Parent has skills, child is cwd — parent must not load.
    const child = path.join(root, "child");
    await mkdir(child, { recursive: true });
    await makeSkillDir(path.join(root, ".agents", "skills"), "parent-only", "from parent");
    await makeSkillDir(path.join(child, ".agents", "skills"), "child-only", "from child");

    const result = await loadResources(env, child, { includeProject: true });
    expect(result.skills.map((s) => s.name)).toEqual(["child-only"]);
  });

  it("project .novi/skills overrides project .agents/skills of same name", async () => {
    const { env, cwd } = await setup();
    await makeSkillDir(path.join(cwd, ".agents", "skills"), "dup", "agents");
    await makeSkillDir(path.join(cwd, ".novi", "skills"), "dup", "novi");

    const result = await loadResources(env, cwd, { includeProject: true });
    const skill = result.skills.find((s) => s.name === "dup");
    expect(skill!.description).toBe("novi");
  });

  it("loads disable-model-invocation skills but keeps them out of system prompt", async () => {
    const { env, cwd } = await setup();
    await makeSkillDir(
      path.join(home!, ".novi", "skills"),
      "explicit-only",
      "manual only",
      undefined,
      { "disable-model-invocation": "true" },
    );
    await makeSkillDir(
      path.join(home!, ".novi", "skills"),
      "model-visible",
      "model can see",
    );

    const result = await loadResources(env, cwd, { includeProject: false });
    const explicit = result.skills.find((s) => s.name === "explicit-only");
    const visible = result.skills.find((s) => s.name === "model-visible");
    expect(explicit?.disableModelInvocation).toBe(true);
    expect(visible?.disableModelInvocation).toBeFalsy();

    // Still loaded for explicit /skill: invoke + slash list (AC5).
    expect(result.skills.map((s) => s.name).sort()).toEqual([
      "explicit-only",
      "model-visible",
    ]);

    const block = formatSkillsForSystemPrompt(result.skills);
    expect(block).toContain("model-visible");
    expect(block).not.toContain("explicit-only");
  });

  it("skips missing directories without errors", async () => {
    const { env, cwd } = await setup();
    const result = await loadResources(env, cwd);
    expect(result.skills).toEqual([]);
    expect(result.promptTemplates).toEqual([]);
  });
});

describe("findGitRoot / resolveSkillSources", () => {
  const cleanups: Array<() => Promise<void>> = [];
  const realHome = process.env.HOME;
  let home: string | undefined;

  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()!();
    if (home) await rm(home, { recursive: true, force: true });
    home = undefined;
    process.env.HOME = realHome;
  });

  async function setup(): Promise<{ env: NodeExecutionEnv; cwd: string }> {
    home = await mkdtemp(path.join(tmpdir(), "novi-gitroot-home-"));
    process.env.HOME = home;
    const cwd = await mkdtemp(path.join(tmpdir(), "novi-gitroot-"));
    const env = new NodeExecutionEnv({ cwd, shellEnv: process.env });
    cleanups.push(async () => {
      await env.cleanup();
      await rm(cwd, { recursive: true, force: true });
    });
    return { env, cwd };
  }

  it("findGitRoot returns the directory containing .git", async () => {
    const { env, cwd } = await setup();
    await mkdir(path.join(cwd, ".git"), { recursive: true });
    const deep = path.join(cwd, "a", "b");
    await mkdir(deep, { recursive: true });
    expect(await findGitRoot(env, deep)).toBe(path.resolve(cwd));
  });

  it("findGitRoot returns null when no .git exists", async () => {
    const { env, cwd } = await setup();
    expect(await findGitRoot(env, cwd)).toBeNull();
  });

  it("resolveSkillSources order matches D4 (user agents → user novi → project agents → project novi)", async () => {
    const { env, cwd } = await setup();
    await mkdir(path.join(cwd, ".git"), { recursive: true });
    const sub = path.join(cwd, "sub");
    await mkdir(sub, { recursive: true });

    const sources = await resolveSkillSources(env, sub, { includeProject: true });
    const paths = sources.map((s) => s.path);
    expect(paths[0]).toBe(path.join(home!, ".agents", "skills"));
    expect(paths[1]).toBe(path.join(home!, ".novi", "skills"));
    // git root → cwd ancestors
    expect(paths[2]).toBe(path.join(cwd, ".agents", "skills"));
    expect(paths[3]).toBe(path.join(sub, ".agents", "skills"));
    expect(paths[4]).toBe(path.join(sub, ".novi", "skills"));
    expect(sources.every((s, i) => (i < 2 ? s.source === "user" : s.source === "project"))).toBe(true);
  });

  it("resolveSkillSources omits project sources when untrusted", async () => {
    const { env, cwd } = await setup();
    const sources = await resolveSkillSources(env, cwd, { includeProject: false });
    expect(sources).toHaveLength(2);
    expect(sources.every((s) => s.source === "user")).toBe(true);
  });
});
