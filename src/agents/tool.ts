import * as Type from "typebox";
import type { AgentTool, ThinkingLevel } from "@earendil-works/pi-agent-core/node";
import type { ToolDescriptor } from "../tools/contracts.js";
import { summarizeAgentRun } from "./format.js";
import type { AgentRunManager, AgentRunOwner } from "./manager.js";
import { resolveAgentPolicy, type ParentAgentCapabilities } from "./profiles.js";
import type { AgentRun, ParentSessionRef, ResolvedSubagentSettings } from "./types.js";

const Thinking = Type.Union([
  Type.Literal("off"),
  Type.Literal("minimal"),
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("xhigh"),
]);

const Parameters = Type.Object({
  action: Type.Union([
    Type.Literal("spawn"),
    Type.Literal("list"),
    Type.Literal("get"),
    Type.Literal("cancel"),
    Type.Literal("retry"),
  ]),
  runId: Type.Optional(Type.String()),
  task: Type.Optional(Type.String()),
  taskName: Type.Optional(Type.String()),
  label: Type.Optional(Type.String()),
  context: Type.Optional(Type.String()),
  profile: Type.Optional(Type.String()),
  contextMode: Type.Optional(Type.Union([Type.Literal("isolated"), Type.Literal("fork")])),
  model: Type.Optional(Type.String()),
  thinking: Type.Optional(Thinking),
  notify: Type.Optional(Type.Boolean()),
  workspaceMode: Type.Optional(Type.Union([Type.Literal("shared"), Type.Literal("worktree")])),
  status: Type.Optional(
    Type.Union([
      Type.Literal("queued"),
      Type.Literal("starting"),
      Type.Literal("running"),
      Type.Literal("succeeded"),
      Type.Literal("failed"),
      Type.Literal("interrupted"),
      Type.Literal("cancelled"),
    ]),
  ),
  limit: Type.Optional(Type.Number()),
});

const YieldParameters = Type.Object({});

export interface AgentToolBinding {
  manager: AgentRunManager;
  settings: ResolvedSubagentSettings;
  parent: ParentSessionRef;
  owner: AgentRunOwner;
  getParentCapabilities(): Promise<ParentAgentCapabilities> | ParentAgentCapabilities;
  getForkEntryId(): Promise<string | undefined>;
  modelAvailable?(provider: string, id: string): boolean;
}

export function createAgentsTool(binding: AgentToolBinding): AgentTool<typeof Parameters> {
  return {
    name: "agents",
    label: "Agent Runs",
    description:
      "Spawn and manage durable child-agent runs. Spawn returns immediately; use agents_yield instead of polling when waiting for completion.",
    parameters: Parameters,
    execute: async (_callId, params) => {
      if (params.action === "list") {
        const limit = Math.max(1, Math.min(50, Math.floor(params.limit ?? 20)));
        const runs = (await binding.manager.list(binding.owner, params.status)).slice(-limit);
        return result(
          runs.length > 0
            ? runs.map((run) => JSON.stringify(summarizeAgentRun(run))).join("\n")
            : "No agent runs.",
          { runs: runs.map(summarizeAgentRun) },
        );
      }
      if (params.action === "spawn") {
        if (!params.task?.trim()) throw new Error("agents spawn requires task");
        const capabilities = await binding.getParentCapabilities();
        const policy = resolveAgentPolicy({
          settings: binding.settings,
          parent: capabilities,
          ...(params.profile ? { profile: params.profile } : {}),
          ...(params.model ? { model: params.model } : {}),
          ...(params.thinking ? { thinking: params.thinking as ThinkingLevel } : {}),
          modelAvailable: binding.modelAvailable,
        });
        const contextMode = params.contextMode ?? "isolated";
        const forkEntryId = contextMode === "fork" ? await binding.getForkEntryId() : undefined;
        const run = await binding.manager.spawn({
          task: params.task,
          ...(params.taskName ? { taskName: params.taskName } : {}),
          ...(params.label ? { label: params.label } : {}),
          ...(params.context !== undefined ? { context: params.context } : {}),
          parent: binding.parent,
          policy,
          contextMode,
          ...(forkEntryId ? { forkEntryId } : {}),
          workspace: {
            cwd: binding.parent.session.cwd,
            mode: params.workspaceMode ?? "shared",
          },
          notify: params.notify !== false,
        });
        return result(
          `Spawned agent run ${run.id} (${run.profile}, ${run.status}). Completion is event-driven; do not poll.`,
          { run: summarizeAgentRun(run) },
        );
      }
      if (params.action === "cancel" && params.runId === "all") {
        const runs = await binding.manager.cancelAll(binding.owner);
        return result(`Cancellation requested for ${runs.length} agent run(s).`, {
          runs: runs.map(summarizeAgentRun),
        });
      }
      if (!params.runId) throw new Error(`agents ${params.action} requires runId`);
      if (params.action === "get") {
        const run = await binding.manager.get(binding.owner, params.runId);
        if (!run) throw new Error(`agent run not found: ${params.runId}`);
        return result(formatRun(run), { run: summarizeAgentRun(run) });
      }
      const run =
        params.action === "cancel"
          ? await binding.manager.cancel(binding.owner, params.runId)
          : await binding.manager.retry(binding.owner, params.runId);
      return result(formatRun(run), { run: summarizeAgentRun(run) });
    },
  };
}

export function createAgentsYieldTool(): AgentTool<typeof YieldParameters> {
  return {
    name: "agents_yield",
    label: "Yield for Agent Runs",
    description:
      "End the current parent loop after spawning child agents. The runtime will wake the parent when completions arrive.",
    parameters: YieldParameters,
    execute: async () => ({
      content: [{ type: "text", text: "Yielding until an agent completion event arrives." }],
      details: { yielded: true },
      terminate: true,
    }),
  };
}

export function createAgentToolDescriptors(binding: AgentToolBinding): ToolDescriptor[] {
  return [
    {
      name: "agents",
      label: "Agent Runs",
      source: { kind: "builtin", id: "agent-runtime" },
      capabilities: ["state.agents"],
      risk: "write",
      defaultPermission: "allow",
      defaultEnabled: true,
      streaming: "none",
      modes: ["tui", "print", "json", "gateway"],
      factory: () => createAgentsTool(binding),
      resolvePermissionIntents: (input) => [
        {
          capability: "state.agents",
          target: binding.owner.parentSessionId,
          scope: "session",
          summary: `agent runs ${actionName(input)}`,
        },
      ],
    },
    {
      name: "agents_yield",
      label: "Yield for Agent Runs",
      source: { kind: "builtin", id: "agent-runtime" },
      capabilities: ["state.agents"],
      risk: "write",
      defaultPermission: "allow",
      defaultEnabled: true,
      streaming: "none",
      modes: ["tui", "print", "json", "gateway"],
      factory: () => createAgentsYieldTool(),
      resolvePermissionIntents: () => [
        {
          capability: "state.agents",
          target: binding.owner.parentSessionId,
          scope: "session",
          summary: "yield parent turn for agent completions",
        },
      ],
    },
  ];
}

function formatRun(run: AgentRun): string {
  const lines = [JSON.stringify(summarizeAgentRun(run))];
  if (run.result !== undefined) lines.push(`Result:\n${run.result}`);
  if (run.error) lines.push(`Error ${run.error.code}: ${run.error.message}`);
  return lines.join("\n");
}

function actionName(input: unknown): string {
  return typeof input === "object" && input !== null && "action" in input
    ? String(input.action)
    : "operation";
}

function result(text: string, details: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], details };
}
