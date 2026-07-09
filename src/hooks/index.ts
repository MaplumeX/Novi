export { loadHooks } from "./loader.js";
export { registerHooks, matcherMatches, makeComposedToolCallDispatcher } from "./registry.js";
export type { RegisterHooksOptions } from "./registry.js";
export { SUPPORTED_EVENTS } from "./types.js";
export type {
  HookConfig,
  HookHandlerConfig,
  HookManifest,
  HookMatcherGroup,
  RegisterHooksDeps,
} from "./types.js";