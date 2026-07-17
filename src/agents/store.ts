import { readFile, readdir, rm, unlink } from "node:fs/promises";
import path from "node:path";
import type { JsonlSessionMetadata, ThinkingLevel } from "@earendil-works/pi-agent-core/node";
import { getNoviDir } from "../config.js";
import type { PermissionRule } from "../permissions/types.js";
import { createJsonExclusive, atomicWriteJson, ensurePrivateDirectory } from "../runs/atomic-file.js";
import { isTerminalRunStatus } from "../runs/execution.js";
import type { BoundedError } from "../runs/errors.js";
import type { UsageSummary } from "../usage.js";
import type {
  AgentCompletionStatus,
  AgentPolicySnapshot,
  AgentRun,
  AgentRunStatus,
  ParentSessionRef,
} from "./types.js";

const RUN_STATUSES: readonly AgentRunStatus[] = [
  "queued",
  "starting",
  "running",
  "succeeded",
  "failed",
  "interrupted",
  "cancelled",
];
const COMPLETION_STATUSES: readonly AgentCompletionStatus[] = [
  "not_required",
  "pending",
  "delivering",
  "delivered",
  "suppressed",
  "delivery_failed",
];
const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

export type AgentRunStoreErrorCode =
  | "AGENT_RUN_EXISTS"
  | "AGENT_RUN_NOT_FOUND"
  | "AGENT_RUN_CORRUPT"
  | "AGENT_RUN_INVALID";

export class AgentRunStoreError extends Error {
  constructor(
    readonly code: AgentRunStoreErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
  }
}

export interface AgentRunListFilter {
  parentSessionId?: string;
  generation?: string;
  status?: AgentRunStatus | readonly AgentRunStatus[];
}

/** Strict version-1 per-run ledger under `$NOVI_HOME/agent-runs`. */
export class AgentRunStore {
  private readonly mutations = new Map<string, Promise<unknown>>();

  private constructor(readonly rootPath: string) {}

  static async open(rootPath = path.join(getNoviDir(), "agent-runs")): Promise<AgentRunStore> {
    const store = new AgentRunStore(rootPath);
    await ensurePrivateDirectory(path.join(rootPath, "runs"));
    return store;
  }

  async create(run: AgentRun): Promise<AgentRun> {
    const decoded = decodeAgentRun(run);
    const filePath = this.runPath(decoded.parent.session.id, decoded.id);
    try {
      await createJsonExclusive(filePath, decoded);
      return clone(decoded);
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") {
        throw new AgentRunStoreError("AGENT_RUN_EXISTS", `agent run already exists: ${decoded.id}`);
      }
      throw error;
    }
  }

  async get(parentSessionId: string, runId: string): Promise<AgentRun | undefined> {
    const filePath = this.runPath(parentSessionId, runId);
    try {
      return decodeAgentRun(JSON.parse(await readFile(filePath, "utf8")) as unknown);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return undefined;
      throw new AgentRunStoreError(
        "AGENT_RUN_CORRUPT",
        `failed to load agent run "${runId}": ${errorMessage(error)}`,
        error,
      );
    }
  }

  async update(
    parentSessionId: string,
    runId: string,
    update: (run: AgentRun) => AgentRun,
  ): Promise<AgentRun> {
    return this.mutate(`${parentSessionId}\0${runId}`, async () => {
      const current = await this.get(parentSessionId, runId);
      if (!current) {
        throw new AgentRunStoreError("AGENT_RUN_NOT_FOUND", `agent run not found: ${runId}`);
      }
      const next = decodeAgentRun(update(clone(current)));
      if (next.id !== runId || next.parent.session.id !== parentSessionId) {
        throw new AgentRunStoreError(
          "AGENT_RUN_INVALID",
          "agent run identity cannot change during update",
        );
      }
      await atomicWriteJson(this.runPath(parentSessionId, runId), next);
      return clone(next);
    });
  }

  async list(filter: AgentRunListFilter = {}): Promise<AgentRun[]> {
    const runsRoot = path.join(this.rootPath, "runs");
    const parentIds = filter.parentSessionId
      ? [safeId(filter.parentSessionId, "parent session id")]
      : await directoryNames(runsRoot);
    const statuses = filter.status === undefined
      ? undefined
      : new Set(Array.isArray(filter.status) ? filter.status : [filter.status]);
    const runs: AgentRun[] = [];
    for (const parentId of parentIds) {
      const directory = path.join(runsRoot, parentId);
      const files = await fileNames(directory);
      for (const file of files.filter((name) => name.endsWith(".json"))) {
        const runId = file.slice(0, -5);
        const run = await this.get(parentId, runId);
        if (!run) continue;
        if (filter.generation !== undefined && run.parent.generation !== filter.generation) continue;
        if (statuses && !statuses.has(run.status)) continue;
        runs.push(run);
      }
    }
    return runs.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  async cleanup(retentionDays: number, now = new Date()): Promise<number> {
    if (!Number.isSafeInteger(retentionDays) || retentionDays < 1) {
      throw new AgentRunStoreError("AGENT_RUN_INVALID", "retentionDays must be a positive integer");
    }
    const cutoff = now.getTime() - retentionDays * 86_400_000;
    let removed = 0;
    for (const run of await this.list()) {
      if (!isTerminalRunStatus(run.status)) continue;
      if (["pending", "delivering"].includes(run.completion.status)) continue;
      const terminalAt = Date.parse(run.finishedAt ?? run.createdAt);
      if (terminalAt >= cutoff) continue;
      await unlink(this.runPath(run.parent.session.id, run.id));
      removed++;
    }
    for (const parentId of await directoryNames(path.join(this.rootPath, "runs"))) {
      const directory = path.join(this.rootPath, "runs", parentId);
      if ((await fileNames(directory)).length === 0) await rm(directory, { recursive: true, force: true });
    }
    return removed;
  }

  private runPath(parentSessionId: string, runId: string): string {
    return path.join(
      this.rootPath,
      "runs",
      safeId(parentSessionId, "parent session id"),
      `${safeId(runId, "run id")}.json`,
    );
  }

  private async mutate<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.mutations.get(key) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    this.mutations.set(key, result);
    try {
      return await result;
    } finally {
      if (this.mutations.get(key) === result) this.mutations.delete(key);
    }
  }
}

export function decodeAgentRun(value: unknown): AgentRun {
  const run = record(value, "run");
  exactKeys(run, [
    "version", "id", "taskName", "label", "task", "context", "parent", "parentRunId", "rootRunId",
    "depth", "retryOf", "profile", "contextMode", "forkEntryId", "workspace", "model",
    "policySnapshot", "status", "attempt", "maxAttempts", "createdAt", "queuedAt", "startedAt",
    "finishedAt", "cancelRequestedAt", "childSession", "usage", "result", "resultTruncated", "error",
    "notify", "completion",
  ], "run");
  if (run.version !== 1) invalid(`unsupported agent run version: ${String(run.version)}`);
  const parent = decodeParent(run.parent);
  const workspace = record(run.workspace, "run.workspace");
  exactKeys(workspace, ["cwd", "mode"], "run.workspace");
  const model = record(run.model, "run.model");
  exactKeys(model, ["provider", "id", "thinking"], "run.model");
  const completion = record(run.completion, "run.completion");
  exactKeys(completion, [
    "status", "idempotencyKey", "attempt", "nextAttemptAt", "parentEntryId", "deliveredAt",
    "deliveryAmbiguous", "error",
  ], "run.completion");
  return {
    version: 1,
    id: safeId(text(run.id, "run.id"), "run.id"),
    ...(run.taskName !== undefined ? { taskName: text(run.taskName, "run.taskName") } : {}),
    ...(run.label !== undefined ? { label: text(run.label, "run.label") } : {}),
    task: text(run.task, "run.task"),
    ...(run.context !== undefined ? { context: stringValue(run.context, "run.context") } : {}),
    parent,
    ...(run.parentRunId !== undefined ? { parentRunId: safeId(text(run.parentRunId, "run.parentRunId"), "run.parentRunId") } : {}),
    rootRunId: safeId(text(run.rootRunId, "run.rootRunId"), "run.rootRunId"),
    depth: integer(run.depth, "run.depth", 0),
    ...(run.retryOf !== undefined ? { retryOf: safeId(text(run.retryOf, "run.retryOf"), "run.retryOf") } : {}),
    profile: name(run.profile, "run.profile"),
    contextMode: oneOf(run.contextMode, ["isolated", "fork"] as const, "run.contextMode"),
    ...(run.forkEntryId !== undefined ? { forkEntryId: text(run.forkEntryId, "run.forkEntryId") } : {}),
    workspace: {
      cwd: absolutePath(workspace.cwd, "run.workspace.cwd"),
      mode: oneOf(workspace.mode, ["shared", "worktree"] as const, "run.workspace.mode"),
    },
    model: {
      provider: text(model.provider, "run.model.provider"),
      id: text(model.id, "run.model.id"),
      thinking: oneOf(model.thinking, THINKING_LEVELS, "run.model.thinking"),
    },
    policySnapshot: decodePolicy(run.policySnapshot),
    status: oneOf(run.status, RUN_STATUSES, "run.status"),
    attempt: integer(run.attempt, "run.attempt", 0),
    maxAttempts: integer(run.maxAttempts, "run.maxAttempts", 1),
    createdAt: iso(run.createdAt, "run.createdAt"),
    queuedAt: iso(run.queuedAt, "run.queuedAt"),
    ...(run.startedAt !== undefined ? { startedAt: iso(run.startedAt, "run.startedAt") } : {}),
    ...(run.finishedAt !== undefined ? { finishedAt: iso(run.finishedAt, "run.finishedAt") } : {}),
    ...(run.cancelRequestedAt !== undefined ? { cancelRequestedAt: iso(run.cancelRequestedAt, "run.cancelRequestedAt") } : {}),
    ...(run.childSession !== undefined ? { childSession: decodeSession(run.childSession, "run.childSession") } : {}),
    ...(run.usage !== undefined ? { usage: decodeUsage(run.usage) } : {}),
    ...(run.result !== undefined ? { result: stringValue(run.result, "run.result") } : {}),
    ...(run.resultTruncated !== undefined ? { resultTruncated: bool(run.resultTruncated, "run.resultTruncated") } : {}),
    ...(run.error !== undefined ? { error: decodeError(run.error, "run.error") } : {}),
    notify: bool(run.notify, "run.notify"),
    completion: {
      status: oneOf(completion.status, COMPLETION_STATUSES, "run.completion.status"),
      idempotencyKey: text(completion.idempotencyKey, "run.completion.idempotencyKey"),
      attempt: integer(completion.attempt, "run.completion.attempt", 0),
      ...(completion.nextAttemptAt !== undefined ? { nextAttemptAt: iso(completion.nextAttemptAt, "run.completion.nextAttemptAt") } : {}),
      ...(completion.parentEntryId !== undefined ? { parentEntryId: text(completion.parentEntryId, "run.completion.parentEntryId") } : {}),
      ...(completion.deliveredAt !== undefined ? { deliveredAt: iso(completion.deliveredAt, "run.completion.deliveredAt") } : {}),
      ...(completion.deliveryAmbiguous !== undefined ? { deliveryAmbiguous: bool(completion.deliveryAmbiguous, "run.completion.deliveryAmbiguous") } : {}),
      ...(completion.error !== undefined ? { error: decodeError(completion.error, "run.completion.error") } : {}),
    },
  };
}

function decodeParent(value: unknown): ParentSessionRef {
  const parent = record(value, "run.parent");
  exactKeys(parent, ["surface", "session", "generation", "route"], "run.parent");
  return {
    surface: oneOf(parent.surface, ["tui", "json", "gateway"] as const, "run.parent.surface"),
    session: decodeSession(parent.session, "run.parent.session"),
    generation: text(parent.generation, "run.parent.generation"),
    ...(parent.route !== undefined ? { route: decodeRoute(parent.route) } : {}),
  };
}

function decodeSession(value: unknown, label: string): JsonlSessionMetadata {
  const session = record(value, label);
  exactKeys(session, ["id", "createdAt", "cwd", "path", "parentSessionPath"], label);
  return {
    id: safeId(text(session.id, `${label}.id`), `${label}.id`),
    createdAt: iso(session.createdAt, `${label}.createdAt`),
    cwd: absolutePath(session.cwd, `${label}.cwd`),
    path: absolutePath(session.path, `${label}.path`),
    ...(session.parentSessionPath !== undefined
      ? { parentSessionPath: absolutePath(session.parentSessionPath, `${label}.parentSessionPath`) }
      : {}),
  };
}

function decodeRoute(value: unknown): ParentSessionRef["route"] {
  const route = record(value, "run.parent.route");
  exactKeys(route, ["key", "locator"], "run.parent.route");
  const locator = record(route.locator, "run.parent.route.locator");
  exactKeys(locator, ["channel", "account", "chat", "thread", "replyTo"], "run.parent.route.locator");
  const chat = record(locator.chat, "run.parent.route.locator.chat");
  exactKeys(chat, ["type", "id"], "run.parent.route.locator.chat");
  return {
    key: text(route.key, "run.parent.route.key"),
    locator: {
      channel: text(locator.channel, "run.parent.route.locator.channel"),
      account: text(locator.account, "run.parent.route.locator.account"),
      chat: {
        type: oneOf(chat.type, ["direct", "group", "channel", "thread"] as const, "run.parent.route.locator.chat.type"),
        id: text(chat.id, "run.parent.route.locator.chat.id"),
      },
      ...(locator.thread !== undefined ? { thread: text(locator.thread, "run.parent.route.locator.thread") } : {}),
      ...(locator.replyTo !== undefined ? { replyTo: text(locator.replyTo, "run.parent.route.locator.replyTo") } : {}),
    },
  };
}

function decodePolicy(value: unknown): AgentPolicySnapshot {
  const policy = record(value, "run.policySnapshot");
  exactKeys(policy, [
    "profile", "writable", "activeToolNames", "skillNames", "mcpSources", "permissions",
    "systemPrompt", "allowedModels", "runTimeoutMs", "maxResultBytes",
  ], "run.policySnapshot");
  return {
    profile: name(policy.profile, "run.policySnapshot.profile"),
    writable: bool(policy.writable, "run.policySnapshot.writable"),
    activeToolNames: stringArray(policy.activeToolNames, "run.policySnapshot.activeToolNames"),
    skillNames: stringArray(policy.skillNames, "run.policySnapshot.skillNames"),
    mcpSources: stringArray(policy.mcpSources, "run.policySnapshot.mcpSources"),
    permissions: permissionArray(policy.permissions, "run.policySnapshot.permissions"),
    systemPrompt: text(policy.systemPrompt, "run.policySnapshot.systemPrompt"),
    ...(policy.allowedModels !== undefined ? { allowedModels: stringArray(policy.allowedModels, "run.policySnapshot.allowedModels") } : {}),
    runTimeoutMs: integer(policy.runTimeoutMs, "run.policySnapshot.runTimeoutMs", 1),
    maxResultBytes: integer(policy.maxResultBytes, "run.policySnapshot.maxResultBytes", 1),
  };
}

function permissionArray(value: unknown, label: string): PermissionRule[] {
  if (!Array.isArray(value)) invalid(`${label} must be an array`);
  return value.map((raw, index) => {
    const rule = record(raw, `${label}.${index}`);
    exactKeys(rule, ["effect", "tool", "capability", "target", "scope"], `${label}.${index}`);
    return {
      effect: oneOf(rule.effect, ["allow", "ask", "deny"] as const, `${label}.${index}.effect`),
      ...(rule.tool !== undefined ? { tool: text(rule.tool, `${label}.${index}.tool`) } : {}),
      ...(rule.capability !== undefined ? { capability: text(rule.capability, `${label}.${index}.capability`) as PermissionRule["capability"] } : {}),
      ...(rule.target !== undefined ? { target: text(rule.target, `${label}.${index}.target`) } : {}),
      ...(rule.scope !== undefined ? { scope: text(rule.scope, `${label}.${index}.scope`) as PermissionRule["scope"] } : {}),
    };
  });
}

function decodeUsage(value: unknown): UsageSummary {
  const usage = record(value, "run.usage");
  exactKeys(usage, ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "cost"], "run.usage");
  return {
    inputTokens: finite(usage.inputTokens, "run.usage.inputTokens"),
    outputTokens: finite(usage.outputTokens, "run.usage.outputTokens"),
    cacheReadTokens: finite(usage.cacheReadTokens, "run.usage.cacheReadTokens"),
    cacheWriteTokens: finite(usage.cacheWriteTokens, "run.usage.cacheWriteTokens"),
    cost: finite(usage.cost, "run.usage.cost"),
  };
}

function decodeError(value: unknown, label: string): BoundedError {
  const error = record(value, label);
  exactKeys(error, ["code", "message", "retryable", "retryAfterMs"], label);
  return {
    code: text(error.code, `${label}.code`),
    message: text(error.message, `${label}.message`),
    retryable: bool(error.retryable, `${label}.retryable`),
    ...(error.retryAfterMs !== undefined ? { retryAfterMs: integer(error.retryAfterMs, `${label}.retryAfterMs`, 0) } : {}),
  };
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length > 0) invalid(`${label} contains unknown fields: ${extras.join(", ")}`);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) invalid(`${label} must be a non-empty string`);
  return value;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string") invalid(`${label} must be a string`);
  return value;
}

function name(value: unknown, label: string): string {
  const result = text(value, label);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(result)) invalid(`${label} is invalid`);
  return result;
}

function safeId(value: string, label: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) invalid(`${label} is invalid`);
  return value;
}

function absolutePath(value: unknown, label: string): string {
  const result = text(value, label);
  if (!path.isAbsolute(result)) invalid(`${label} must be absolute`);
  return path.normalize(result);
}

function iso(value: unknown, label: string): string {
  const result = text(value, label);
  if (Number.isNaN(Date.parse(result))) invalid(`${label} must be ISO time`);
  return result;
}

function bool(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") invalid(`${label} must be boolean`);
  return value;
}

function integer(value: unknown, label: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) invalid(`${label} must be an integer >= ${minimum}`);
  return value as number;
}

function finite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) invalid(`${label} must be non-negative`);
  return value;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) invalid(`${label} must be a string array`);
  return [...new Set(value as string[])];
}

function oneOf<const T extends readonly string[]>(value: unknown, values: T, label: string): T[number] {
  if (typeof value !== "string" || !values.includes(value)) invalid(`${label} is invalid`);
  return value as T[number];
}

function invalid(message: string): never {
  throw new AgentRunStoreError("AGENT_RUN_INVALID", message);
}

async function directoryNames(root: string): Promise<string[]> {
  try {
    return (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }
}

async function fileNames(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && !entry.isSymbolicLink())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
