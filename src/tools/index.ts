import type { AgentTool } from "@earendil-works/pi-agent-core/node";
import type { ExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { createBashTool } from "./bash.js";
import { createEditFileTool } from "./edit-file.js";
import { createGlobTool } from "./glob.js";
import { createGrepTool } from "./grep.js";
import { createLsTool } from "./ls.js";
import { createReadFileTool } from "./read-file.js";
import { createTodoTool } from "./todo.js";
import { createWriteFileTool } from "./write-file.js";

/**
 * Build the full set of built-in tools, each closing over the shared
 * {@link ExecutionEnv}. Register via `harness.setTools(createBuiltinTools(env))`.
 */
export function createBuiltinTools(env: ExecutionEnv): AgentTool[] {
  return [
    createReadFileTool(env),
    createWriteFileTool(env),
    createEditFileTool(env),
    createBashTool(env),
    createLsTool(env),
    createGlobTool(env),
    createGrepTool(env),
    createTodoTool(),
  ];
}
