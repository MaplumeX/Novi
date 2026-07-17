import type {
  AgentHarness,
  JsonlSessionMetadata,
  Session,
} from "@earendil-works/pi-agent-core/node";
import type { GatewayEnv } from "../bootstrap.js";
import type { ToolDescriptor } from "../tools/contracts.js";
import { resolveSubagentSettings } from "./config.js";
import {
  ParentCompletionCoordinator,
  type AgentCompletionSink,
} from "./completion.js";
import { AgentRunExecutor } from "./executor.js";
import { AgentRunManager, type AgentRunOwner } from "./manager.js";
import type { ParentAgentCapabilities } from "./profiles.js";
import { AgentRunStore } from "./store.js";
import { createAgentToolDescriptors } from "./tool.js";
import type { ParentSessionRef, ResolvedSubagentSettings } from "./types.js";
import { addUsage, ZERO_USAGE, type UsageSummary } from "../usage.js";
import type { RunConcurrencyLimiter } from "../runs/concurrency.js";

export interface AgentRunRuntimeStats {
  total: number;
  queued: number;
  running: number;
  interrupted: number;
  pendingCompletion: number;
  deliveryFailed: number;
  usage: UsageSummary;
}

export interface AgentRuntimeParentBinding {
  parent: ParentSessionRef;
  harness: AgentHarness;
  session: Session<JsonlSessionMetadata>;
  resolveToolDescriptor(name: string): Readonly<ToolDescriptor> | undefined;
}

export interface CreateAgentRunRuntimeOptions {
  completionSink?: AgentCompletionSink;
  store?: AgentRunStore;
  initialize?: boolean;
  limiter?: RunConcurrencyLimiter;
}

/** Process-level child-agent runtime shared by every parent bound into it. */
export class AgentRunRuntime {
  readonly manager: AgentRunManager;
  readonly settings: ResolvedSubagentSettings;

  constructor(
    private readonly gatewayEnv: GatewayEnv,
    manager: AgentRunManager,
    settings: ResolvedSubagentSettings,
  ) {
    this.manager = manager;
    this.settings = settings;
  }

  createToolDescriptors(binding: AgentRuntimeParentBinding): ToolDescriptor[] {
    const owner: AgentRunOwner = {
      parentSessionId: binding.parent.session.id,
      generation: binding.parent.generation,
    };
    return createAgentToolDescriptors({
      manager: this.manager,
      settings: this.settings,
      parent: binding.parent,
      owner,
      getParentCapabilities: () => parentCapabilities(this.gatewayEnv, binding),
      getForkEntryId: async () => (await binding.session.getLeafId()) ?? undefined,
      modelAvailable: (provider, id) => this.gatewayEnv.models.getModel(provider, id) !== undefined,
    });
  }

  waitForIdle(): Promise<void> {
    return this.manager.waitForIdle();
  }

  stop(): Promise<void> {
    return this.manager.stop();
  }

  initialize(owner?: AgentRunOwner): Promise<void> {
    return this.manager.initialize(owner);
  }

  async getStats(): Promise<AgentRunRuntimeStats> {
    const runs = await this.manager.listAll();
    return {
      total: runs.length,
      queued: runs.filter((run) => run.status === "queued").length,
      running: runs.filter((run) => run.status === "starting" || run.status === "running").length,
      interrupted: runs.filter((run) => run.status === "interrupted").length,
      pendingCompletion: runs.filter(
        (run) => run.completion.status === "pending" || run.completion.status === "delivering",
      ).length,
      deliveryFailed: runs.filter((run) => run.completion.status === "delivery_failed").length,
      usage: runs.reduce(
        (total, run) => (run.usage ? addUsage(total, run.usage) : total),
        { ...ZERO_USAGE },
      ),
    };
  }
}

export async function createAgentRunRuntime(
  gatewayEnv: GatewayEnv,
  options: CreateAgentRunRuntimeOptions = {},
): Promise<AgentRunRuntime> {
  const settings = resolveSubagentSettings(gatewayEnv.settingsLayers).values;
  const store = options.store ?? (await AgentRunStore.open());
  await store.cleanup(settings.retentionDays);
  const completion = options.completionSink
    ? new ParentCompletionCoordinator(store, options.completionSink)
    : undefined;
  const executor = new AgentRunExecutor(gatewayEnv, {
    approver: gatewayEnv.approver,
    limiter: options.limiter,
  });
  const manager = new AgentRunManager({
    store,
    executor,
    settings,
    completion,
    onCancelRun: cancelApprovalsForRun(gatewayEnv.approver),
  });
  if (options.initialize !== false) await manager.initialize();
  return new AgentRunRuntime(gatewayEnv, manager, settings);
}

function cancelApprovalsForRun(
  approver: GatewayEnv["approver"],
): ((runId: string) => void) | undefined {
  const candidate = approver as (GatewayEnv["approver"] & {
    denyForRun?: (runId: string) => void;
  }) | undefined;
  return typeof candidate?.denyForRun === "function"
    ? (runId) => candidate.denyForRun?.(runId)
    : undefined;
}

function parentCapabilities(
  gatewayEnv: GatewayEnv,
  binding: AgentRuntimeParentBinding,
): ParentAgentCapabilities {
  const model = binding.harness.getModel();
  const activeToolNames = binding.harness.getActiveTools().map((tool) => tool.name);
  return {
    model: { provider: model.provider, id: model.id },
    thinking: binding.harness.getThinkingLevel(),
    activeToolNames,
    tools: activeToolNames.flatMap((name) => {
      const descriptor = binding.resolveToolDescriptor(name);
      return descriptor
        ? [
            {
              name: descriptor.name,
              label: descriptor.label,
              source: { ...descriptor.source },
              capabilities: [...descriptor.capabilities],
              risk: descriptor.risk,
              defaultPermission: descriptor.defaultPermission,
              defaultEnabled: descriptor.defaultEnabled,
              streaming: descriptor.streaming,
              modes: [...descriptor.modes],
              optional: descriptor.optional ?? false,
            },
          ]
        : [];
    }),
    skillNames: (binding.harness.getResources().skills ?? []).map((skill) => skill.name),
    permissions: gatewayEnv.permissions,
  };
}
