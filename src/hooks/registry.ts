import { AgentHarness } from "@earendil-works/pi-agent-core/node";
import { runHookScript } from "./runner.js";
import type { HookConfig, HookMatcherGroup, RegisterHooksDeps } from "./types.js";

/**
 * Register all hook dispatchers from `config` onto `harness`.
 *
 * For each supported event in `config.events`, a single dispatcher closure is
 * registered via `harness.on(type, dispatcher)`. The dispatcher filters matcher
 * groups, runs matching scripts in manifest order, and returns the last non-
 * undefined result — matching core's `emitHook` "last non-undefined wins"
 * semantics.
 *
 * The core `AgentHarness.on()` is a fully-typed public method; no type
 * assertion is needed. Each dispatcher is an async function that returns the
 * core result object (camelCase) or `undefined` for a no-op.
 */
export function registerHooks(
  harness: AgentHarness,
  config: HookConfig,
  deps: RegisterHooksDeps,
): void {
  for (const [eventType, groups] of config.events) {
    if (groups.length === 0) continue;
    const dispatcher = makeDispatcher(eventType, groups, deps);
    harness.on(eventType as never, dispatcher as never);
  }
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