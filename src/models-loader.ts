import path from "node:path";
import type { ExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { Api, Model, Provider, ProviderHeaders } from "@earendil-works/pi-ai";
import {
  createProvider,
  envApiKeyAuth,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { mistralConversationsApi } from "@earendil-works/pi-ai/api/mistral-conversations.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { azureOpenAIResponsesApi } from "@earendil-works/pi-ai/api/azure-openai-responses.lazy";
import { bedrockConverseStreamApi } from "@earendil-works/pi-ai/api/bedrock-converse-stream.lazy";
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";
import { googleVertexApi } from "@earendil-works/pi-ai/api/google-vertex.lazy";
import { openAICodexResponsesApi } from "@earendil-works/pi-ai/api/openai-codex-responses.lazy";
import { getNoviDir } from "./config.js";

/** `api` literal → `ProviderStreams` factory (lazy-loaded). Mirrors pi-ai's
 *  built-in factory wiring so a models.json provider speaks the same API. */
const API_FACTORIES: Record<string, () => ReturnType<typeof openAICompletionsApi>> = {
  "openai-completions": openAICompletionsApi,
  "openai-responses": openAIResponsesApi,
  "anthropic-messages": anthropicMessagesApi,
  "mistral-conversations": mistralConversationsApi,
  "azure-openai-responses": azureOpenAIResponsesApi,
  "openai-codex-responses": openAICodexResponsesApi,
  "bedrock-converse-stream": bedrockConverseStreamApi,
  "google-generative-ai": googleGenerativeAIApi,
  "google-vertex": googleVertexApi,
};

/** Result of loading custom providers from models.json. */
export interface LoadedCustomModels {
  providers: Provider[];
  /** Non-fatal warnings (missing file → empty, no diagnostics). */
  diagnostics: string[];
}

/** A provider spec parsed from models.json before construction. */
interface ParsedProviderSpec {
  id: string;
  name?: string;
  baseUrl?: string;
  headers?: ProviderHeaders;
  api: string;
  apiKey?: string;   // literal or "$ENV_VAR"
  models: RawModelSpec[];
  compat?: unknown;  // ignored this round (Out of Scope), for forward-compat
}

interface RawModelSpec {
  id: string;
  name?: string;
  reasoning?: boolean;
  input?: ("text" | "image")[];
  contextWindow?: number;
  maxTokens?: number;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

/**
 * Load custom providers from `~/.novi/models.json` (global) and
 * `<cwd>/.novi/models.json` (project, overrides global same-id providers).
 *
 * Schema mirrors pi's models.json subset: `{ "providers": { "<id>": { baseUrl,
 * api, apiKey: "literal" | "$VAR", name?, models: [...] } } }`. The `compat`
 * field is parsed but ignored this round (forward-compat; emits no warning).
 *
 * Degradation (mirrors settings/resources): a missing file is empty; JSON that
 * fails to parse or isn't an object contributes a diagnostic and an empty list;
 * per-provider validation failures skip that provider and emit a diagnostic.
 * Never throws — startup is never blocked.
 *
 * `apiKey` resolution:
 * - `"$ENV_VAR"` → `envApiKeyAuth(<name>, [VAR])`: `Models.getAuth()` reads the
 *   env var at resolve time; missing → unconfigured (`/model` hides it).
 * - literal (`"ollama"`) → a fixed key returned by a tiny resolver, so the
 *   provider is always considered configured.
 * - omitted → `envApiKeyAuth` with an empty var list → never configured.
 */
export async function loadCustomModels(
  env: ExecutionEnv,
  cwd: string,
  opts: { includeProject?: boolean } = {},
): Promise<LoadedCustomModels> {
  const diagnostics: string[] = [];
  const globalPath = path.join(getNoviDir(), "models.json");
  const projectPath = path.join(cwd, ".novi", "models.json");

  const globalSpecs = await readProviderSpecs(env, globalPath, "global", diagnostics);
  const projectSpecs = opts.includeProject === false
    ? []
    : await readProviderSpecs(env, projectPath, "project", diagnostics);

  // Merge: same-id provider from project overrides global (project registered later).
  const specs = [...globalSpecs, ...projectSpecs];

  const providers: Provider[] = [];
  for (const spec of specs) {
    const built = buildProvider(spec, diagnostics);
    if (built) providers.push(built);
  }

  return { providers, diagnostics };
}

/** Read and validate the `providers` map from one models.json file. */
async function readProviderSpecs(
  env: ExecutionEnv,
  filePath: string,
  label: string,
  diagnostics: string[],
): Promise<ParsedProviderSpec[]> {
  const result = await env.readTextFile(filePath);
  if (!result.ok) return []; // missing file is expected
  const text = result.value.trim();
  if (!text) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    diagnostics.push(
      `models.json [${label}] failed to parse ${filePath}: ${e instanceof Error ? e.message : String(e)}`,
    );
    return [];
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    diagnostics.push(`models.json [${label}] root is not a JSON object: ${filePath}`);
    return [];
  }
  const providersMap = (parsed as { providers?: unknown }).providers;
  if (providersMap === undefined || providersMap === null) {
    return [];
  }
  if (typeof providersMap !== "object" || Array.isArray(providersMap)) {
    diagnostics.push(`models.json [${label}] "providers" is not an object: ${filePath}`);
    return [];
  }

  const specs: ParsedProviderSpec[] = [];
  for (const [id, raw] of Object.entries(providersMap as Record<string, unknown>)) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      diagnostics.push(`models.json [${label}] provider "${id}" is not an object: ${filePath}`);
      continue;
    }
    const r = raw as Record<string, unknown>;
    const api = typeof r.api === "string" ? r.api : undefined;
    if (!api) {
      // google providers may omit baseUrl in pi but always set api; require api here.
      diagnostics.push(`models.json [${label}] provider "${id}" missing required "api": ${filePath}`);
      continue;
    }
    const modelsRaw = Array.isArray(r.models) ? r.models : [];
    const models: RawModelSpec[] = [];
    for (const m of modelsRaw) {
      if (m === null || typeof m !== "object" || Array.isArray(m)) {
        diagnostics.push(`models.json [${label}] provider "${id}" has a non-object model: ${filePath}`);
        continue;
      }
      const mr = m as Record<string, unknown>;
      if (typeof mr.id !== "string" || !mr.id) {
        diagnostics.push(`models.json [${label}] provider "${id}" model missing "id": ${filePath}`);
        continue;
      }
      models.push({
        id: mr.id,
        name: typeof mr.name === "string" ? mr.name : undefined,
        reasoning: typeof mr.reasoning === "boolean" ? mr.reasoning : undefined,
        input: Array.isArray(mr.input) ? (mr.input as ("text" | "image")[]) : undefined,
        contextWindow: typeof mr.contextWindow === "number" ? mr.contextWindow : undefined,
        maxTokens: typeof mr.maxTokens === "number" ? mr.maxTokens : undefined,
        cost:
          mr.cost !== null && typeof mr.cost === "object" && !Array.isArray(mr.cost)
            ? (mr.cost as RawModelSpec["cost"])
            : undefined,
      });
    }
    specs.push({
      id,
      name: typeof r.name === "string" ? r.name : undefined,
      baseUrl: typeof r.baseUrl === "string" ? r.baseUrl : undefined,
      headers: r.headers !== null && typeof r.headers === "object" && !Array.isArray(r.headers)
        ? (r.headers as ProviderHeaders)
        : undefined,
      api,
      apiKey: typeof r.apiKey === "string" ? r.apiKey : undefined,
      models,
      compat: r.compat,  // kept for forward-compat; not consumed this round
    });
  }
  return specs;
}

/** Construct a `Provider` from a parsed spec, or return undefined + diagnostic. */
function buildProvider(spec: ParsedProviderSpec, diagnostics: string[]): Provider | undefined {
  const apiFactory = API_FACTORIES[spec.api];
  if (!apiFactory) {
    diagnostics.push(
      `models.json provider "${spec.id}" has unknown api "${spec.api}"; supported: ${Object.keys(API_FACTORIES).join(", ")}.`,
    );
    return undefined;
  }
  if (spec.models.length === 0) {
    diagnostics.push(`models.json provider "${spec.id}" has no models; skipped.`);
    return undefined;
  }

  const apiLiteral = spec.api as Api;
  const models: Model<Api>[] = spec.models.map((m) => ({
    id: m.id,
    name: m.name ?? m.id,
    api: apiLiteral,
    provider: spec.id,
    baseUrl: spec.baseUrl ?? "",
    reasoning: m.reasoning ?? false,
    input: m.input ?? ["text"],
    cost: m.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: m.contextWindow ?? 0,
    maxTokens: m.maxTokens ?? 0,
  }));

  const auth = resolveAuth(spec);

  try {
    return createProvider({
      id: spec.id,
      name: spec.name ?? spec.id,
      baseUrl: spec.baseUrl,
      headers: spec.headers,
      auth,
      models,
      api: apiFactory(),
    });
  } catch (e) {
    diagnostics.push(
      `models.json provider "${spec.id}" failed to construct: ${e instanceof Error ? e.message : String(e)}`,
    );
    return undefined;
  }
}

/** Build the `ProviderAuth` for a spec from its `apiKey` field. */
function resolveAuth(spec: ParsedProviderSpec): Provider["auth"] {
  const apiKey = spec.apiKey;
  if (!apiKey) {
    // No apiKey: always unconfigured (so /model hides it). Use envApiKeyAuth
    // with no env vars — resolve() returns undefined.
    return { apiKey: envApiKeyAuth(`${spec.name ?? spec.id} API key`, []) };
  }
  const envMatch = /^\$([A-Z_][A-Z0-9_]*)$/.exec(apiKey);
  if (envMatch) {
    return {
      apiKey: envApiKeyAuth(`${spec.name ?? spec.id} API key`, [envMatch[1]!]),
    };
  }
  // Literal key: provider is always considered configured.
  return { apiKey: literalApiKeyAuth(spec.name ?? spec.id, apiKey) };
}

/** An `ApiKeyAuth` whose `resolve()` always returns the literal key. */
function literalApiKeyAuth(name: string, key: string): ReturnType<typeof envApiKeyAuth> {
  return {
    name,
    resolve: async () => ({ auth: { apiKey: key }, source: "models.json" }),
  };
}
