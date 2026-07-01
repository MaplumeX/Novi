import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { createBuiltinTools } from "../index.js";
import type { AgentTool } from "@earendil-works/pi-agent-core/node";
import { __resetTodoStoreForTests } from "../todo.js";

export async function setupEnv(): Promise<{ env: NodeExecutionEnv; cwd: string; cleanup: () => Promise<void> }> {
  const cwd = await mkdtemp(path.join(tmpdir(), "novi-tools-"));
  const env = new NodeExecutionEnv({ cwd, shellEnv: process.env });
  return {
    env,
    cwd,
    cleanup: async () => {
      await env.cleanup();
    },
  };
}

/** Look up a tool by name from the full built-in set. */
export function getTool(env: NodeExecutionEnv, name: string): AgentTool {
  const tool = createBuiltinTools(env).find((t) => t.name === name);
  if (!tool) throw new Error(`tool "${name}" not found in createBuiltinTools`);
  return tool;
}

export async function writeFixture(dir: string, rel: string, content: string): Promise<string> {
  const full = path.join(dir, rel);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, content, "utf8");
  return full;
}

/** Reset shared module-level state between tests (todo store). */
export function resetSharedState(): void {
  __resetTodoStoreForTests();
}
