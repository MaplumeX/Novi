import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { getNoviDir } from "../../config.js";
import type { GatewaySessionLocator } from "../core/types.js";
import type { GatewayLogger } from "./logger.js";
import type { GatewayMetrics } from "./metrics.js";
import type { GatewayRuntimeSnapshot } from "./snapshot.js";

interface PersistedFault {
  active: boolean;
  firstObservedAt: string;
  lastObservedAt: string;
  lastSentAt?: string;
  lastAttemptAt?: string;
  resolvedAt?: string;
}

interface OperationsState {
  version: 1;
  faults: Record<string, PersistedFault>;
}

export interface GatewayAlertOptions {
  target?: GatewaySessionLocator;
  cooldownMs: number;
  backlogRecords: number;
  backlogAgeMs: number;
  channelDownMs: number;
  store: GatewayOperationsStore;
  validateTarget: (target: GatewaySessionLocator) => Promise<boolean>;
  enqueue: (target: GatewaySessionLocator, sourceId: string, text: string) => Promise<void>;
  metrics?: GatewayMetrics;
  logger?: GatewayLogger;
  now?: () => Date;
}

interface RuntimeFault {
  key: string;
  summary: string;
  minimumAgeMs: number;
}

/** Persistent alert cooldown state, committed atomically as one small document. */
export class GatewayOperationsStore {
  #state: OperationsState;

  private constructor(
    readonly filePath: string,
    state: OperationsState,
  ) {
    this.#state = state;
  }

  static async open(
    filePath = path.join(getNoviDir(), "gateway-operations.json"),
  ): Promise<GatewayOperationsStore> {
    try {
      return new GatewayOperationsStore(
        filePath,
        decodeState(JSON.parse(await readFile(filePath, "utf8"))),
      );
    } catch (error) {
      if (readErrorCode(error) === "ENOENT") {
        return new GatewayOperationsStore(filePath, { version: 1, faults: {} });
      }
      throw new Error(`failed to load Gateway operations state: ${errorMessage(error)}`, {
        cause: error,
      });
    }
  }

  snapshot(): OperationsState {
    return structuredClone(this.#state);
  }

  async replace(state: OperationsState): Promise<void> {
    const decoded = decodeState(state);
    await writeAtomic(this.filePath, decoded);
    this.#state = structuredClone(decoded);
  }
}

/** Evaluates runtime faults, de-duplicates them across restarts, and enqueues durable alerts. */
export class GatewayAlertManager {
  readonly #options: GatewayAlertOptions;
  #degradedReasons = new Set<string>();
  #mutation = Promise.resolve();

  constructor(options: GatewayAlertOptions) {
    this.#options = options;
  }

  getDegradedReasons(): string[] {
    return [...this.#degradedReasons].sort();
  }

  async observe(snapshot: GatewayRuntimeSnapshot): Promise<void> {
    const operation = this.#mutation.then(() => this.#observe(snapshot));
    this.#mutation = operation.catch(() => undefined);
    return operation;
  }

  async #observe(snapshot: GatewayRuntimeSnapshot): Promise<void> {
    if (this.#options.target === undefined) return;
    const now = (this.#options.now ?? (() => new Date()))();
    const nowIso = now.toISOString();
    const current = new Map(
      runtimeFaults(snapshot, this.#options).map((fault) => [fault.key, fault]),
    );
    const state = this.#options.store.snapshot();

    for (const fault of current.values()) {
      const previous = state.faults[fault.key];
      const firstObservedAt = previous?.active ? previous.firstObservedAt : nowIso;
      const next: PersistedFault = {
        active: true,
        firstObservedAt,
        lastObservedAt: nowIso,
        ...(!previous?.active || previous.lastSentAt === undefined
          ? {}
          : { lastSentAt: previous.lastSentAt }),
        ...(!previous?.active || previous.lastAttemptAt === undefined
          ? {}
          : { lastAttemptAt: previous.lastAttemptAt }),
      };
      state.faults[fault.key] = next;
      const oldEnough = now.getTime() - Date.parse(firstObservedAt) >= fault.minimumAgeMs;
      const cooldownElapsed =
        next.lastAttemptAt === undefined ||
        now.getTime() - Date.parse(next.lastAttemptAt) >= this.#options.cooldownMs;
      if (oldEnough && cooldownElapsed) {
        const sent = await this.#enqueue(
          fault.key,
          `Novi Gateway alert: ${fault.summary}\nFault: ${fault.key}\nState: ${snapshot.state}`,
          now,
        );
        next.lastAttemptAt = nowIso;
        if (sent) next.lastSentAt = nowIso;
        else this.#options.metrics?.increment("alertsSuppressed");
      }
    }

    for (const [key, previous] of Object.entries(state.faults)) {
      if (!previous.active || current.has(key)) continue;
      state.faults[key] = {
        ...previous,
        active: false,
        lastObservedAt: nowIso,
        resolvedAt: nowIso,
      };
      if (previous.lastSentAt !== undefined) {
        await this.#enqueue(
          `resolved:${key}`,
          `Novi Gateway resolved: ${key}\nState: ${snapshot.state}`,
          now,
        );
      }
    }
    await this.#options.store.replace(state);
  }

  async #enqueue(key: string, text: string, now: Date): Promise<boolean> {
    const target = this.#options.target;
    if (target === undefined) return false;
    if (!(await this.#options.validateTarget(target))) {
      this.#degradedReasons.add("alerts:target_invalid");
      this.#options.logger?.warn("gateway.alert.target_invalid", { faultKey: key });
      return false;
    }
    this.#degradedReasons.delete("alerts:target_invalid");
    const digest = createHash("sha256").update(key).digest("hex").slice(0, 16);
    try {
      await this.#options.enqueue(target, `operations-alert:${digest}:${now.getTime()}`, text);
      this.#degradedReasons.delete("alerts:enqueue_failed");
      this.#options.metrics?.increment("alertsEnqueued");
      this.#options.logger?.warn("gateway.alert.enqueued", { faultKey: key });
      return true;
    } catch (error) {
      this.#degradedReasons.add("alerts:enqueue_failed");
      this.#options.logger?.error("gateway.alert.enqueue_failed", error, { faultKey: key });
      return false;
    }
  }
}

function runtimeFaults(
  snapshot: GatewayRuntimeSnapshot,
  options: GatewayAlertOptions,
): RuntimeFault[] {
  const faults: RuntimeFault[] = [];
  for (const channel of snapshot.channels) {
    if (channel.state === "failed") {
      faults.push({
        key: `channel:${channel.id}:down`,
        summary: `channel ${channel.id} is unavailable`,
        minimumAgeMs: options.channelDownMs,
      });
    }
  }
  if (
    snapshot.messages &&
    (snapshot.messages.nonTerminalRecords >= options.backlogRecords ||
      snapshot.messages.oldestPendingAgeMs >= options.backlogAgeMs)
  ) {
    faults.push({
      key: "outbox:backlog",
      summary: "durable message backlog is elevated",
      minimumAgeMs: 0,
    });
  }
  if (snapshot.messages?.exhaustedCount) {
    faults.push({
      key: "outbox:retry_exhausted",
      summary: "message delivery retries are exhausted",
      minimumAgeMs: 0,
    });
  }
  if (snapshot.messages?.degraded) {
    faults.push({
      key: "store:capacity",
      summary: "message store capacity limit is exceeded",
      minimumAgeMs: 0,
    });
  }
  if (snapshot.agentRuns?.deliveryFailed) {
    faults.push({
      key: "agents:completion_delivery_failed",
      summary: "child-agent completion delivery failed",
      minimumAgeMs: 0,
    });
  }
  return faults;
}

async function writeAtomic(filePath: string, state: OperationsState): Promise<void> {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    await rename(temporary, filePath);
    const directoryHandle = await open(directory, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function decodeState(value: unknown): OperationsState {
  if (!isObject(value) || value.version !== 1 || !isObject(value.faults)) {
    throw new Error("invalid Gateway operations state");
  }
  const faults: Record<string, PersistedFault> = {};
  for (const [key, raw] of Object.entries(value.faults)) {
    if (!isObject(raw) || typeof raw.active !== "boolean")
      throw new Error(`invalid operations fault: ${key}`);
    const firstObservedAt = iso(raw.firstObservedAt);
    const lastObservedAt = iso(raw.lastObservedAt);
    faults[key] = {
      active: raw.active,
      firstObservedAt,
      lastObservedAt,
      ...(raw.lastSentAt === undefined ? {} : { lastSentAt: iso(raw.lastSentAt) }),
      ...(raw.lastAttemptAt === undefined ? {} : { lastAttemptAt: iso(raw.lastAttemptAt) }),
      ...(raw.resolvedAt === undefined ? {} : { resolvedAt: iso(raw.resolvedAt) }),
    };
  }
  return { version: 1, faults };
}

function iso(value: unknown): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)))
    throw new Error("invalid operations timestamp");
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readErrorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
