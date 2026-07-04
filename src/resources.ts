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
  opts: { includeProject?: boolean } = {},
): Promise<LoadedResources> {
  const userSkillsDir = path.join(getNoviDir(), "skills");
  const userPromptsDir = path.join(getNoviDir(), "prompts");

  // Project layer (skills/prompts) is loaded only when trusted (gate). When
  // `includeProject` is false, scan only the user-level directories.
  const skillSources: Array<{ path: string; source: "user" | "project" }> = [
    { path: userSkillsDir, source: "user" },
  ];
  const promptDirs: string[] = [userPromptsDir];
  if (opts.includeProject !== false) {
    skillSources.push({ path: path.join(cwd, ".novi", "skills"), source: "project" });
    promptDirs.push(path.join(cwd, ".novi", "prompts"));
  }

  const { skills, diagnostics: skillDiagnostics } = await loadSourcedSkills(
    env,
    skillSources,
  );
  // Dedupe by name: later entries overwrite earlier ones. The loader returns
  // skills in input order (user → project), so project wins.
  const byName = new Map<string, Skill>();
  for (const { skill } of skills) byName.set(skill.name, skill);

  const { promptTemplates, diagnostics: promptDiagnostics } =
    await loadPromptTemplates(env, promptDirs);

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
