import { AgentHarness } from "@earendil-works/pi-agent-core/node";
import type {
  ExecutionEnv,
  JsonlSessionMetadata,
  Session,
} from "@earendil-works/pi-agent-core/node";
import type { Models } from "@earendil-works/pi-ai";
import { createBuiltinTools } from "../tools/index.js";
import { loadResources } from "../resources.js";

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
  /**
   * Rebuild the harness and update the holder state.
   *
   * - `session`/`sessionPath` omitted → reuse current session (`/reload`).
   * - `session`/`sessionPath` provided → switch to a new session (`/new`/
   *   `/resume`, child 4).
   * - `reloadResources=true` → re-scan skills/prompt-templates from disk.
   * - `model`/`thinkingLevel` optional overrides for the new harness
   *   (otherwise replayed from the old harness).
   */
  replace: (next: ReplaceOptions) => Promise<void>;
}

export interface ReplaceOptions {
  session?: Session<JsonlSessionMetadata>;
  sessionPath?: string;
  reloadResources?: boolean;
}

export interface CreateHarnessHandleDeps {
  env: ExecutionEnv;
  models: Models;
  cwd: string;
  /** System-prompt provider reused across rebuilds. */
  systemPrompt: ConstructorParameters<typeof AgentHarness>[0]["systemPrompt"];
  /** Called with the new handle after a rebuild (React setState). */
  setHandle: (handle: HarnessHandle) => void;
}

/**
 * Replay runtime state from an old harness onto a freshly-constructed one,
 * using only public getters (no private-field access).
 *
 * Replays: tools (+ active names), model, thinking level, stream options, and
 * resources (optionally reloaded from disk).
 */
export async function replayHarnessState(
  newHarness: AgentHarness,
  oldHarness: AgentHarness,
  env: ExecutionEnv,
  cwd: string,
  opts: { reloadResources?: boolean; trusted?: boolean } = {},
): Promise<void> {
  // Tools: re-create the built-in set and restore the active-tool selection.
  const tools = createBuiltinTools(env);
  const activeToolNames = oldHarness.getActiveTools().map((t) => t.name);
  await newHarness.setTools(tools, activeToolNames);

  // Model + thinking level.
  await newHarness.setModel(oldHarness.getModel());
  await newHarness.setThinkingLevel(oldHarness.getThinkingLevel());

  // Stream options (timeout/retry/etc).
  await newHarness.setStreamOptions(oldHarness.getStreamOptions());

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
  } else {
    await newHarness.setResources(oldHarness.getResources());
  }
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
  },
  deps: CreateHarnessHandleDeps,
): HarnessHandle {
  const { env, models, cwd, systemPrompt, setHandle } = deps;

  // `makeReplace` returns a `replace` closure bound to a specific (old) handle.
  function makeReplace(old: HarnessHandle): HarnessHandle["replace"] {
    return async (next: ReplaceOptions): Promise<void> => {
      // 1. Ensure we're not mid-turn before tearing down.
      await old.harness.waitForIdle();
      // 2. unsubscribe() is handled by useHarnessState's effect cleanup when
      //    the harness identity changes (setState below triggers it).
      // 3. Determine session.
      const session = next.session ?? old.session;
      const sessionPath = next.sessionPath ?? old.sessionPath;
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
      await replayHarnessState(newHarness, old.harness, env, cwd, {
        reloadResources: next.reloadResources,
        trusted: old.trusted,
      });
      // 6. Build the new handle with its own replace closure, then publish.
      const newHandle: HarnessHandle = {
        harness: newHarness,
        session,
        sessionPath,
        trusted: old.trusted,
        replace: async () => {
          // Placeholder overwritten immediately below (TDZ-safe fixup).
        },
      };
      newHandle.replace = makeReplace(newHandle);
      setHandle(newHandle);
    };
  }

  const handle: HarnessHandle = {
    harness: initial.harness,
    session: initial.session,
    sessionPath: initial.sessionPath,
    trusted: initial.trusted,
    replace: async () => {
      // Placeholder overwritten immediately below.
    },
  };
  handle.replace = makeReplace(handle);
  return handle;
}
