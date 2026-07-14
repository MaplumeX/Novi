import * as Type from "typebox";
import type { Static } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core/node";
import type { GatewaySessionRoute } from "../core/types.js";
import type { ToolDescriptor } from "../../tools/contracts.js";
import { formatJob, formatRun } from "./format.js";
import type { CreateJobInput, JobService } from "./service.js";

const Parameters = Type.Object({
  action: Type.Union([
    Type.Literal("create"),
    Type.Literal("list"),
    Type.Literal("get"),
    Type.Literal("pause"),
    Type.Literal("resume"),
    Type.Literal("cancel"),
    Type.Literal("run"),
    Type.Literal("retry_delivery"),
  ]),
  jobId: Type.Optional(Type.String()),
  runId: Type.Optional(Type.String()),
  name: Type.Optional(Type.String()),
  scheduleKind: Type.Optional(Type.Union([Type.Literal("at"), Type.Literal("cron")])),
  at: Type.Optional(Type.String()),
  local: Type.Optional(Type.String()),
  timezone: Type.Optional(Type.String()),
  expression: Type.Optional(Type.String()),
  payloadKind: Type.Optional(Type.Union([Type.Literal("reminder"), Type.Literal("agent")])),
  text: Type.Optional(Type.String()),
  prompt: Type.Optional(Type.String()),
  provider: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  tools: Type.Optional(Type.Array(Type.String())),
  target: Type.Optional(
    Type.Object({
      account: Type.String(),
      chatType: Type.Union([
        Type.Literal("direct"),
        Type.Literal("group"),
        Type.Literal("channel"),
        Type.Literal("thread"),
      ]),
      chatId: Type.String(),
      threadId: Type.Optional(Type.String()),
    }),
  ),
});

export function createJobsTool(
  service: JobService,
  owner: GatewaySessionRoute,
  onMutated: () => void,
): AgentTool<typeof Parameters> {
  return {
    name: "jobs",
    label: "Scheduled Jobs",
    description: "Create and manage durable reminders and cron jobs for the current chat route.",
    parameters: Parameters,
    execute: async (_callId, params) => {
      if (params.action === "list")
        return result(service.list(owner).map(formatJob).join("\n") || "No scheduled jobs.");
      if (params.action === "create") {
        const input = createInput(params);
        const job = await service.create(owner, input);
        onMutated();
        return result(formatJob(job), { job });
      }
      if (params.action === "retry_delivery") {
        if (!params.runId) throw new Error("jobs retry_delivery requires runId");
        const run = await service.retryDelivery(owner, params.runId);
        onMutated();
        return result(formatRun(run), { run });
      }
      if (!params.jobId) throw new Error(`jobs ${params.action} requires jobId`);
      if (params.action === "get") return result(formatJob(service.get(owner, params.jobId)));
      const value =
        params.action === "pause"
          ? await service.pause(owner, params.jobId)
          : params.action === "resume"
            ? await service.resume(owner, params.jobId)
            : params.action === "cancel"
              ? await service.cancel(owner, params.jobId)
              : await service.runNow(owner, params.jobId);
      onMutated();
      return "execution" in value
        ? result(formatRun(value), { run: value })
        : result(formatJob(value), { job: value });
    },
  };
}

export function createJobsToolDescriptor(
  service: JobService,
  owner: GatewaySessionRoute,
  onMutated: () => void,
): ToolDescriptor {
  return {
    name: "jobs",
    label: "Scheduled Jobs",
    source: { kind: "builtin", id: "gateway-internal" },
    capabilities: ["state.jobs"],
    risk: "write",
    defaultPermission: "allow",
    defaultEnabled: true,
    streaming: "none",
    modes: ["gateway"],
    factory: () => createJobsTool(service, owner, onMutated),
    resolvePermissionIntents: (input) => [
      {
        capability: "state.jobs",
        target: owner.key,
        scope: "session",
        summary: `scheduled jobs ${typeof input === "object" && input && "action" in input ? String(input.action) : "operation"}`,
      },
    ],
  };
}

function createInput(params: Static<typeof Parameters>): CreateJobInput {
  if (!params.name || !params.scheduleKind || !params.payloadKind)
    throw new Error("jobs create requires name, scheduleKind and payloadKind");
  const schedule: CreateJobInput["schedule"] =
    params.scheduleKind === "at"
      ? {
          kind: "at",
          ...(params.at ? { at: params.at } : {}),
          ...(params.local ? { local: params.local } : {}),
          ...(params.timezone ? { timezone: params.timezone } : {}),
        }
      : {
          kind: "cron",
          expression: params.expression ?? "",
          ...(params.timezone ? { timezone: params.timezone } : {}),
        };
  const payload: CreateJobInput["payload"] =
    params.payloadKind === "reminder"
      ? { kind: "reminder", text: params.text ?? "" }
      : {
          kind: "agent",
          prompt: params.prompt ?? "",
          provider: params.provider ?? "",
          model: params.model ?? "",
          ...(params.tools ? { tools: params.tools } : {}),
        };
  return {
    name: params.name,
    schedule,
    payload,
    ...(params.target
      ? {
          delivery: {
            kind: "telegram",
            target: {
              channel: "telegram",
              account: params.target.account,
              chat: { type: params.target.chatType, id: params.target.chatId },
              ...(params.target.threadId ? { thread: params.target.threadId } : {}),
            },
          },
        }
      : {}),
  };
}

function result(text: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text }], details };
}
