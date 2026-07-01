import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { loadResources } from "./resources.js";

/** Minimal SKILL.md body; the loader joins frontmatter + body. */
function skillFile(name: string, description: string, body = "instructions"): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`;
}

async function makeSkillDir(root: string, name: string, description: string, body?: string): Promise<void> {
  const dir = path.join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "SKILL.md"), skillFile(name, description, body), "utf8");
}

describe("loadResources", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()!();
  });

  async function setup(): Promise<{ env: NodeExecutionEnv; cwd: string }> {
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
    expect(result.skills[0].description).toBe("Get weather");
    expect(result.promptTemplates).toEqual([]);
  });

  it("lets project-level skills override user-level skills of the same name", async () => {
    const { env, cwd } = await setup();
    // User-level skill (under ~/.novi/skills). loadResources builds the user
    // path from os.homedir(), so place the fixture there.
    const homeSkills = path.join(process.env.HOME ?? "", ".novi", "skills", "summarize-notes");
    await mkdir(homeSkills, { recursive: true });
    cleanups.push(async () => {
      await rm(path.join(process.env.HOME ?? "", ".novi", "skills", "summarize-notes"), {
        recursive: true,
        force: true,
      });
    });
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

  it("skips missing directories without errors", async () => {
    const { env, cwd } = await setup();
    const result = await loadResources(env, cwd);
    expect(result.skills).toEqual([]);
    expect(result.promptTemplates).toEqual([]);
  });
});
