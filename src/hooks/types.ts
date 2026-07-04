/**
 * Shared types for the Novi agent hook mechanism.
 *
 * Hooks are user/project-configurable scripts spawned as child processes at
 * agent lifecycle points (turn start, tool call/result, compaction). See
 * `loader.ts` for manifest loading and `registry.ts` for registration.
 */

/**
 * Events whose results Novi can forward back to the harness core.
 *
 * The manifest loader accepts only these event names; unknown names produce a
 * diagnostic and are skipped. Second-tier events
 * (`before_provider_request`/`before_provider_payload`/`after_provider_response`/
 * `session_before_tree`/`context`) can be enabled by adding them here — the
 * loader and registry need no other changes.
 */
export const SUPPORTED_EVENTS = new Set<string>([
  "before_agent_start",
  "tool_call",
  "tool_result",
  "session_before_compact",
]);

/** A single script handler entry inside a matcher group. */
export interface HookHandlerConfig {
  /** Executable command (resolved via the shell/PATH at spawn time). */
  command: string;
  /** Extra arguments appended after `command`. */
  args?: string[];
  /** Per-handler timeout in milliseconds. Defaults to 10000 (10s). */
  timeoutMs?: number;
}

/** A matcher group: scripts that share a `matcher` filter for one event. */
export interface HookMatcherGroup {
  /**
   * For `tool_call`/`tool_result`: a tool-name filter. `undefined`/`"*"`/`""`
   * matches all tools; `"A|B"` matches tool `A` or `B` exactly; otherwise an
   * exact tool-name match. Ignored for other events.
   */
  matcher?: string;
  hooks: HookHandlerConfig[];
}

/** Parsed hook configuration ready for registration. */
export interface HookConfig {
  /** Supported event name → matcher groups (user layer first, project appended). */
  events: Map<string, HookMatcherGroup[]>;
  /** Non-fatal warnings (invalid JSON, unknown event, schema mismatch). */
  diagnostics: string[];
}

/** Dependencies passed to hook registration and script execution. */
export interface RegisterHooksDeps {
  /** Execution env (unused by the registry directly but reserved for future use). */
  env: unknown;
  /** Working directory forwarded to scripts as `cwd` in the stdin payload. */
  cwd: string;
  /** Active session id forwarded to scripts as `session_id`. */
  sessionId: string;
}

/**
 * Raw manifest shape as written in `hooks.json`:
 * `{ hooks: { <event>: HookMatcherGroup[] } }`.
 */
export interface HookManifest {
  hooks?: Record<string, HookMatcherGroup[]>;
}