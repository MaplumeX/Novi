import path from "node:path";
import { uuidv7 } from "@earendil-works/pi-agent-core/node";
import type { JsonlSessionMetadata } from "@earendil-works/pi-agent-core/node";
import { terminalDeliveryKey } from "../runs/delivery.js";
import { toBoundedError } from "../runs/errors.js";
import type { ParentCompletionCoordinator } from "./completion.js";
import { AgentExecutionError, type AgentRunExecutor } from "./executor.js";
import { AgentRunEventBus } from "./events.js";
import type { ResolvedAgentPolicy } from "./profiles.js";
import { AgentRunQueue } from "./queue.js";
import { AgentRunStore, AgentRunStoreError } from "./store.js";
import type {
  AgentContextMode,
  AgentRun,
  AgentRunStatus,
  AgentWorkspaceMode,
  ParentSessionRef,
  ResolvedSubagentSettings,
} from "./types.js";

export type AgentRunManagerErrorCode =
  | "SUBAGENTS_DISABLED"
  | "AGENT_MANAGER_STOPPED"
  | "AGENT_DEPTH_EXCEEDED"
  | "AGENT_PARENT_NOT_FOUND"
  | "AGENT_RUN_NOT_FOUND"
  | "WORKTREE_UNSUPPORTED";

export class AgentRunManagerError extends Error {
  constructor(readonly code: AgentRunManagerErrorCode, message: string) {
    super(message);
  }
}

export interface SpawnAgentRunInput {
  task: string;
  taskName?: string;
  label?: string;
  context?: string;
  parent: ParentSessionRef;
  parentRunId?: string;
  policy: ResolvedAgentPolicy;
  contextMode?: AgentContextMode;
  forkEntryId?: string;
  workspace?: { cwd: string; mode?: AgentWorkspaceMode };
  notify?: boolean;
}

export interface AgentRunOwner {
  parentSessionId: string;
  generation: string;
}

export interface AgentRunManagerOptions {
  store: AgentRunStore;
  executor: Pick<AgentRunExecutor, "execute">;
  settings: ResolvedSubagentSettings;
  completion?: ParentCompletionCoordinator;
  events?: AgentRunEventBus;
  now?: () => Date;
  createId?: () => string;
  onCancelRun?: (runId: string) => void;
}

interface ActiveRun {
  run: AgentRun;
  controller: AbortController;
  parentKey: string;
  writeLease?: string;
}

/** Durable immediate-run scheduler with global/parent slots and cwd write leases. */
export class AgentRunManager {
  readonly events: AgentRunEventBus;
  private readonly queue = new AgentRunQueue();
  private readonly queuedRuns = new Map<string, AgentRun>();
  private readonly active = new Map<string, ActiveRun>();
  private readonly parentActive = new Map<string, number>();
  private readonly writeLeases = new Set<string>();
  private readonly completionTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly idleWaiters = new Set<() => void>();
  private readonly now: () => Date;
  private readonly createId: () => string;
  private accepting = true;
  private stopping = false;
  private pumping = false;

  constructor(private readonly options: AgentRunManagerOptions) {
    this.events = options.events ?? new AgentRunEventBus();
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? uuidv7;
  }

  async initialize(owner?: AgentRunOwner): Promise<void> {
    const runs = await this.options.store.list(
      owner
        ? { parentSessionId: owner.parentSessionId, generation: owner.generation }
        : undefined,
    );
    for (const initial of runs) {
      let run = initial;
      if (run.completion.status === "delivering") {
        run = await this.options.store.update(run.parent.session.id, run.id, (current) => ({
          ...current,
          completion: { ...current.completion, status: "pending", deliveryAmbiguous: true },
        }));
      }
      if (run.status === "starting" || run.status === "running") {
        run = await this.options.store.update(run.parent.session.id, run.id, (current) => ({
          ...current,
          status: "interrupted",
          finishedAt: this.now().toISOString(),
          error: {
            code: "AGENT_PROCESS_INTERRUPTED",
            message: "child agent process stopped before completion",
            retryable: !current.policySnapshot.writable,
          },
        }));
        if (!run.policySnapshot.writable && run.attempt < run.maxAttempts) {
          run = await this.options.store.update(run.parent.session.id, run.id, (current) => ({
            ...current,
            status: "queued",
            queuedAt: this.now().toISOString(),
            startedAt: undefined,
            finishedAt: undefined,
          }));
        } else {
          run = await this.markCompletionReady(run);
        }
      }
      if (
        run.status === "interrupted" &&
        run.error?.retryable === true &&
        !run.policySnapshot.writable &&
        run.attempt < run.maxAttempts
      ) {
        run = await this.options.store.update(run.parent.session.id, run.id, (current) => ({
          ...current,
          status: "queued",
          queuedAt: this.now().toISOString(),
          startedAt: undefined,
          finishedAt: undefined,
          completion: { ...current.completion, status: "not_required" },
        }));
      }
      if (run.status === "queued") this.enqueue(run);
      else if (run.completion.status === "pending") this.scheduleCompletion(run);
    }
    this.pump();
  }

  async spawn(input: SpawnAgentRunInput): Promise<AgentRun> {
    if (!this.accepting) throw new AgentRunManagerError("AGENT_MANAGER_STOPPED", "agent manager is stopping");
    if (!this.options.settings.enabled)
      throw new AgentRunManagerError("SUBAGENTS_DISABLED", "subagents are disabled");
    if (input.workspace?.mode === "worktree")
      throw new AgentRunManagerError("WORKTREE_UNSUPPORTED", "worktree workspace mode is not implemented");
    const id = this.createId();
    let depth = 1;
    let rootRunId = id;
    if (input.parentRunId) {
      const parentRun = await this.options.store.get(input.parent.session.id, input.parentRunId);
      if (!parentRun || parentRun.parent.generation !== input.parent.generation) {
        throw new AgentRunManagerError("AGENT_PARENT_NOT_FOUND", "parent agent run not found");
      }
      depth = parentRun.depth + 1;
      rootRunId = parentRun.rootRunId;
    }
    if (depth > this.options.settings.maxSpawnDepth) {
      throw new AgentRunManagerError(
        "AGENT_DEPTH_EXCEEDED",
        `child depth ${depth} exceeds maxSpawnDepth ${this.options.settings.maxSpawnDepth}`,
      );
    }
    const now = this.now().toISOString();
    const run: AgentRun = {
      version: 1,
      id,
      ...(input.taskName ? { taskName: input.taskName } : {}),
      ...(input.label ? { label: input.label } : {}),
      task: requiredText(input.task, "task"),
      ...(input.context !== undefined ? { context: input.context } : {}),
      parent: structuredClone(input.parent),
      ...(input.parentRunId ? { parentRunId: input.parentRunId } : {}),
      rootRunId,
      depth,
      profile: input.policy.snapshot.profile,
      contextMode: input.contextMode ?? "isolated",
      ...(input.forkEntryId ? { forkEntryId: input.forkEntryId } : {}),
      workspace: {
        cwd: path.resolve(input.workspace?.cwd ?? input.parent.session.cwd),
        mode: input.workspace?.mode ?? "shared",
      },
      model: { ...input.policy.model, thinking: input.policy.thinking },
      policySnapshot: structuredClone(input.policy.snapshot),
      status: "queued",
      attempt: 0,
      maxAttempts: input.policy.maxAttempts,
      createdAt: now,
      queuedAt: now,
      notify: input.notify !== false,
      completion: {
        status: "not_required",
        idempotencyKey: terminalDeliveryKey("agent-run", id),
        attempt: 0,
      },
    };
    const created = await this.options.store.create(run);
    this.enqueue(created);
    this.events.emit({ type: "agent_run", event: "queued", run: created });
    this.pump();
    return created;
  }

  list(owner: AgentRunOwner, status?: AgentRunStatus | readonly AgentRunStatus[]): Promise<AgentRun[]> {
    return this.options.store.list({
      parentSessionId: owner.parentSessionId,
      generation: owner.generation,
      ...(status ? { status } : {}),
    });
  }

  /** Operator-only global view; callers must project runs through the safe formatter. */
  listAll(status?: AgentRunStatus | readonly AgentRunStatus[]): Promise<AgentRun[]> {
    return this.options.store.list(status ? { status } : undefined);
  }

  async get(owner: AgentRunOwner, runId: string): Promise<AgentRun | undefined> {
    const run = await this.options.store.get(owner.parentSessionId, runId);
    return run?.parent.generation === owner.generation ? run : undefined;
  }

  async cancel(owner: AgentRunOwner, runId: string): Promise<AgentRun> {
    const run = await this.get(owner, runId);
    if (!run) throw new AgentRunManagerError("AGENT_RUN_NOT_FOUND", `agent run not found: ${runId}`);
    const descendants = (await this.list(owner)).filter((candidate) => candidate.parentRunId === runId);
    for (const child of descendants) await this.cancel(owner, child.id);
    if (["succeeded", "failed", "interrupted", "cancelled"].includes(run.status)) return run;
    if (run.status === "queued") {
      this.options.onCancelRun?.(run.id);
      this.queue.remove(run.id);
      this.queuedRuns.delete(run.id);
      const cancelled = await this.options.store.update(owner.parentSessionId, run.id, (current) => ({
        ...current,
        status: "cancelled",
        cancelRequestedAt: current.cancelRequestedAt ?? this.now().toISOString(),
        finishedAt: this.now().toISOString(),
        error: { code: "AGENT_RUN_CANCELLED", message: "child agent was cancelled", retryable: false },
        completion: { ...current.completion, status: current.notify ? "pending" : "suppressed" },
      }));
      this.events.emit({ type: "agent_run", event: "cancelled", run: cancelled });
      void this.deliverCompletion(cancelled);
      this.notifyIdle();
      return cancelled;
    }
    const requested = await this.options.store.update(owner.parentSessionId, run.id, (current) => ({
      ...current,
      cancelRequestedAt: current.cancelRequestedAt ?? this.now().toISOString(),
    }));
    this.options.onCancelRun?.(run.id);
    this.active.get(run.id)?.controller.abort(new Error("child agent was cancelled"));
    return requested;
  }

  async cancelAll(owner: AgentRunOwner): Promise<AgentRun[]> {
    const active = (await this.list(owner)).filter((run) =>
      ["queued", "starting", "running"].includes(run.status),
    );
    return Promise.all(active.map((run) => this.cancel(owner, run.id)));
  }

  async retry(owner: AgentRunOwner, runId: string): Promise<AgentRun> {
    const original = await this.get(owner, runId);
    if (!original) throw new AgentRunManagerError("AGENT_RUN_NOT_FOUND", `agent run not found: ${runId}`);
    if (["queued", "starting", "running"].includes(original.status)) {
      throw new AgentRunManagerError("AGENT_RUN_NOT_FOUND", "active agent run cannot be retried");
    }
    const id = this.createId();
    const now = this.now().toISOString();
    const retried: AgentRun = {
      ...structuredClone(original),
      id,
      retryOf: original.id,
      status: "queued",
      attempt: 0,
      createdAt: now,
      queuedAt: now,
      startedAt: undefined,
      finishedAt: undefined,
      cancelRequestedAt: undefined,
      childSession: undefined,
      usage: undefined,
      result: undefined,
      resultTruncated: undefined,
      error: undefined,
      completion: {
        status: "not_required",
        idempotencyKey: terminalDeliveryKey("agent-run", id),
        attempt: 0,
      },
    };
    const created = await this.options.store.create(retried);
    this.enqueue(created);
    this.events.emit({ type: "agent_run", event: "queued", run: created });
    this.pump();
    return created;
  }

  async waitForIdle(): Promise<void> {
    while (this.active.size > 0 || (!this.stopping && this.queue.size > 0)) {
      await new Promise<void>((resolve) => this.idleWaiters.add(resolve));
    }
    await this.options.completion?.waitForIdle();
  }

  async stop(): Promise<void> {
    this.accepting = false;
    this.stopping = true;
    for (const timer of this.completionTimers.values()) clearTimeout(timer);
    this.completionTimers.clear();
    for (const active of this.active.values()) {
      this.options.onCancelRun?.(active.run.id);
      active.controller.abort(new Error("agent runtime is stopping"));
    }
    await this.waitForIdle();
  }

  private enqueue(run: AgentRun): void {
    this.queuedRuns.set(run.id, run);
    this.queue.enqueue(run.id);
  }

  private pump(): void {
    if (this.pumping || this.stopping) return;
    this.pumping = true;
    try {
      while (this.active.size < this.options.settings.maxConcurrent) {
        const runId = this.queue.takeFirst((id) => {
          const run = this.queuedRuns.get(id);
          return run !== undefined && this.canStart(run);
        });
        if (!runId) break;
        const run = this.queuedRuns.get(runId);
        if (!run) continue;
        this.queuedRuns.delete(runId);
        const parentKey = ownerKey(run.parent);
        const writeLease = run.policySnapshot.writable ? leaseKey(run.workspace.cwd) : undefined;
        const active: ActiveRun = { run, controller: new AbortController(), parentKey, ...(writeLease ? { writeLease } : {}) };
        this.active.set(run.id, active);
        this.parentActive.set(parentKey, (this.parentActive.get(parentKey) ?? 0) + 1);
        if (writeLease) this.writeLeases.add(writeLease);
        void this.execute(active);
      }
    } finally {
      this.pumping = false;
    }
  }

  private canStart(run: AgentRun): boolean {
    if ((this.parentActive.get(ownerKey(run.parent)) ?? 0) >= this.options.settings.maxChildrenPerParent)
      return false;
    return !run.policySnapshot.writable || !this.writeLeases.has(leaseKey(run.workspace.cwd));
  }

  private async execute(active: ActiveRun): Promise<void> {
    let terminal: AgentRun | undefined;
    let current = active.run;
    try {
      current = await this.options.store.update(current.parent.session.id, current.id, (run) => ({
        ...run,
        status: "starting",
      }));
      const result = await this.options.executor.execute(current, active.controller.signal, {
        onSessionCreated: async (metadata: JsonlSessionMetadata) => {
          current = await this.options.store.update(current.parent.session.id, current.id, (run) => ({
            ...run,
            status: "running",
            attempt: run.attempt + 1,
            startedAt: this.now().toISOString(),
            childSession: metadata,
            error: undefined,
          }));
          this.events.emit({ type: "agent_run", event: "started", run: current });
        },
      });
      terminal = await this.options.store.update(current.parent.session.id, current.id, (run) => ({
        ...run,
        status: "succeeded",
        finishedAt: this.now().toISOString(),
        childSession: result.childSession,
        usage: result.usage,
        result: result.result,
        resultTruncated: result.resultTruncated,
        error: undefined,
        completion: { ...run.completion, status: run.notify ? "pending" : "suppressed" },
      }));
      this.events.emit({ type: "agent_run", event: "completed", run: terminal });
    } catch (error) {
      const latest = (await this.options.store.get(current.parent.session.id, current.id)) ?? current;
      const cancelled = latest.cancelRequestedAt !== undefined;
      const interruptedByStop = this.stopping && active.controller.signal.aborted;
      if (interruptedByStop) {
        terminal = await this.options.store.update(latest.parent.session.id, latest.id, (run) => ({
          ...run,
          status: "interrupted",
          finishedAt: this.now().toISOString(),
          error: { code: "AGENT_PROCESS_INTERRUPTED", message: "agent runtime stopped", retryable: !run.policySnapshot.writable },
          completion: {
            ...run.completion,
            status: run.policySnapshot.writable ? (run.notify ? "pending" : "suppressed") : "not_required",
          },
        }));
      } else if (cancelled || (active.controller.signal.aborted && error instanceof AgentExecutionError)) {
        terminal = await this.options.store.update(latest.parent.session.id, latest.id, (run) => ({
          ...run,
          status: "cancelled",
          finishedAt: this.now().toISOString(),
          cancelRequestedAt: run.cancelRequestedAt ?? this.now().toISOString(),
          error: { code: "AGENT_RUN_CANCELLED", message: "child agent was cancelled", retryable: false },
          completion: { ...run.completion, status: run.notify ? "pending" : "suppressed" },
        }));
        this.events.emit({ type: "agent_run", event: "cancelled", run: terminal });
      } else {
        const retryable = error instanceof AgentExecutionError && error.retryable;
        if (retryable && !latest.policySnapshot.writable && latest.attempt > 0 && latest.attempt < latest.maxAttempts) {
          const queued = await this.options.store.update(latest.parent.session.id, latest.id, (run) => ({
            ...run,
            status: "queued",
            queuedAt: this.now().toISOString(),
            finishedAt: undefined,
            error: toBoundedError(error, { code: error.code, retryable: true }),
          }));
          this.enqueue(queued);
          this.events.emit({ type: "agent_run", event: "queued", run: queued });
        } else {
          terminal = await this.options.store.update(latest.parent.session.id, latest.id, (run) => ({
            ...run,
            status: "failed",
            finishedAt: this.now().toISOString(),
            error: toBoundedError(error, {
              code: error instanceof AgentExecutionError ? error.code : "AGENT_RUN_FAILED",
              retryable,
            }),
            completion: { ...run.completion, status: run.notify ? "pending" : "suppressed" },
          }));
          this.events.emit({ type: "agent_run", event: "completed", run: terminal });
        }
      }
    } finally {
      this.release(active);
      this.pump();
    }
    if (terminal && terminal.completion.status === "pending") await this.deliverCompletion(terminal);
  }

  private release(active: ActiveRun): void {
    this.active.delete(active.run.id);
    const count = (this.parentActive.get(active.parentKey) ?? 1) - 1;
    if (count <= 0) this.parentActive.delete(active.parentKey);
    else this.parentActive.set(active.parentKey, count);
    if (active.writeLease) this.writeLeases.delete(active.writeLease);
    this.notifyIdle();
  }

  private async markCompletionReady(run: AgentRun): Promise<AgentRun> {
    return this.options.store.update(run.parent.session.id, run.id, (current) => ({
      ...current,
      completion: { ...current.completion, status: current.notify ? "pending" : "suppressed" },
    }));
  }

  private async deliverCompletion(run: AgentRun): Promise<void> {
    if (!this.options.completion || run.completion.status !== "pending") return;
    const timer = this.completionTimers.get(run.id);
    if (timer) clearTimeout(timer);
    this.completionTimers.delete(run.id);
    const delivered = await this.options.completion.deliver(run);
    this.events.emit({
      type: "agent_completion",
      event:
        delivered.completion.status === "delivered"
          ? "delivered"
          : delivered.completion.status === "suppressed"
            ? "suppressed"
            : "failed",
      run: delivered,
    });
    if (delivered.completion.status === "pending") this.scheduleCompletion(delivered);
    this.notifyIdle();
  }

  private scheduleCompletion(run: AgentRun): void {
    if (this.stopping || !this.options.completion || run.completion.status !== "pending") return;
    const existing = this.completionTimers.get(run.id);
    if (existing) clearTimeout(existing);
    const dueAt = run.completion.nextAttemptAt
      ? Date.parse(run.completion.nextAttemptAt)
      : this.now().getTime();
    const timer = setTimeout(async () => {
      this.completionTimers.delete(run.id);
      try {
        const current = await this.options.store.get(run.parent.session.id, run.id);
        if (current?.completion.status === "pending") await this.deliverCompletion(current);
      } catch {
        // Durable state remains pending and will be reconciled on restart.
      }
    }, Math.max(0, dueAt - this.now().getTime()));
    timer.unref();
    this.completionTimers.set(run.id, timer);
  }

  private notifyIdle(): void {
    if (this.active.size > 0 || (!this.stopping && this.queue.size > 0)) return;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }
}

function ownerKey(parent: ParentSessionRef): string {
  return `${parent.session.id}\0${parent.generation}`;
}

function leaseKey(cwd: string): string {
  return path.resolve(cwd);
}

function requiredText(value: string, label: string): string {
  if (value.trim().length === 0) throw new Error(`${label} must not be empty`);
  return value;
}

export function isAgentRunStoreNotFound(error: unknown): boolean {
  return error instanceof AgentRunStoreError && error.code === "AGENT_RUN_NOT_FOUND";
}
