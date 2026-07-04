import path from "node:path";
import { NodeExecutionEnv, AgentHarness, JsonlSessionRepo, uuidv7 } from "@earendil-works/pi-agent-core/node";
import type {
  JsonlSessionMetadata,
  Session,
  ExecutionEnv,
  ThinkingLevel,
} from "@earendil-works/pi-agent-core/node";
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { formatSkillsForSystemPrompt } from "@earendil-works/pi-agent-core/node";
import type { AgentHarnessResources } from "@earendil-works/pi-agent-core/node";
import { getNoviDir, getSessionsDir } from "./config.js";
import { DEFAULT_SYSTEM_PROMPT } from "./default-system-prompt.js";
import { createBuiltinTools } from "./tools/index.js";
import { loadResources } from "./resources.js";
import { loadCustomModels } from "./models-loader.js";
import { loadHooks, registerHooks } from "./hooks/index.js";
import {
  loadCredentials,
  injectCredentialsIntoEnv,
} from "./credentials.js";
import {
  loadSettings,
  resolveSettings,
  getAgentsMdCandidates,
  type ResolvedSettings,
} from "./settings.js";

/** Default provider used when `--provider` is not given. */
export const DEFAULT_PROVIDER = "anthropic";
/** Default model id under the default provider. */
export const DEFAULT_MODEL_ID = "claude-sonnet-4-5";
/** Default thinking level when none is configured. */
export const DEFAULT_THINKING_LEVEL: ThinkingLevel = "medium";

export interface BootstrapOptions {
  /** Working directory. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Provider id (e.g. "anthropic"). Defaults to settings or {@link DEFAULT_PROVIDER}. */
  provider?: string;
  /** Model id under the provider. Defaults to settings or a sensible built-in. */
  model?: string;
  /** Thinking level. Defaults to settings or {@link DEFAULT_THINKING_LEVEL}. */
  thinkingLevel?: ThinkingLevel;
  /** Optional path to an existing session file to resume. */
  resumePath?: string;
  /**
   * Whether project-level resources (`.novi/settings.json`, `.novi/skills`,
   * `.novi/prompts`) are trusted and should be loaded. Defaults to `true`
   * (backward compat). When `false`, only global resources are loaded.
   */
  trusted?: boolean;
}

export interface BootstrapResult {
  harness: AgentHarness;
  env: ExecutionEnv;
  models: Models;
  model: Model<Api>;
  session: Session<JsonlSessionMetadata>;
  /** Absolute path of the active session JSONL file. */
  sessionPath: string;
  /** Working directory passed to bootstrap. */
  cwd: string;
  /** Resolved settings (merged + CLI overrides + provenance). */
  resolvedSettings: ResolvedSettings;
  /** System-prompt provider (reused when rebuilding the harness on /reload). */
  systemPrompt: (ctx: {
    env: ExecutionEnv;
    resources: AgentHarnessResources;
  }) => Promise<string>;
  /** Raw CLI overrides (provider/model/thinking) for /settings re-resolution. */
  cliOverrides: { provider?: string; model?: string; thinkingLevel?: ThinkingLevel };
  /** Whether project-level resources were loaded (trust gate result). */
  trusted: boolean;
  /** Scoped-model patterns from settings (for Ctrl+P cycling). */
  scopedModels: string[];
}

/**
 * Resolve a concrete model from the provider collection.
 * Throws a clear error when the provider has no models or is not configured.
 */
async function resolveModel(
  models: Models,
  provider: string,
  modelId: string | undefined,
): Promise<Model<Api>> {
  const candidates = models.getModels(provider);
  if (candidates.length === 0) {
    throw new Error(
      `provider "${provider}" has no registered models. ` +
        `Run with --provider <id> to pick another provider.`,
    );
  }
  const model = modelId
    ? (models.getModel(provider, modelId) ?? undefined)
    : (provider === DEFAULT_PROVIDER
        ? (models.getModel(provider, DEFAULT_MODEL_ID) ?? undefined)
        : undefined) ?? candidates[0];
  if (!model) {
    const requested = modelId ?? (provider === DEFAULT_PROVIDER ? DEFAULT_MODEL_ID : "");
    throw new Error(
      `model "${requested}" not found for provider "${provider}". ` +
        `Available: ${candidates.map((m) => m.id).join(", ")}`,
    );
  }
  const auth = await models.getAuth(model);
  if (!auth) {
    const envHint =
      provider === "anthropic"
        ? " Set ANTHROPIC_API_KEY (or ANTHROPIC_OAUTH_TOKEN) in your environment."
        : "";
    throw new Error(
      `provider "${provider}" is not configured (no API key found).${envHint}`,
    );
  }
  return model;
}

/**
 * System-prompt provider callback. Assembles the model-visible prompt from:
 *
 * 1. **base**: `.novi/SYSTEM.md` (project) → `~/.novi/SYSTEM.md` (global) →
 *    `.novi/system-prompt.md` (compat) → `~/.novi/system-prompt.md` (compat) →
 *    {@link DEFAULT_SYSTEM_PROMPT}. Project > global; SYSTEM.md > legacy
 *    `system-prompt.md`.
 * 2. **appendBlock**: `.novi/APPEND_SYSTEM.md` (project) +
 *    `~/.novi/APPEND_SYSTEM.md` (global) — both appended (project first) when
 *    present.
 * 3. **contextBlock**: AGENTS.md candidate files (global + parent dirs + cwd),
 *    deduplicated, concatenated.
 * 4. **skillsBlock**: model-visible skills block from the harness resource
 *    snapshot.
 *
 * Sections are joined with blank-line separators; empty sections are omitted.
 */
function makeSystemPromptProvider(cwd: string): (ctx: {
  env: ExecutionEnv;
  resources: AgentHarnessResources;
}) => Promise<string> {
  // Legacy system-prompt.md candidates (compat fallback, before SYSTEM.md).
  const noviDir = getNoviDir();
  const systemMdCandidates = [
    path.join(cwd, ".novi", "SYSTEM.md"),
    path.join(noviDir, "SYSTEM.md"),
    // Legacy compat (recommended migration to SYSTEM.md).
    path.join(cwd, ".novi", "system-prompt.md"),
    path.join(noviDir, "system-prompt.md"),
  ];
  const appendCandidates = [
    path.join(cwd, ".novi", "APPEND_SYSTEM.md"),
    path.join(noviDir, "APPEND_SYSTEM.md"),
  ];
  const agentsMdCandidates = getAgentsMdCandidates(cwd);

  return async ({ env, resources }: { env: ExecutionEnv; resources: AgentHarnessResources }): Promise<string> => {
    // 1. base prompt
    let base = DEFAULT_SYSTEM_PROMPT;
    for (const candidate of systemMdCandidates) {
      const result = await env.readTextFile(candidate);
      if (result.ok && result.value.trim().length > 0) {
        base = result.value;
        break;
      }
    }

    // 2. append block (both layers, project first)
    const appendParts: string[] = [];
    for (const candidate of appendCandidates) {
      const result = await env.readTextFile(candidate);
      if (result.ok && result.value.trim().length > 0) {
        appendParts.push(result.value.trim());
      }
    }

    // 3. context files (AGENTS.md)
    const contextParts: string[] = [];
    for (const candidate of agentsMdCandidates) {
      const result = await env.readTextFile(candidate);
      if (result.ok && result.value.trim().length > 0) {
        contextParts.push(result.value.trim());
      }
    }

    // 4. skills block
    const skillsBlock = formatSkillsForSystemPrompt(resources.skills ?? []);

    const parts = [base.trim(), ...appendParts, ...contextParts, skillsBlock];
    return parts.filter((s) => s.length > 0).join("\n\n");
  };
}

async function ensureDir(env: ExecutionEnv, dir: string): Promise<void> {
  const result = await env.createDir(dir, { recursive: true });
  if (!result.ok) {
    throw new Error(`failed to create directory ${dir}: ${result.error.message}`);
  }
}

/**
 * Assemble env / session / models / harness.
 *
 * Uses the public `JsonlSessionRepo` API (see research/api-deviations.md for why
 * `JsonlSessionStorage` is not used) and `builtinModels()` so provider API keys
 * are auto-read from the environment by pi-ai.
 */
export async function bootstrap(options: BootstrapOptions = {}): Promise<BootstrapResult> {
  const cwd = options.cwd ?? process.cwd();
  const trusted = options.trusted !== false; // default true (backward compat)

  const env = new NodeExecutionEnv({ cwd, shellEnv: process.env });

  // Inject any stored credentials (from ~/.novi/credentials.json) into the
  // process env before resolving the model, so pi-ai's getAuth sees them.
  // Only keys absent from the environment are injected — a user who exports an
  // env var always wins over the stored value.
  const storedCreds = await loadCredentials(env);
  injectCredentialsIntoEnv(storedCreds, process.env);

  const sessionsDir = getSessionsDir();
  await ensureDir(env, getNoviDir());
  await ensureDir(env, sessionsDir);

  // Load settings (global + project merge). Parse failures are non-fatal warnings.
  // Project layer is skipped when untrusted (trust gate).
  const loadResult = await loadSettings(env, cwd, { includeProject: trusted });
  for (const diagnostic of loadResult.diagnostics) {
    process.stderr.write(`warning: ${diagnostic}\n`);
  }
  const resolvedSettings = resolveSettings(
    loadResult.merged,
    loadResult.layers,
    {
      provider: options.provider,
      model: options.model,
      thinkingLevel: options.thinkingLevel,
    },
  );

  const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: sessionsDir });
  let session: Session<JsonlSessionMetadata>;
  if (options.resumePath) {
    const absResult = await env.absolutePath(options.resumePath);
    if (!absResult.ok) {
      throw new Error(`invalid resume path ${options.resumePath}: ${absResult.error.message}`);
    }
    session = await repo.open({ path: absResult.value } as JsonlSessionMetadata);
  } else {
    session = await repo.create({ cwd, id: uuidv7() });
  }
  const metadata = await session.getMetadata();
  const sessionPath = metadata.path;

  const models = builtinModels();
  // Register custom providers from ~/.novi/models.json + <cwd>/.novi/models.json
  // (project layer gated by trust). Same-id provider overrides built-in
  // (setProvider upsert). Diagnostics are non-fatal warnings.
  const custom = await loadCustomModels(env, cwd, { includeProject: trusted });
  for (const diagnostic of custom.diagnostics) {
    process.stderr.write(`warning: ${diagnostic}\n`);
  }
  for (const provider of custom.providers) {
    models.setProvider(provider);
  }
  const provider = resolvedSettings.defaultProvider ?? DEFAULT_PROVIDER;
  const model = await resolveModel(models, provider, resolvedSettings.defaultModel);

  const systemPrompt = makeSystemPromptProvider(cwd);

  const harness = new AgentHarness({
    env,
    session,
    models,
    model,
    systemPrompt,
    thinkingLevel: resolvedSettings.defaultThinkingLevel ?? DEFAULT_THINKING_LEVEL,
  });

  // Register the built-in tool set. `setTools` keeps the previous
  // `activeToolNames` when none are passed, so pass all names explicitly to
  // activate every tool by default.
  const tools = createBuiltinTools(env, metadata.id);
  await harness.setTools(tools, tools.map((t) => t.name));

  // Load skills + prompt templates (user + project) and publish them to the
  // harness. The system-prompt provider reads `resources.skills` each turn.
  // Project layer is skipped when untrusted (trust gate).
  const loaded = await loadResources(env, cwd, { includeProject: trusted });
  for (const diagnostic of loaded.diagnostics) {
    process.stderr.write(`warning: ${diagnostic}\n`);
  }
  await harness.setResources({
    skills: loaded.skills,
    promptTemplates: loaded.promptTemplates,
  });

  // Load and register user/project hook scripts (trust gate applies to the
  // project layer). Diagnostics are non-fatal warnings surfaced to stderr.
  const hookConfig = await loadHooks(env, cwd, { includeProject: trusted });
  for (const diagnostic of hookConfig.diagnostics) {
    process.stderr.write(`warning: ${diagnostic}\n`);
  }
  registerHooks(harness, hookConfig, { env, cwd, sessionId: metadata.id });

  // Retry/provider options: pass through to the harness via setStreamOptions.
  // transport is forwarded together with retry fields (single setStreamOptions
  // call). Actual consumption (observability) is child 7; this child only
  // wires the settings → harness path so /reload re-applies them.
  const retry = resolvedSettings.retry?.provider;
  const transport = resolvedSettings.transport;
  if (
    transport !== undefined ||
    (retry && (retry.timeoutMs !== undefined || retry.maxRetries !== undefined || retry.maxRetryDelayMs !== undefined))
  ) {
    await harness.setStreamOptions({
      ...(transport !== undefined ? { transport } : {}),
      ...(retry?.timeoutMs !== undefined ? { timeoutMs: retry.timeoutMs } : {}),
      ...(retry?.maxRetries !== undefined ? { maxRetries: retry.maxRetries } : {}),
      ...(retry?.maxRetryDelayMs !== undefined ? { maxRetryDelayMs: retry.maxRetryDelayMs } : {}),
    });
  }

  // Queue delivery modes (steering/followUp): applied at bootstrap so settings
  // take effect immediately; replayed on harness rebuild by replayHarnessState.
  if (resolvedSettings.steeringMode) {
    await harness.setSteeringMode(resolvedSettings.steeringMode);
  }
  if (resolvedSettings.followUpMode) {
    await harness.setFollowUpMode(resolvedSettings.followUpMode);
  }

  return {
    harness,
    env,
    models,
    model,
    session,
    sessionPath,
    cwd,
    resolvedSettings,
    systemPrompt,
    cliOverrides: {
      provider: options.provider,
      model: options.model,
      thinkingLevel: options.thinkingLevel,
    },
    trusted,
    scopedModels: resolvedSettings.scopedModels ?? [],
  };
}
