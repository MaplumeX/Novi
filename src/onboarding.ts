import type { ExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { Model, Api, Models } from "@earendil-works/pi-ai";
import { findEnvKeys, getEnvApiKey } from "@earendil-works/pi-ai/compat";
import type { ProviderEnv } from "@earendil-works/pi-ai";
import { loadSettings, resolveSettings, type SettingsCliOverrides } from "./settings.js";
import { loadCredentials, injectCredentialsIntoEnv } from "./credentials.js";
import { DEFAULT_PROVIDER, DEFAULT_MODEL_ID } from "./bootstrap.js";
import { loadTrust, resolveProjectTrust } from "./trust.js";
import { loadCustomModels } from "./models-loader.js";

/**
 * A sentinel env that reports *every* env var as set. Passing it to
 * `findEnvKeys` makes the "is this var set?" filter pass for every accepted
 * var, so the call returns the provider's full list of accepted env-var names
 * (not just the currently-set ones).
 *
 * This lets the wizard prompt for the right variable name without duplicating
 * pi-ai's internal provider→env-var mapping.
 */
const ALL_SET_ENV: ProviderEnv = new Proxy({}, {
  get: () => "x",
  has: () => true,
}) as ProviderEnv;

/**
 * Return the env-var names the given provider accepts for API-key auth, or
 * `undefined` for ambient-only providers (e.g. amazon-bedrock, google-vertex
 * with Application Default Credentials) that have no simple env-var key.
 */
export function providerEnvKeys(provider: string): string[] | undefined {
  return findEnvKeys(provider, ALL_SET_ENV);
}

/**
 * Resolve the candidate model the same way `bootstrap.resolveModel` would,
 * but without throwing. Returns `undefined` when the provider has no models
 * or no matching model is found.
 */
export function resolveCandidateModel(
  models: Models,
  provider: string,
  modelId: string | undefined,
): Model<Api> | undefined {
  const candidates = models.getModels(provider);
  if (candidates.length === 0) return undefined;
  if (modelId) {
    return models.getModel(provider, modelId) ?? undefined;
  }
  if (provider === DEFAULT_PROVIDER) {
    return models.getModel(provider, DEFAULT_MODEL_ID) ?? undefined;
  }
  return candidates[0];
}

/**
 * Pre-bootstrap probe: load settings + stored credentials, inject them into
 * the process env, and report whether the resolved provider/model currently
 * has a usable credential (via `models.getAuth`, no network call).
 *
 * Returns `{ configured, provider, modelId }` so the caller can format
 * headless guidance with the provider name.
 */
export async function probeProviderConfigured(
  env: ExecutionEnv,
  cli: SettingsCliOverrides,
): Promise<{ configured: boolean; provider: string; modelId: string | undefined }> {
  // Inject stored credentials first so pi-ai sees them for the auth check.
  const creds = await loadCredentials(env);
  injectCredentialsIntoEnv(creds, process.env);

  // Resolve trust conservatively: probe runs before bootstrap, in both headless
  // and TUI paths, with no overlay/prompt ability. So "ask" is treated as
  // "never" here — project settings do NOT participate in provider probing
  // when untrusted (mirrors pi: untrusted project settings are not loaded).
  const trustDb = await loadTrust(env);
  const decision = resolveProjectTrust(env.cwd, trustDb, { isHeadless: true });
  const trusted = decision === "always";

  const loadResult = await loadSettings(env, process.cwd(), { includeProject: trusted });
  const resolved = resolveSettings(loadResult.merged, loadResult.layers, cli);

  const models = builtinModels();
  // Register custom providers from models.json (project layer gated by trust)
  // so getAuth() can resolve them during the probe.
  const custom = await loadCustomModels(env, process.cwd(), { includeProject: trusted });
  for (const diagnostic of custom.diagnostics) {
    process.stderr.write(`warning: ${diagnostic}\n`);
  }
  for (const provider of custom.providers) {
    models.setProvider(provider);
  }
  const provider = cli.provider ?? resolved.defaultProvider ?? DEFAULT_PROVIDER;
  const modelId = cli.model ?? resolved.defaultModel;
  const model = resolveCandidateModel(models, provider, modelId);
  if (!model) {
    return { configured: false, provider, modelId };
  }
  const auth = await models.getAuth(model);
  return { configured: !!auth, provider, modelId };
}

/**
 * A friendly, actionable message printed to stderr when headless mode
 * (`--print` / `--mode json`) runs with no usable credentials.
 */
export function formatHeadlessGuidance(provider: string): string {
  const envKeys = providerEnvKeys(provider);
  const envHint = envKeys && envKeys.length > 0
    ? `Set ${envKeys.join(" or ")} in your environment`
    : `Configure credentials for the "${provider}" provider`;
  return (
    `No API key found for provider "${provider}".\n` +
    `${envHint}, or run \`novi\` (without --print/--mode json) to use the setup wizard.`
  );
}

// Re-export so the wizard does not depend on the compat subpath directly.
export { builtinModels, getEnvApiKey };
