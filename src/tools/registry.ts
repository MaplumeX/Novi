import type { AgentTool } from "@earendil-works/pi-agent-core/node";
import type { ExecutionEnv } from "@earendil-works/pi-agent-core/node";

/**
 * Factory that builds a single {@link AgentTool} from a shared
 * {@link ExecutionEnv} and the current session id. Tools that don't need the
 * session id (most tools) simply ignore the second parameter.
 */
export type ToolFactory = (env: ExecutionEnv, sessionId: string) => AgentTool;

interface ToolRegistration {
  name: string;
  factory: ToolFactory;
}

/**
 * Central registry for built-in tools. Replaces ad-hoc array literals with
 * explicit `.add()` calls so that the tool set is declared in one place and
 * easy to audit. Callers still use {@link buildAll} (via
 * `createBuiltinTools`) to get a ready-to-use {@link AgentTool} array.
 */
export class BuiltinToolRegistry {
  private readonly entries: ToolRegistration[] = [];

  /** Register a tool factory under `name`. Chainable. */
  add(name: string, factory: ToolFactory): this {
    this.entries.push({ name, factory });
    return this;
  }

  /** Build every registered tool, closing over `env` and `sessionId`. */
  buildAll(env: ExecutionEnv, sessionId: string): AgentTool[] {
    return this.entries.map((entry) => entry.factory(env, sessionId));
  }

  /** Registered tool names, in insertion order. */
  names(): string[] {
    return this.entries.map((entry) => entry.name);
  }
}
