import { AgentHarness } from "@earendil-works/pi-agent-core/node";
import type {
  ExecutionEnv,
  JsonlSessionMetadata,
  Session,
} from "@earendil-works/pi-agent-core/node";
import type { Models } from "@earendil-works/pi-ai";
import { createBuiltinTools } from "../tools/index.js";
import { loadResources } from "../resources.js";
import { loadHooks, registerHooks } from "../hooks/index.js";
import type { ResolvedSettings, SettingsLayers } from "../settings.js";
import {
  DEFAULT_PROVIDER,
  DEFAULT_MODEL_ID,
  DEFAULT_THINKING_LEVEL,
  buildPermissionGate,
} from "../bootstrap.js";
import {
  resolvePermissionsFromSettings,
  type Approver,
  type PermissionGate,
  type SessionPermissionStore,
} from "../permissions/index.js";

/**
 * A replaceable harness holder. `<App>` holds one of these as React state;
 * `useHarnessState` re-subscribes whenever `harness`/`session` change.
 *
 * `replace` rebuilds the underlying `AgentHarness` (AgentHarness has no
 * session hot-swap API — see research/harness-session-swap.md) and is the
 * shared primitive for `/reload` (this child) and `/new`/`/resume` (child 4).
 */
export interface HarnessHandle {
  harness: AgentHarness;
  session: Session<JsonlSessionMetadata>;
  sessionPath: string;
  /** Whether project-level resources were loaded at bootstrap (trust gate). */
  trusted: boolean;
  /** Runtime permission gate bound to the current harness. */
  permissionGate: PermissionGate;
  /** Process-lifetime session grants (survives replace). */
  permissionStore: SessionPermissionStore;
  /**
   * Rebuild the harness and update the holder state.
   *
   * - `session`/`sessionPath` omitted → reuse current session (`/reload`).
   * - `session`/`sessionPath` provided → switch to a new session (`/new`/
   *   `/resume`, child 4).
   * - `reloadResources=true` → re-scan skills/prompt-templates from disk.
   * - `resolvedSettings` provided → re-resolve model/thinking/stream/queue
   *   modes from disk settings (`/reload`); otherwise replay from old harness
   *   (`/new`/`/resume`).
   * Returns resource-load diagnostics (warnings from skill/template files).
   */
  replace: (next: ReplaceOptions) => Promise<{ diagnostics: string[] }>;
}

export interface ReplaceOptions {
  session?: Session<JsonlSessionMetadata>;
  sessionPath?: string;
  reloadResources?: boolean;
  /**
   * When provided, model/thinking/streamOptions/steeringMode/followUpMode are
   * re-resolved from these settings instead of replayed from the old harness.
   * Used by `/reload`; omitted by `/new`/`/resume`.
   */
  resolvedSettings?: ResolvedSettings;
  /**
   * Split settings layers for tighten-only permission re-resolve on `/reload`.
   * When omitted, permissions are left as currently resolved on the gate.
   */
  settingsLayers?: SettingsLayers;
}

export interface CreateHarnessHandleDeps {
  env: ExecutionEnv;
  models: Models;
  cwd: string;
  /** System-prompt provider reused across rebuilds. */
  systemPrompt: ConstructorParameters<typeof AgentHarness>[0]["systemPrompt"];
  /** Called with the new handle after a rebuild (React setState). */
  setHandle: (handle: HarnessHandle) => void;
  /** CLI `--yes` for this process. */
  yes: boolean;
  /** Interactive Approver (TUI) or undefined (should not happen in TUI path). */
  approver: Approver | undefined;
  /** Process-lifetime session grants. */
  permissionStore: SessionPermissionStore;
  /** Initial permission gate (from bootstrap). */
  permissionGate: PermissionGate;
  /** Initial settings layers for permission re-resolve. */
  settingsLayers: SettingsLayers;
  /** Initial resolved settings retained across /new and /resume rebuilds. */
  resolvedSettings?: ResolvedSettings;
}

/**
 * Replay runtime state from an old harness onto a freshly-constructed one,
 * using only public getters (no private-field access).
 *
 * Replays: tools (+ active names), model, thinking level, stream options,
 * queue delivery modes, and resources (optionally reloaded from disk).
 *
 * When `opts.resolvedSettings` is provided (the `/reload` path), model,
 * thinking level, stream options, and queue modes are re-resolved from disk
 * settings instead of replayed from the old harness. When not provided (the
 * `/new`/`/resume` path), they are replayed from the old harness so a session
 * switch preserves the current runtime configuration.
 *
 * Permissions: on `/reload` with `resolvedSettings` + `settingsLayers`,
 * re-resolve permissions and update the shared gate via `setPermissions`.
 * The {@link SessionPermissionStore} is **never** cleared.
 *
 * Returns `{ diagnostics, permissionGate }` — warnings from resource loading
 * plus the gate bound for this rebuild (same instance when store reused).
 */
export async function replayHarnessState(
  newHarness: AgentHarness,
  oldHarness: AgentHarness,
  env: ExecutionEnv,
  cwd: string,
  sessionId: string,
  models: Models,
  opts: {
    reloadResources?: boolean;
    trusted?: boolean;
    resolvedSettings?: ResolvedSettings;
    toolSettings?: ResolvedSettings;
    settingsLayers?: SettingsLayers;
    yes?: boolean;
    permissionGate?: PermissionGate;
    permissionStore?: SessionPermissionStore;
    approver?: Approver;
  } = {},
): Promise<{ diagnostics: string[]; permissionGate: PermissionGate | undefined }> {
  const diagnostics: string[] = [];

  // Tools: re-create the built-in set and restore the active-tool selection.
  const tools = createBuiltinTools(env, sessionId, {
    webSearch: (opts.toolSettings ?? opts.resolvedSettings)?.webSearch,
    fetchContent: (opts.toolSettings ?? opts.resolvedSettings)?.fetchContent,
  });
  const activeToolNames = oldHarness.getActiveTools().map((t) => t.name);
  await newHarness.setTools(tools, activeToolNames);

  if (opts.resolvedSettings) {
    // /reload path: re-resolve model/thinking/stream/queue from disk settings.
    const rs = opts.resolvedSettings;
    const provider = rs.defaultProvider ?? DEFAULT_PROVIDER;
    const modelId = rs.defaultModel ?? (provider === DEFAULT_PROVIDER ? DEFAULT_MODEL_ID : undefined);
    const model = modelId ? models.getModel(provider, modelId) : undefined;
    if (model) {
      await newHarness.setModel(model);
    } else {
      // Degrade: keep the old harness model and warn.
      await newHarness.setModel(oldHarness.getModel());
      diagnostics.push(
        `model "${modelId ?? ""}" not found for provider "${provider}"; keeping current model`,
      );
    }
    await newHarness.setThinkingLevel(
      rs.defaultThinkingLevel ?? DEFAULT_THINKING_LEVEL,
    );

    // Stream options: rebuild from settings retry/transport (only set fields).
    const retry = rs.retry?.provider;
    const transport = rs.transport;
    const streamOpts: Record<string, unknown> = {};
    if (transport !== undefined) streamOpts.transport = transport;
    if (retry?.timeoutMs !== undefined) streamOpts.timeoutMs = retry.timeoutMs;
    if (retry?.maxRetries !== undefined) streamOpts.maxRetries = retry.maxRetries;
    if (retry?.maxRetryDelayMs !== undefined) streamOpts.maxRetryDelayMs = retry.maxRetryDelayMs;
    if (Object.keys(streamOpts).length > 0) {
      await newHarness.setStreamOptions(streamOpts);
    } else {
      await newHarness.setStreamOptions(oldHarness.getStreamOptions());
    }

    // Queue delivery modes from settings (fall back to old harness if unset).
    await newHarness.setSteeringMode(
      rs.steeringMode ?? oldHarness.getSteeringMode(),
    );
    await newHarness.setFollowUpMode(
      rs.followUpMode ?? oldHarness.getFollowUpMode(),
    );
  } else {
    // /new /resume path: replay from old harness (preserve runtime config).
    await newHarness.setModel(oldHarness.getModel());
    await newHarness.setThinkingLevel(oldHarness.getThinkingLevel());
    await newHarness.setStreamOptions(oldHarness.getStreamOptions());
    await newHarness.setSteeringMode(oldHarness.getSteeringMode());
    await newHarness.setFollowUpMode(oldHarness.getFollowUpMode());
  }

  // Resources: reload from disk or carry over the previous snapshot.
  // When reloading, honor the trust gate: untrusted → skip project layer.
  if (opts.reloadResources) {
    const loaded = await loadResources(env, cwd, {
      includeProject: opts.trusted !== false,
    });
    await newHarness.setResources({
      skills: loaded.skills,
      promptTemplates: loaded.promptTemplates,
    });
    diagnostics.push(...loaded.diagnostics);
  } else {
    await newHarness.setResources(oldHarness.getResources());
  }

  // Permissions: re-resolve on /reload; keep the same store (session grants).
  let permissionGate = opts.permissionGate;
  if (opts.resolvedSettings && opts.permissionStore) {
    const nextPerms = resolvePermissionsFromSettings(opts.resolvedSettings, {
      yes: opts.yes === true,
      layers: opts.settingsLayers,
    });
    if (permissionGate) {
      permissionGate.setPermissions(nextPerms);
    } else {
      permissionGate = buildPermissionGate({
        permissions: nextPerms,
        permissionStore: opts.permissionStore,
        approver: opts.approver,
      });
    }
  }

  // Hooks: re-load manifests and re-register dispatchers. Handler closures
  // bind to a specific harness instance, so they must be re-created on every
  // rebuild. Trust gate is reused from the old handle (cwd-scoped).
  try {
    const hookConfig = await loadHooks(env, cwd, {
      includeProject: opts.trusted !== false,
    });
    registerHooks(
      newHarness,
      hookConfig,
      { env, cwd, sessionId },
      { permissionGate },
    );
    diagnostics.push(...hookConfig.diagnostics);
  } catch (e) {
    // Hook registration must never block harness rebuild.
    diagnostics.push(
      `hooks: failed to reload: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  return { diagnostics, permissionGate };
}

/**
 * Build the initial `HarnessHandle` and wire `replace` to `setHandle`.
 *
 * Each `replace` call constructs a new `AgentHarness`, replays state from the
 * current (old) harness, then calls `deps.setHandle` with a new handle whose
 * own `replace` closes over the new harness. This recursive closure pattern
 * ensures a stale `replace` always reads the handle it belongs to.
 */
export function createHarnessHandle(
  initial: {
    harness: AgentHarness;
    session: Session<JsonlSessionMetadata>;
    sessionPath: string;
    trusted: boolean;
    permissionGate: PermissionGate;
    permissionStore: SessionPermissionStore;
  },
  deps: CreateHarnessHandleDeps,
): HarnessHandle {
  const { env, models, cwd, systemPrompt, setHandle, yes, approver } = deps;
  // settingsLayers can update on /reload via replace opts; keep latest in a ref-like box.
  let settingsLayers = deps.settingsLayers;
  let resolvedSettings = deps.resolvedSettings;

  // `makeReplace` returns a `replace` closure bound to a specific (old) handle.
  function makeReplace(old: HarnessHandle): HarnessHandle["replace"] {
    return async (next: ReplaceOptions): Promise<{ diagnostics: string[] }> => {
      // 1. Ensure we're not mid-turn before tearing down.
      await old.harness.waitForIdle();
      // 2. unsubscribe() is handled by useHarnessState's effect cleanup when
      //    the harness identity changes (setState below triggers it).
      // 3. Determine session.
      const session = next.session ?? old.session;
      const sessionPath = next.sessionPath ?? old.sessionPath;
      const sessionMeta = await session.getMetadata();
      if (next.settingsLayers) {
        settingsLayers = next.settingsLayers;
      }
      if (next.resolvedSettings) {
        resolvedSettings = next.resolvedSettings;
      }
      // 4. Build the new harness, reusing the old model.
      const newHarness = new AgentHarness({
        env,
        session,
        models,
        model: old.harness.getModel(),
        systemPrompt,
      });
      // 5. Replay state from old → new. Trust decision is reused from the old
      //    handle (trust is cwd-scoped, not session-scoped; re-resolving would
      //    require a fresh trust prompt mid-session, which we don't support).
      //    Session permission store is the same instance (AC13).
      const { diagnostics, permissionGate } = await replayHarnessState(
        newHarness, old.harness, env, cwd, sessionMeta.id, models,
        {
          reloadResources: next.reloadResources,
          trusted: old.trusted,
          resolvedSettings: next.resolvedSettings,
          toolSettings: resolvedSettings,
          settingsLayers,
          yes,
          permissionGate: old.permissionGate,
          permissionStore: old.permissionStore,
          approver,
        },
      );
      // 6. Build the new handle with its own replace closure, then publish.
      const newHandle: HarnessHandle = {
        harness: newHarness,
        session,
        sessionPath,
        trusted: old.trusted,
        permissionGate: permissionGate ?? old.permissionGate,
        permissionStore: old.permissionStore,
        replace: async () => {
          // Placeholder overwritten immediately below (TDZ-safe fixup).
          return { diagnostics: [] };
        },
      };
      newHandle.replace = makeReplace(newHandle);
      setHandle(newHandle);
      return { diagnostics };
    };
  }

  const handle: HarnessHandle = {
    harness: initial.harness,
    session: initial.session,
    sessionPath: initial.sessionPath,
    trusted: initial.trusted,
    permissionGate: initial.permissionGate,
    permissionStore: initial.permissionStore,
    replace: async () => {
      // Placeholder overwritten immediately below.
      return { diagnostics: [] };
    },
  };
  handle.replace = makeReplace(handle);
  return handle;
}
