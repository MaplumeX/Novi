import { AgentHarness } from "@earendil-works/pi-agent-core/node";
import { runHookScript } from "./runner.js";
import type { HookConfig, HookMatcherGroup, RegisterHooksDeps } from "./types.js";
import type { PermissionGate } from "../permissions/gate.js";

/** Optional extras for `registerHooks` (permission gate compose, etc.). */
export interface RegisterHooksOptions {
  /**
   * Built-in permission gate. When present, `tool_call` is composed as:
   * 1. gate evaluates (may ask user / auto-deny)
   * 2. if gate denies → return block (user hooks skipped — MVP)
   * 3. else run user tool_call hooks; user block sticks
   *
   * Deny is sticky: user hooks cannot override a permission deny.
   */
  permissionGate?: PermissionGate;
}

/**
 * Register all hook dispatchers from `config` onto `harness`.
 *
 * For each supported event in `config.events`, a single dispatcher closure is
 * registered via `harness.on(type, dispatcher)`. The dispatcher filters matcher
 * groups, runs matching scripts in manifest order, and returns the last non-
 * undefined result — matching core's `emitHook` "last non-undefined wins"
 * semantics.
 *
 * When `options.permissionGate` is set, a `tool_call` dispatcher is always
 * registered (even if there are no user tool_call hooks) so the gate runs.
 * Gate + user hooks are **explicitly composed** (deny-sticky); we do not rely
 * on `emitHook` last-wins registration order.
 *
 * The core `AgentHarness.on()` is a fully-typed public method; no type
 * assertion is needed. Each dispatcher is an async function that returns the
 * core result object (camelCase) or `undefined` for a no-op.
 */
export function registerHooks(
  harness: AgentHarness,
  config: HookConfig,
  deps: RegisterHooksDeps,
  options: RegisterHooksOptions = {},
): void {
  const { permissionGate } = options;
  const registered = new Set<string>();

  for (const [eventType, groups] of config.events) {
    if (groups.length === 0) continue;

    if (eventType === "tool_call" && permissionGate) {
      // Composed dispatcher: gate first, then user hooks.
      const userDispatcher = makeDispatcher(eventType, groups, deps);
      harness.on(
        eventType as never,
        makeComposedToolCallDispatcher(permissionGate, userDispatcher) as never,
      );
      registered.add("tool_call");
      continue;
    }

    const dispatcher = makeDispatcher(eventType, groups, deps);
    harness.on(eventType as never, dispatcher as never);
    registered.add(eventType);
  }

  // Ensure gate still runs when there are no user tool_call hooks.
  if (permissionGate && !registered.has("tool_call")) {
    harness.on(
      "tool_call" as never,
      makeComposedToolCallDispatcher(permissionGate, undefined) as never,
    );
  }
}

/**
 * Compose permission gate + optional user tool_call dispatcher.
 *
 * Order (D5 deny-sticky):
 * 1. await gate.onToolCall
 * 2. if gate.block → return immediately (skip user hooks)
 * 3. else run user dispatcher; user block wins if present
 */
export function makeComposedToolCallDispatcher(
  gate: PermissionGate,
  userDispatcher:
    | ((event: Record<string, unknown>) => Promise<Record<string, unknown> | undefined>)
    | undefined,
): (event: Record<string, unknown>) => Promise<Record<string, unknown> | undefined> {
  return async (event: Record<string, unknown>) => {
    const perm = await gate.onToolCall(event);
    if (perm?.block) {
      return perm as Record<string, unknown>;
    }
    if (!userDispatcher) {
      return undefined;
    }
    const user = await userDispatcher(event);
    if (user && (user as { block?: boolean }).block) {
      return user;
    }
    // Both allow → undefined (or pass through non-block user result if any)
    return user ?? undefined;
  };
}

/** Build the dispatcher closure for one event type. */
function makeDispatcher(
  eventType: string,
  groups: HookMatcherGroup[],
  deps: RegisterHooksDeps,
): (event: Record<string, unknown>) => Promise<Record<string, unknown> | undefined> {
  return async (event: Record<string, unknown>) => {
    let lastResult: Record<string, unknown> | undefined;
    for (const group of groups) {
      if (!matcherMatches(group.matcher, eventType, event)) continue;
      for (const handler of group.hooks) {
        const result = await runHookScript(handler, event, eventType, deps);
        if (result !== undefined) lastResult = result;
      }
    }
    return lastResult;
  };
}

/**
 * Decide whether a matcher group applies to `event`.
 *
 * - For `tool_call`/`tool_result`: compare `matcher` against `event.toolName`.
 *   `undefined`/`"*"`/`""` → matches all; `"A|B"` → exact match of `A` or `B`;
 *   otherwise an exact match against the literal string.
 * - For other events: the matcher is ignored (always matches).
 */
export function matcherMatches(
  matcher: string | undefined,
  eventType: string,
  event: Record<string, unknown>,
): boolean {
  if (eventType !== "tool_call" && eventType !== "tool_result") return true;
  if (matcher === undefined || matcher === "" || matcher === "*") return true;
  const toolName = event.toolName;
  if (typeof toolName !== "string") return false;
  const alternatives = matcher.split("|").map((s) => s.trim());
  return alternatives.includes(toolName);
}
