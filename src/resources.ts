import {
  loadSourcedSkills,
  loadPromptTemplates,
} from "@earendil-works/pi-agent-core/node";
import type {
  ExecutionEnv,
  Skill,
  PromptTemplate,
} from "@earendil-works/pi-agent-core/node";
import { getNoviDir } from "./config.js";
import path from "node:path";

/** Resources loaded for the harness: model-visible skills + prompt templates. */
export interface LoadedResources {
  skills: Skill[];
  promptTemplates: PromptTemplate[];
  /** Non-fatal warning messages (loaders skip invalid files, never throw). */
  diagnostics: string[];
}

/**
 * Load skills and prompt templates from user-level (`~/.novi`) and project-level
 * (`<cwd>/.novi`) directories.
 *
 * Skills are deduplicated by name with **project overriding user** (project is
 * scanned after user, so it wins in the dedupe map). Prompt templates are not
 * deduplicated — both layers are passed through. Missing directories are skipped
 * by the loaders, so no existence filtering is needed here.
 *
 * `NodeExecutionEnv` does not expand `~`, so the user path is resolved with
 * `os.homedir()` via {@link getNoviDir}.
 */
export async function loadResources(
  env: ExecutionEnv,
  cwd: string,
): Promise<LoadedResources> {
  const userSkillsDir = path.join(getNoviDir(), "skills");
  const projectSkillsDir = path.join(cwd, ".novi", "skills");
  const userPromptsDir = path.join(getNoviDir(), "prompts");
  const projectPromptsDir = path.join(cwd, ".novi", "prompts");

  const { skills, diagnostics: skillDiagnostics } = await loadSourcedSkills(
    env,
    [
      { path: userSkillsDir, source: "user" },
      { path: projectSkillsDir, source: "project" },
    ],
  );
  // Dedupe by name: later entries overwrite earlier ones. The loader returns
  // skills in input order (user → project), so project wins.
  const byName = new Map<string, Skill>();
  for (const { skill } of skills) byName.set(skill.name, skill);

  const { promptTemplates, diagnostics: promptDiagnostics } =
    await loadPromptTemplates(env, [userPromptsDir, projectPromptsDir]);

  const diagnostics: string[] = [];
  for (const d of skillDiagnostics) {
    diagnostics.push(`skill [${d.source}] ${d.code}: ${d.message}`);
  }
  for (const d of promptDiagnostics) {
    diagnostics.push(`prompt-template ${d.code}: ${d.message}`);
  }

  return {
    skills: [...byName.values()],
    promptTemplates,
    diagnostics,
  };
}
