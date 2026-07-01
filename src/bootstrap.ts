import { NodeExecutionEnv, AgentHarness, JsonlSessionRepo, uuidv7 } from "@earendil-works/pi-agent-core/node";
import type {
  JsonlSessionMetadata,
  Session,
  ExecutionEnv,
} from "@earendil-works/pi-agent-core/node";
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { getNoviDir, getSessionsDir, getSystemPromptCandidates } from "./config.js";
import { DEFAULT_SYSTEM_PROMPT } from "./default-system-prompt.js";

/** Default provider used when `--provider` is not given. */
export const DEFAULT_PROVIDER = "anthropic";
/** Default model id under the default provider. */
export const DEFAULT_MODEL_ID = "claude-sonnet-4-5";

export interface BootstrapOptions {
  /** Working directory. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Provider id (e.g. "anthropic"). Defaults to {@link DEFAULT_PROVIDER}. */
  provider?: string;
  /** Model id under the provider. Defaults to a sensible built-in. */
  model?: string;
  /** Optional path to an existing session file to resume. */
  resumePath?: string;
}

export interface BootstrapResult {
  harness: AgentHarness;
  env: ExecutionEnv;
  models: Models;
  model: Model<Api>;
  session: Session<JsonlSessionMetadata>;
  /** Absolute path of the active session JSONL file. */
  sessionPath: string;
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
  // When --model is not given, prefer the documented stable default for the
  // default provider; otherwise fall back to the first catalog entry. Catalog
  // order is not guaranteed to be newest-first, so without this the default
  // provider would resolve to a stale legacy model.
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
 * System-prompt provider callback. Reads `.novi/system-prompt.md`, then
 * `~/.novi/system-prompt.md`, falling back to {@link DEFAULT_SYSTEM_PROMPT}.
 */
function makeSystemPromptProvider(cwd: string) {
  const candidates = getSystemPromptCandidates(cwd);
  return async ({ env }: { env: ExecutionEnv }): Promise<string> => {
    for (const candidate of candidates) {
      const result = await env.readTextFile(candidate);
      if (result.ok && result.value.trim().length > 0) {
        return result.value;
      }
    }
    return DEFAULT_SYSTEM_PROMPT;
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

  const env = new NodeExecutionEnv({ cwd, shellEnv: process.env });

  const sessionsDir = getSessionsDir();
  await ensureDir(env, getNoviDir());
  await ensureDir(env, sessionsDir);

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
  const provider = options.provider ?? DEFAULT_PROVIDER;
  const model = await resolveModel(models, provider, options.model);

  const systemPrompt = makeSystemPromptProvider(cwd);

  const harness = new AgentHarness({
    env,
    session,
    models,
    model,
    systemPrompt,
  });

  return { harness, env, models, model, session, sessionPath };
}
