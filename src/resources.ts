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
import os from "node:os";
import path from "node:path";

/** Resources loaded for the harness: model-visible skills + prompt templates. */
export interface LoadedResources {
  skills: Skill[];
  promptTemplates: PromptTemplate[];
  /** Non-fatal warning messages (loaders skip invalid files, never throw). */
  diagnostics: string[];
}

export type SkillSource = { path: string; source: "user" | "project" };

/**
 * Walk parents from `cwd` looking for a `.git` file or directory.
 * Returns the directory containing `.git`, or `null` if none is found
 * before the filesystem root. Pure env IO — no child_process.
 */
export async function findGitRoot(
  env: ExecutionEnv,
  cwd: string,
): Promise<string | null> {
  let dir = path.resolve(cwd);
  for (;;) {
    const info = await env.fileInfo(path.join(dir, ".git"));
    if (info.ok) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Collect absolute directories from `root` down to `cwd` (inclusive),
 * walking upward from cwd and reversing so the result is root → cwd.
 */
function collectAncestorsRootToCwd(root: string, cwd: string): string[] {
  const absRoot = path.resolve(root);
  const absCwd = path.resolve(cwd);
  const stack: string[] = [];
  let dir = absCwd;
  for (;;) {
    stack.push(dir);
    if (dir === absRoot) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return stack.reverse();
}

/**
 * Resolve skill source directories in D4 load order (later wins on name
 * collision):
 *
 * 1. `~/.agents/skills` (user, never trust-gated)
 * 2. `~/.novi/skills` (user, never trust-gated)
 * 3. each `dir/.agents/skills` from git root → cwd (project, gated)
 * 4. `<cwd>/.novi/skills` (project, gated)
 *
 * Non-git trees degenerate to `[cwd]` for the project `.agents` scan.
 * Project sources are omitted when `includeProject` is false.
 */
export async function resolveSkillSources(
  env: ExecutionEnv,
  cwd: string,
  opts: { includeProject?: boolean } = {},
): Promise<SkillSource[]> {
  const home = os.homedir();
  const sources: SkillSource[] = [
    { path: path.join(home, ".agents", "skills"), source: "user" },
    { path: path.join(getNoviDir(), "skills"), source: "user" },
  ];

  if (opts.includeProject === false) return sources;

  const gitRoot = await findGitRoot(env, cwd);
  const ancestors = gitRoot
    ? collectAncestorsRootToCwd(gitRoot, cwd)
    : [path.resolve(cwd)];

  for (const dir of ancestors) {
    sources.push({ path: path.join(dir, ".agents", "skills"), source: "project" });
  }
  sources.push({ path: path.join(cwd, ".novi", "skills"), source: "project" });
  return sources;
}

/**
 * Load skills and prompt templates from user-level and project-level
 * directories (see {@link resolveSkillSources} for skill path precedence).
 *
 * Skills are deduplicated by name with **later sources overriding earlier**
 * (project near cwd / `.novi` wins over user / distant ancestors). Prompt
 * templates are not deduplicated — both layers are passed through. Missing
 * directories are skipped by the loaders, so no existence filtering is needed.
 *
 * `NodeExecutionEnv` does not expand `~`, so user paths are resolved with
 * `os.homedir()` / {@link getNoviDir}.
 */
export async function loadResources(
  env: ExecutionEnv,
  cwd: string,
  opts: { includeProject?: boolean } = {},
): Promise<LoadedResources> {
  const userPromptsDir = path.join(getNoviDir(), "prompts");

  const skillSources = await resolveSkillSources(env, cwd, opts);
  const promptDirs: string[] = [userPromptsDir];
  if (opts.includeProject !== false) {
    promptDirs.push(path.join(cwd, ".novi", "prompts"));
  }

  const { skills, diagnostics: skillDiagnostics } = await loadSourcedSkills(
    env,
    skillSources,
  );
  // Dedupe by name: later entries overwrite earlier ones. The loader returns
  // skills in input order (sources order), so later sources win.
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
