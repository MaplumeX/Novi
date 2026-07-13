import path from "node:path";
import {
  NodeExecutionEnv,
  AgentHarness,
  JsonlSessionRepo,
  uuidv7,
} from "@earendil-works/pi-agent-core/node";
import type {
  JsonlSessionMetadata,
  Session,
  ExecutionEnv,
  ThinkingLevel,
  AgentHarnessStreamOptions,
  QueueMode,
  AgentHarnessResources,
} from "@earendil-works/pi-agent-core/node";
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { formatSkillsForSystemPrompt } from "@earendil-works/pi-agent-core/node";
import type { LoadedResources } from "./resources.js";
import type { HookConfig } from "./hooks/index.js";
import { getNoviDir, getSessionsDir } from "./config.js";
import { DEFAULT_SYSTEM_PROMPT } from "./default-system-prompt.js";
import { createBuiltinToolAssembly } from "./tools/index.js";
import { getBuiltinToolDescriptor } from "./tools/index.js";
import {
  snapshotToolAssembly,
  type ToolCatalogSnapshot,
  type ToolRuntimeMode,
} from "./tools/contracts.js";
import type { WorkspaceScopeGuard } from "./permissions/scope.js";
import { loadResources } from "./resources.js";
import { loadCustomModels } from "./models-loader.js";
import { loadHooks, registerHooks } from "./hooks/index.js";
import { loadCredentials, injectCredentialsIntoEnv } from "./credentials.js";
import {
  loadSettings,
  resolveSettings,
  getAgentsMdCandidates,
  type ResolvedSettings,
  type SettingsLayers,
} from "./settings.js";
import {
  SessionPermissionStore,
  createNonInteractivePermissionGate,
  createPermissionGate,
  resolvePermissionsFromSettings,
  type Approver,
  type PermissionGate,
  type ResolvedPermissions,
} from "./permissions/index.js";

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
  /**
   * Auto-approve tools that would ask (`ask→allow`). CLI `--yes`.
   * Independent of project trust (`--approve`). Defaults to `false`.
   */
  yes?: boolean;
  /**
   * Interactive Approver for TUI. When omitted, a non-interactive
   * (fail-closed) gate is used — headless/gateway path.
   */
  approver?: Approver;
  /**
   * Optional shared session permission store (survives harness rebuilds).
   * When omitted, a fresh store is created.
   */
  permissionStore?: SessionPermissionStore;
  /** Internal caller mode used by descriptor availability resolution. */
  toolMode?: ToolRuntimeMode;
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
  systemPrompt: (ctx: { env: ExecutionEnv; resources: AgentHarnessResources }) => Promise<string>;
  /** Raw CLI overrides (provider/model/thinking) for /settings re-resolution. */
  cliOverrides: { provider?: string; model?: string; thinkingLevel?: ThinkingLevel };
  /** Whether project-level resources were loaded (trust gate result). */
  trusted: boolean;
  /** Scoped-model patterns from settings (for Ctrl+P cycling). */
  scopedModels: string[];
  /** CLI `--yes`: ask→allow for this run. */
  yes: boolean;
  /** Runtime permission gate (bound to the current harness). */
  permissionGate: PermissionGate;
  /** Process-lifetime session grants (shared across harness rebuilds). */
  permissionStore: SessionPermissionStore;
  /** Settings layers used for tighten-only permission re-resolve on reload. */
  settingsLayers: SettingsLayers;
  /** Validated tool descriptors, availability, and active-set diagnostics. */
  toolCatalog: ToolCatalogSnapshot;
  toolMode: ToolRuntimeMode;
}

/**
 * One-time preparation result shared across all gateway sessions.
 *
 * Contains the env, credentials, settings, models, system-prompt provider,
 * resources, hooks config, and derived harness options — everything that can
 * be reused without re-reading from disk. Per-session harness creation
 * ({@link createHarnessForSession}) consumes this.
 */
export interface GatewayEnv {
  env: ExecutionEnv;
  cwd: string;
  models: Models;
  model: Model<Api>;
  resolvedSettings: ResolvedSettings;
  systemPrompt: (ctx: { env: ExecutionEnv; resources: AgentHarnessResources }) => Promise<string>;
  trusted: boolean;
  /** Loaded skills + prompt templates (user + trusted project). */
  resources: LoadedResources;
  /** Parsed hook config ready for `registerHooks`. */
  hookConfig: HookConfig;
  /** Derived stream options (may be `{}` when no retry/transport configured). */
  streamOptions: AgentHarnessStreamOptions;
  /** Steering queue mode (or `undefined` to use harness default). */
  steeringMode: QueueMode | undefined;
  /** Follow-up queue mode (or `undefined` to use harness default). */
  followUpMode: QueueMode | undefined;
  /** Thinking level from settings/CLI. */
  thinkingLevel: ThinkingLevel;
  /** CLI `--yes`: ask→allow. */
  yes: boolean;
  /** Resolved tool permissions (after defaults/global/project/yes). */
  permissions: ResolvedPermissions;
  /** Split settings layers (for permission re-resolve on /reload). */
  settingsLayers: SettingsLayers;
  /** Process-lifetime session grants. */
  permissionStore: SessionPermissionStore;
  /**
   * Interactive Approver when TUI; undefined → non-interactive gate.
   * Stored so createHarnessForSession / resume can build the gate.
   */
  approver: Approver | undefined;
  /** Preflight catalog used for diagnostics before any Gateway session exists. */
  toolCatalog: ToolCatalogSnapshot;
  toolMode: ToolRuntimeMode;
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
    : ((provider === DEFAULT_PROVIDER
        ? (models.getModel(provider, DEFAULT_MODEL_ID) ?? undefined)
        : undefined) ?? candidates[0]);
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
    throw new Error(`provider "${provider}" is not configured (no API key found).${envHint}`);
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
function makeSystemPromptProvider(
  cwd: string,
): (ctx: { env: ExecutionEnv; resources: AgentHarnessResources }) => Promise<string> {
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

  return async ({
    env,
    resources,
  }: {
    env: ExecutionEnv;
    resources: AgentHarnessResources;
  }): Promise<string> => {
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
 * One-time environment preparation: env / credentials / settings / models /
 * system-prompt provider / resources / hooks config / derived harness options.
 *
 * Does NOT create a session or harness — that is the job of
 * {@link createHarnessForSession}. The returned {@link GatewayEnv} is reused
 * across all gateway sessions.
 */
export async function prepareGatewayEnv(options: BootstrapOptions = {}): Promise<GatewayEnv> {
  const cwd = options.cwd ?? process.cwd();
  const trusted = options.trusted !== false;
  const toolMode = options.toolMode ?? "tui";

  const env = new NodeExecutionEnv({ cwd, shellEnv: process.env });

  const storedCreds = await loadCredentials(env);
  injectCredentialsIntoEnv(storedCreds, process.env);

  const sessionsDir = getSessionsDir();
  await ensureDir(env, getNoviDir());
  await ensureDir(env, sessionsDir);

  const loadResult = await loadSettings(env, cwd, { includeProject: trusted });
  for (const diagnostic of loadResult.diagnostics) {
    process.stderr.write(`warning: ${diagnostic}\n`);
  }
  const resolvedSettings = resolveSettings(loadResult.merged, loadResult.layers, {
    provider: options.provider,
    model: options.model,
    thinkingLevel: options.thinkingLevel,
  });

  const yes = options.yes === true;
  const permissions = resolvePermissionsFromSettings(resolvedSettings, {
    yes,
    layers: loadResult.layers,
    workspace: cwd,
  });
  for (const diagnostic of permissions.diagnostics) {
    process.stderr.write(`warning: ${diagnostic}\n`);
  }
  const permissionStore = options.permissionStore ?? new SessionPermissionStore();
  const approver = options.approver;

  const toolPreflight = createBuiltinToolAssembly(env, "preflight", {
    webSearch: resolvedSettings.webSearch,
    fetchContent: resolvedSettings.fetchContent,
    exposure: resolvedSettings.tools,
    permissions,
    mode: toolMode,
  });
  for (const diagnostic of toolPreflight.diagnostics) {
    process.stderr.write(`warning: ${diagnostic}\n`);
  }

  const models = builtinModels();
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

  const resources = await loadResources(env, cwd, { includeProject: trusted });
  for (const diagnostic of resources.diagnostics) {
    process.stderr.write(`warning: ${diagnostic}\n`);
  }

  const hookConfig = await loadHooks(env, cwd, { includeProject: trusted });
  for (const diagnostic of hookConfig.diagnostics) {
    process.stderr.write(`warning: ${diagnostic}\n`);
  }

  // Derive stream options from settings (retry + transport).
  const retry = resolvedSettings.retry?.provider;
  const transport = resolvedSettings.transport;
  const streamOptions: AgentHarnessStreamOptions = {
    ...(transport !== undefined ? { transport } : {}),
    ...(retry?.timeoutMs !== undefined ? { timeoutMs: retry.timeoutMs } : {}),
    ...(retry?.maxRetries !== undefined ? { maxRetries: retry.maxRetries } : {}),
    ...(retry?.maxRetryDelayMs !== undefined ? { maxRetryDelayMs: retry.maxRetryDelayMs } : {}),
  };

  return {
    env,
    cwd,
    models,
    model,
    resolvedSettings,
    systemPrompt,
    trusted,
    resources,
    hookConfig,
    streamOptions,
    steeringMode: resolvedSettings.steeringMode,
    followUpMode: resolvedSettings.followUpMode,
    thinkingLevel: resolvedSettings.defaultThinkingLevel ?? DEFAULT_THINKING_LEVEL,
    yes,
    permissions,
    settingsLayers: loadResult.layers,
    permissionStore,
    approver,
    toolCatalog: snapshotToolAssembly(toolPreflight),
    toolMode,
  };
}

/** Result of {@link createHarnessForSession}. */
export interface CreatedSession {
  harness: AgentHarness;
  session: Session<JsonlSessionMetadata>;
  sessionPath: string;
  permissionGate: PermissionGate;
  toolCatalog: ToolCatalogSnapshot;
  permissionStore: SessionPermissionStore;
}

/**
 * Create a fresh `AgentHarness` + session for one gateway session key.
 *
 * Reuses the one-time {@link GatewayEnv} preparation. Each call creates a new
 * JSONL session and wires tools/resources/hooks/stream options/queue modes onto
 * a new harness instance.
 */
export async function createHarnessForSession(
  gatewayEnv: GatewayEnv,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- sessionKey will be used by gateway session-lane (Phase 4) for session routing/logging
  _sessionKey: string,
): Promise<CreatedSession> {
  const { env, cwd, models, model, systemPrompt, thinkingLevel, resources, hookConfig } =
    gatewayEnv;

  const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: getSessionsDir() });
  const session = await repo.create({ cwd, id: uuidv7() });
  const metadata = await session.getMetadata();
  const sessionPath = metadata.path;

  const harness = new AgentHarness({
    env,
    session,
    models,
    model,
    systemPrompt,
    thinkingLevel,
  });

  const toolAssembly = createBuiltinToolAssembly(env, metadata.id, {
    webSearch: gatewayEnv.resolvedSettings.webSearch,
    fetchContent: gatewayEnv.resolvedSettings.fetchContent,
    exposure: gatewayEnv.resolvedSettings.tools,
    permissions: gatewayEnv.permissions,
    mode: gatewayEnv.toolMode,
    workspace: cwd,
  });
  await harness.setTools(toolAssembly.tools, toolAssembly.activeToolNames);

  await harness.setResources({
    skills: resources.skills,
    promptTemplates: resources.promptTemplates,
  });

  const permissionStore = permissionStoreForHarness(
    gatewayEnv.toolMode,
    gatewayEnv.permissionStore,
  );
  const permissionGate = buildPermissionGate(
    { ...gatewayEnv, permissionStore },
    toolAssembly.scopeGuard,
  );
  registerHooks(harness, hookConfig, { env, cwd, sessionId: metadata.id }, { permissionGate });

  // Apply stream options when any are set (avoids a no-op setStreamOptions).
  const so = gatewayEnv.streamOptions;
  if (Object.keys(so).length > 0) {
    await harness.setStreamOptions(so);
  }

  if (gatewayEnv.steeringMode) {
    await harness.setSteeringMode(gatewayEnv.steeringMode);
  }
  if (gatewayEnv.followUpMode) {
    await harness.setFollowUpMode(gatewayEnv.followUpMode);
  }

  return {
    harness,
    session,
    sessionPath,
    permissionGate,
    toolCatalog: snapshotToolAssembly(toolAssembly),
    permissionStore,
  };
}

/** Gateway chats never share grants; interactive rebuilds retain one store. */
export function permissionStoreForHarness(
  mode: ToolRuntimeMode,
  shared: SessionPermissionStore,
): SessionPermissionStore {
  return mode === "gateway" ? new SessionPermissionStore() : shared;
}

/** Build a PermissionGate from GatewayEnv (interactive or fail-closed). */
export function buildPermissionGate(
  gatewayEnv: {
    permissions: ResolvedPermissions;
    permissionStore: SessionPermissionStore;
    approver: Approver | undefined;
  },
  scopeGuard: WorkspaceScopeGuard,
): PermissionGate {
  const common = {
    permissions: gatewayEnv.permissions,
    store: gatewayEnv.permissionStore,
    scopeGuard,
    resolveDescriptor: getBuiltinToolDescriptor,
  };
  if (gatewayEnv.approver) {
    return createPermissionGate({
      ...common,
      approver: gatewayEnv.approver,
    });
  }
  return createNonInteractivePermissionGate(common);
}

/**
 * Assemble env / session / models / harness.
 *
 * Uses the public `JsonlSessionRepo` API (see research/api-deviations.md for why
 * `JsonlSessionStorage` is not used) and `builtinModels()` so provider API keys
 * are auto-read from the environment by pi-ai.
 */
export async function bootstrap(options: BootstrapOptions = {}): Promise<BootstrapResult> {
  const gatewayEnv = await prepareGatewayEnv(options);

  // Resume an existing session when requested; otherwise the gateway helper
  // creates a fresh one (shared with the gateway path).
  let session: Session<JsonlSessionMetadata>;
  let sessionPath: string;
  let harness: AgentHarness;
  let permissionGate: PermissionGate;
  let permissionStore = gatewayEnv.permissionStore;
  let toolCatalog: ToolCatalogSnapshot;

  if (options.resumePath) {
    const { env } = gatewayEnv;
    const absResult = await env.absolutePath(options.resumePath);
    if (!absResult.ok) {
      throw new Error(`invalid resume path ${options.resumePath}: ${absResult.error.message}`);
    }
    const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: getSessionsDir() });
    session = await repo.open({ path: absResult.value } as JsonlSessionMetadata);
    const metadata = await session.getMetadata();
    sessionPath = metadata.path;

    harness = new AgentHarness({
      env: gatewayEnv.env,
      session,
      models: gatewayEnv.models,
      model: gatewayEnv.model,
      systemPrompt: gatewayEnv.systemPrompt,
      thinkingLevel: gatewayEnv.thinkingLevel,
    });

    const toolAssembly = createBuiltinToolAssembly(env, metadata.id, {
      webSearch: gatewayEnv.resolvedSettings.webSearch,
      fetchContent: gatewayEnv.resolvedSettings.fetchContent,
      exposure: gatewayEnv.resolvedSettings.tools,
      permissions: gatewayEnv.permissions,
      mode: gatewayEnv.toolMode,
      workspace: gatewayEnv.cwd,
    });
    await harness.setTools(toolAssembly.tools, toolAssembly.activeToolNames);
    toolCatalog = snapshotToolAssembly(toolAssembly);
    await harness.setResources({
      skills: gatewayEnv.resources.skills,
      promptTemplates: gatewayEnv.resources.promptTemplates,
    });
    permissionGate = buildPermissionGate(gatewayEnv, toolAssembly.scopeGuard);
    registerHooks(
      harness,
      gatewayEnv.hookConfig,
      { env, cwd: gatewayEnv.cwd, sessionId: metadata.id },
      { permissionGate },
    );
    const so = gatewayEnv.streamOptions;
    if (Object.keys(so).length > 0) {
      await harness.setStreamOptions(so);
    }
    if (gatewayEnv.steeringMode) {
      await harness.setSteeringMode(gatewayEnv.steeringMode);
    }
    if (gatewayEnv.followUpMode) {
      await harness.setFollowUpMode(gatewayEnv.followUpMode);
    }
  } else {
    const created = await createHarnessForSession(gatewayEnv, "tui");
    harness = created.harness;
    session = created.session;
    sessionPath = created.sessionPath;
    permissionGate = created.permissionGate;
    permissionStore = created.permissionStore;
    toolCatalog = created.toolCatalog;
  }

  return {
    harness,
    env: gatewayEnv.env,
    models: gatewayEnv.models,
    model: gatewayEnv.model,
    session,
    sessionPath,
    cwd: gatewayEnv.cwd,
    resolvedSettings: gatewayEnv.resolvedSettings,
    systemPrompt: gatewayEnv.systemPrompt,
    cliOverrides: {
      provider: options.provider,
      model: options.model,
      thinkingLevel: options.thinkingLevel,
    },
    trusted: gatewayEnv.trusted,
    scopedModels: gatewayEnv.resolvedSettings.scopedModels ?? [],
    yes: gatewayEnv.yes,
    permissionGate,
    permissionStore,
    settingsLayers: gatewayEnv.settingsLayers,
    toolCatalog,
    toolMode: gatewayEnv.toolMode,
  };
}
