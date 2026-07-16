import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { createBuiltinToolAssembly } from "./index.js";
import type { AgentTool } from "@earendil-works/pi-agent-core/node";
import { __resetTodoStoreForTests } from "./todo.js";
import type { CreateBuiltinToolAssemblyOptions } from "./index.js";
import { isToolResultEnvelope, type ToolResultEnvelope } from "./events.js";

export async function setupEnv(): Promise<{
  env: NodeExecutionEnv;
  cwd: string;
  cleanup: () => Promise<void>;
}> {
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
export function getTool(
  env: NodeExecutionEnv,
  name: string,
  sessionId = "test-session",
  options: CreateBuiltinToolAssemblyOptions = {},
): AgentTool {
  const tool = createBuiltinToolAssembly(env, sessionId, options).tools.find(
    (candidate) => candidate.name === name,
  );
  if (!tool) throw new Error(`tool "${name}" not found in createBuiltinToolAssembly`);
  return tool;
}

/**
 * Look up multiple tools by name from a single shared assembly so they share
 * one `ToolExecutionRuntime` (and its `readCache`).
 */
export function getTools(
  env: NodeExecutionEnv,
  names: readonly string[],
  sessionId = "test-session",
  options: CreateBuiltinToolAssemblyOptions = {},
): Record<string, AgentTool> {
  const tools = createBuiltinToolAssembly(env, sessionId, options).tools;
  const result: Record<string, AgentTool> = {};
  for (const name of names) {
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`tool "${name}" not found in createBuiltinToolAssembly`);
    result[name] = tool;
  }
  return result;
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

/** Read the production final-result contract from a wrapped tool result. */
export function toolEnvelope(result: { details?: unknown }): ToolResultEnvelope {
  const details =
    result.details !== null && typeof result.details === "object"
      ? (result.details as Record<string, unknown>)
      : {};
  if (!isToolResultEnvelope(details.envelope)) throw new Error("missing tool result envelope");
  return details.envelope;
}

export function envelopeData(result: { details?: unknown }): Record<string, unknown> {
  const data = toolEnvelope(result).data;
  return data !== null && typeof data === "object" && !Array.isArray(data) ? data : {};
}
