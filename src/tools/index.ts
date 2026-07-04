import type { AgentTool } from "@earendil-works/pi-agent-core/node";
import type { ExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { createBashTool } from "./bash.js";
import { createEditFileTool } from "./edit-file.js";
import { createFetchContentTool } from "./fetch-content.js";
import { createGlobTool } from "./glob.js";
import { createGrepTool } from "./grep.js";
import { createLsTool } from "./ls.js";
import { createReadFileTool } from "./read-file.js";
import { BuiltinToolRegistry } from "./registry.js";
import { createTodoTool } from "./todo.js";
import { createWebSearchTool } from "./web-search.js";
import { createWriteFileTool } from "./write-file.js";

/** Module-level registry declaring every built-in tool in one place. */
const registry = new BuiltinToolRegistry()
  .add("read_file", (env) => createReadFileTool(env))
  .add("write_file", (env) => createWriteFileTool(env))
  .add("edit_file", (env) => createEditFileTool(env))
  .add("bash", (env) => createBashTool(env))
  .add("ls", (env) => createLsTool(env))
  .add("glob", (env) => createGlobTool(env))
  .add("grep", (env) => createGrepTool(env))
  .add("todo", (_env, sessionId) => createTodoTool(sessionId))
  .add("web_search", (env) => createWebSearchTool(env))
  .add("fetch_content", (env) => createFetchContentTool(env));

/**
 * Build the full set of built-in tools, each closing over the shared
 * {@link ExecutionEnv} and the active session id. Register via
 * `harness.setTools(createBuiltinTools(env, sessionId))`.
 */
export function createBuiltinTools(env: ExecutionEnv, sessionId: string): AgentTool[] {
  return registry.buildAll(env, sessionId);
}
