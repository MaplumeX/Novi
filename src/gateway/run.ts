import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { createHash, randomUUID } from "node:crypto";
import type { BootstrapOptions } from "../bootstrap.js";
import { prepareGatewayEnv } from "../bootstrap.js";
import { probeProviderConfigured, formatHeadlessGuidance } from "../onboarding.js";
import { loadTrust, resolveProjectTrust, hasGatedResources } from "../trust.js";
import { loadSettings, resolveSettings } from "../settings.js";
import { loadGatewayConfig } from "./config.js";
import { createChannels } from "./channels/index.js";
import { NoviAgentAdapter } from "./agent/novi-agent-adapter.js";
import { GatewaySessionStore } from "./core/session-store.js";
import { GatewaySessionManager } from "./core/session-manager.js";
import { GatewayApp } from "./core/gateway-app.js";
import { createCommandRegistry } from "./core/commands.js";
import { JobStore } from "./jobs/store.js";
import { JobService } from "./jobs/service.js";
import { AutomationAgentRunner } from "./jobs/agent-runner.js";
import { DeliveryService } from "./jobs/delivery.js";
import { GatewayScheduler } from "./jobs/scheduler.js";
import { localDayKey } from "./jobs/schedule.js";
import { HeartbeatService } from "./jobs/heartbeat.js";
import { ChannelDeliveryExecutor } from "./messages/delivery.js";
import { DeliveryRateLimiter } from "./messages/rate-limit.js";
import { GatewayMessageStore } from "./messages/store.js";
import { resolveGatewayRuntimePaths } from "./runtime/paths.js";
import { requestGatewayControl } from "./runtime/control-client.js";
import { GatewayControlServer } from "./runtime/control-server.js";
import { GatewayRuntimeMonitor, type GatewayRuntimeSnapshot } from "./runtime/snapshot.js";
import {
  formatGatewayStatus,
  gatewayStatusExitCode,
  stoppedGatewaySnapshot,
} from "./runtime/format.js";
import { GatewayLogger } from "./runtime/logger.js";
import { GatewayMetrics } from "./runtime/metrics.js";
import { GatewayAlertManager, GatewayOperationsStore } from "./runtime/alerts.js";
import { getNoviDir } from "../config.js";
import path from "node:path";
import { createGatewayStateRegistry } from "./migrations/registry.js";
import { assertGatewayStateReady } from "./migrations/inspect.js";
import { GatewayMigrationService } from "./migrations/service.js";
import { formatGatewayMigrationResult } from "./migrations/format.js";
import { runGatewayService } from "./service/manager.js";
import type { GatewayServiceAction } from "./service/types.js";
import {
  createMessageControlMethods,
  formatMessageSummaries,
  type MessageRecordSummary,
} from "./runtime/operator-methods.js";

/** Options for `runGateway`, mirroring the relevant CLI flags. */
export interface RunGatewayOptions extends BootstrapOptions {
  /** Explicit `--config <path>` for gateway.json (optional). */
  configPath?: string;
  action?:
    "run" | "status" | "probe" | "health" | "messages" | "migrate" | "rollback-state" | "service";
  json?: boolean;
  healthCheck?: "live" | "ready";
  messageAction?: "list" | "retry" | "retry-delivery" | "dismiss";
  messageId?: string;
  dryRun?: boolean;
  recover?: boolean;
  backupId?: string;
  serviceAction?: GatewayServiceAction;
  environmentFile?: string;
  replace?: boolean;
  force?: boolean;
  noEnable?: boolean;
  noStart?: boolean;
  linger?: boolean;
  lines?: number;
  follow?: boolean;
}

function failGateway(logger: GatewayLogger, event: string, message: string): never {
  logger.error(event, new Error(message));
  process.exit(1);
}

/**
 * Gateway entry point (`novi --gateway`).
 *
 * Reuses the same provider-probe + trust resolution as headless modes
 * (ask→never, no onboarding wizard). Loads gateway.json, builds channels, and
 * starts the {@link GatewayApp}. The process stays alive while channel
 * polling loops keep the event loop busy; SIGINT/SIGTERM trigger graceful
 * shutdown.
 */
export async function runGateway(options: RunGatewayOptions): Promise<void> {
  const cwd = options.cwd ?? process.cwd();

  if (options.action === "service") {
    if (!options.serviceAction) throw new Error("gateway service action is required");
    await runGatewayService({
      action: options.serviceAction,
      cwd,
      configPath: options.configPath,
      environmentFile: options.environmentFile,
      replace: options.replace,
      force: options.force,
      noEnable: options.noEnable,
      noStart: options.noStart,
      linger: options.linger,
      lines: options.lines,
      follow: options.follow,
      json: options.json,
    });
    return;
  }

  if (options.action === "migrate" || options.action === "rollback-state") {
    await runStateMigration(options, cwd);
    return;
  }

  // Runtime diagnostics use only the private control socket: no config,
  // provider, model, channel, or harness is constructed.
  if (options.action === "status" || options.action === "health" || options.action === "messages") {
    await runRuntimeDiagnostic(options);
    return;
  }

  // Probe intentionally loads only gateway configuration and contacts each
  // configured channel without depending on a running daemon.
  if (options.action === "probe") {
    const env = new NodeExecutionEnv({ cwd, shellEnv: process.env });
    try {
      const { config, warnings } = await loadGatewayConfig(env, {
        filePath: options.configPath,
        cwd,
        trusted: options.trusted,
      });
      for (const warning of warnings) process.stderr.write(`warning: ${warning}\n`);
      const channels = createChannels(config.channels, {
        editIntervalMs: config.stream.editIntervalMs,
      });
      for (const channel of channels) {
        const result = await (
          channel.probe
            ? channel.probe()
            : Promise.resolve({ ok: true, detail: "probe unsupported" })
        ).catch((e) => ({ ok: false, detail: e instanceof Error ? e.message : String(e) }));
        process.stdout.write(
          `${channel.id} (${channel.type}): ${result.ok ? "ok" : "failed"}${result.detail ? ` — ${result.detail}` : ""}\n`,
        );
      }
    } finally {
      await env.cleanup();
    }
    return;
  }

  // Daemon startup is read-only and fail-fast until every owned schema is current.
  const noviDir = getNoviDir();
  const registry = await createGatewayStateRegistry({
    noviDir,
    cwd,
    configPath: options.configPath,
  });
  await assertGatewayStateReady(registry, path.join(noviDir, "migrations", "active.json"));

  const instanceId = randomUUID();
  const logger = new GatewayLogger({ instanceId });
  const metrics = new GatewayMetrics();

  // 1. Provider probe — fail with guidance when unconfigured (headless path).
  const probeEnv = new NodeExecutionEnv({ cwd, shellEnv: process.env });
  let probeResult;
  try {
    probeResult = await probeProviderConfigured(probeEnv, {
      provider: options.provider,
      model: options.model,
      thinkingLevel: options.thinkingLevel,
      transport: undefined,
      steeringMode: undefined,
      followUpMode: undefined,
      scopedModels: undefined,
    });
  } finally {
    await probeEnv.cleanup();
  }
  if (!probeResult.configured) {
    failGateway(
      logger,
      "gateway.provider.unconfigured",
      formatHeadlessGuidance(probeResult.provider),
    );
  }

  // 2. Trust resolution — headless rule: "ask" → "never".
  // Only resolve trust when gated resources exist; otherwise default to
  // trusted (mirrors the cli.ts main path). When gated, read the global
  // `defaultProjectTrust` so a persisted global "always" is honored.
  const trustEnv = new NodeExecutionEnv({ cwd, shellEnv: process.env });
  let trusted = true;
  try {
    const gated = await hasGatedResources(trustEnv, cwd);
    if (gated) {
      const trustDb = await loadTrust(trustEnv);
      // Read global settings (project excluded: it's gated) for the default.
      const settingsLoad = await loadSettings(trustEnv, cwd, { includeProject: false });
      const resolved = resolveSettings(settingsLoad.merged, settingsLoad.layers, {
        provider: options.provider,
        model: options.model,
        thinkingLevel: options.thinkingLevel,
      });
      const decision = resolveProjectTrust(cwd, trustDb, {
        isHeadless: true,
        defaultProjectTrust: resolved.defaultProjectTrust,
      });
      trusted = decision === "always";
    }
  } catch (error) {
    logger.error("gateway.trust_resolution_failed", error);
  } finally {
    await trustEnv.cleanup();
  }

  // 3. One-time env preparation (env / credentials / settings / models / ...).
  const gatewayEnv = await prepareGatewayEnv({
    ...options,
    trusted,
    toolMode: "gateway",
  });

  // 4. Load gateway.json (user + project layers, project gated by trust).
  const { config, warnings } = await loadGatewayConfig(gatewayEnv.env, {
    filePath: options.configPath,
    cwd,
    trusted,
  });
  for (const warning of warnings) logger.warn("gateway.config.warning", { detail: warning });
  if (config.channels.length === 0) {
    failGateway(
      logger,
      "gateway.config.no_channels",
      "no channels configured — nothing to listen on. Edit ~/.novi/gateway.json",
    );
  }

  // 5. Build channels + adapter + session manager.
  const channels = createChannels(config.channels, {
    editIntervalMs: config.stream.editIntervalMs,
    logger,
  });
  const sessionStore = await GatewaySessionStore.open();
  const messageStore = await GatewayMessageStore.open();
  const operationsStore = await GatewayOperationsStore.open();
  const jobStore = await JobStore.open(
    undefined,
    localDayKey(new Date(), config.automation.timezone),
  );
  const jobService = new JobService(jobStore, sessionStore, config, gatewayEnv.models);
  const schedulerRef: { current?: GatewayScheduler } = {};
  const wakeScheduler = () => schedulerRef.current?.kick();
  const agent = new NoviAgentAdapter(
    gatewayEnv,
    sessionStore,
    undefined,
    jobService,
    wakeScheduler,
    logger,
  );
  const sessionManager = new GatewaySessionManager({
    agent,
    idleTimeoutMs: config.session.idleTimeoutMs,
    maxConcurrentSessions: config.session.maxConcurrent,
    queueMode: config.queue.mode,
    metrics,
  });
  const commands = createCommandRegistry({ jobService, onJobsMutated: wakeScheduler });
  const runner = new AutomationAgentRunner(gatewayEnv, jobStore, config);
  const deliveryExecutor = new ChannelDeliveryExecutor(
    new DeliveryRateLimiter(config.delivery.rateLimit),
  );
  const delivery = new DeliveryService(
    channels,
    jobStore,
    sessionStore,
    sessionManager,
    agent,
    undefined,
    deliveryExecutor,
  );
  const heartbeat = new HeartbeatService(gatewayEnv, jobStore, runner, delivery, config);
  const scheduler = new GatewayScheduler(jobStore, runner, delivery, config, undefined, heartbeat);
  schedulerRef.current = scheduler;

  // 6. Start the gateway app.
  const app = new GatewayApp({
    channels,
    agent,
    sessionManager,
    queueMode: config.queue.mode,
    queueModeByChannel: config.queue.byChannel,
    config,
    commands,
    gatewayEnv,
    schedulerStats: () => runtimeSchedulerStats(scheduler),
    messageStore,
    deliveryExecutor,
    logger,
    metrics,
  });
  const operator = app.messageOperator();
  if (!operator) throw new Error("Gateway message operator is unavailable");
  const alertManager = new GatewayAlertManager({
    target: config.operations.alertTarget,
    cooldownMs: config.operations.alertCooldownMs,
    backlogRecords: config.operations.backlogRecords,
    backlogAgeMs: config.operations.backlogAgeMs,
    channelDownMs: config.operations.channelDownMs,
    store: operationsStore,
    validateTarget: (target) => app.validateOperationTarget(target, sessionStore),
    enqueue: (target, sourceId, text) => app.enqueueOperationAlert(target, sourceId, text),
    metrics,
    logger,
  });
  const runtime = new GatewayRuntimeMonitor({
    components: () => app.runtimeComponents(),
    schedulerStats: () => runtimeSchedulerStats(scheduler),
    instanceId,
    cwd,
    configDigest: gatewayConfigDigest(config),
    metrics: (components) =>
      metrics.snapshot({
        queueDepth:
          components.sessions.queuedMessages + (components.messages?.nonTerminalRecords ?? 0),
        oldestPendingAgeMs: components.messages?.oldestPendingAgeMs ?? 0,
        readyChannels: components.channels.filter((channel) => channel.state === "ready").length,
        failedChannels: components.channels.filter((channel) => channel.state === "failed").length,
      }),
    degradationReasons: () => alertManager.getDegradedReasons(),
  });
  const control = new GatewayControlServer({
    paths: resolveGatewayRuntimePaths(),
    methods: {
      "status.get": () => runtime.snapshot(),
      "health.live": async () => {
        const snapshot = await runtime.snapshot();
        return { ok: snapshot.health.live, state: snapshot.state };
      },
      "health.ready": async () => {
        const snapshot = await runtime.snapshot();
        return { ok: snapshot.health.ready, state: snapshot.state };
      },
      ...createMessageControlMethods(operator, logger),
    },
  });
  let alertTimer: ReturnType<typeof setInterval> | undefined;

  try {
    await scheduler.prepare();
    await control.start();
    await app.start();
    await scheduler.start();
    runtime.markRunning();
    logger.info("gateway.runtime.ready");
    const observeAlerts = () =>
      runtime
        .snapshot()
        .then((snapshot) => alertManager.observe(snapshot))
        .catch((error) => logger.error("gateway.alert.observe_failed", error));
    void observeAlerts();
    alertTimer = setInterval(observeAlerts, 30_000);
    alertTimer.unref();
  } catch (error) {
    await stopGatewayRuntime(scheduler, app, control).catch(() => undefined);
    throw error;
  }

  const reload = () => {
    void loadGatewayConfig(gatewayEnv.env, { filePath: options.configPath, cwd, trusted })
      .then(({ config: next, warnings: reloadWarnings }) => {
        // Warnings mean the candidate was recovered from invalid input; keep
        // the known-good runtime snapshot instead of partially applying it.
        if (reloadWarnings.length > 0) {
          logger.warn("gateway.reload.rejected", { reasons: reloadWarnings });
          return;
        }
        if (!app.reloadPolicy(next)) {
          logger.warn("gateway.reload.restart_required");
          return;
        }
        logger.info("gateway.reload.applied");
      })
      .catch((e) => logger.error("gateway.reload.failed", e));
  };
  process.on("SIGHUP", reload);

  // 7. Graceful shutdown on SIGINT/SIGTERM.
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    runtime.markStopping();
    if (alertTimer) clearInterval(alertTimer);
    logger.info("gateway.runtime.stopping");
    void stopGatewayRuntime(scheduler, app, control)
      .catch((e) => logger.error("gateway.runtime.stop_failed", e))
      .finally(() => {
        process.off("SIGHUP", reload);
        process.exit(0);
      });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

async function runStateMigration(options: RunGatewayOptions, cwd: string): Promise<void> {
  const noviDir = getNoviDir();
  const registry = await createGatewayStateRegistry({
    noviDir,
    cwd,
    configPath: options.configPath,
  });
  const jobsRoot = registry.find((entry) => entry.schema === "jobs")?.path;
  if (!jobsRoot) throw new Error("Gateway jobs state is not registered");
  const service = new GatewayMigrationService({
    registry,
    backupsRoot: path.join(noviDir, "backups", "gateway"),
    journalPath: path.join(noviDir, "migrations", "active.json"),
    runtimePaths: resolveGatewayRuntimePaths(process.env, noviDir),
    jobsRoot,
    cwd,
  });
  let result;
  if (options.action === "migrate") {
    result = options.recover ? await service.recover() : await service.migrate(options.dryRun);
  } else {
    if (!options.backupId) throw new Error("gateway rollback-state requires a backup id");
    result = await service.rollback(options.backupId, options.dryRun);
  }
  process.stdout.write(formatGatewayMigrationResult(result, options.json === true));
}

function gatewayConfigDigest(
  config: Awaited<ReturnType<typeof loadGatewayConfig>>["config"],
): string {
  const safe = {
    channels: config.channels.map(({ id, type }) => ({ id, type })),
    queue: config.queue,
    stream: config.stream,
    session: config.session,
    security: {
      dmPolicy: config.security.dmPolicy,
      groupPolicy: config.security.groupPolicy,
      pairing: config.security.pairing,
    },
    delivery: config.delivery,
    automation: config.automation,
    heartbeat: config.heartbeat,
    operations: config.operations,
  };
  return createHash("sha256").update(JSON.stringify(safe)).digest("hex").slice(0, 16);
}

async function runtimeSchedulerStats(scheduler: GatewayScheduler) {
  const failure = scheduler.getFailure();
  if (failure) throw failure;
  return scheduler.getStats();
}

async function stopGatewayRuntime(
  scheduler: GatewayScheduler,
  app: GatewayApp,
  control: GatewayControlServer,
): Promise<void> {
  let failure: unknown;
  for (const stop of [() => scheduler.stop(), () => app.stop(), () => control.stop()]) {
    try {
      await stop();
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure !== undefined) throw failure;
}

async function runRuntimeDiagnostic(options: RunGatewayOptions): Promise<void> {
  const paths = resolveGatewayRuntimePaths();
  if (options.action === "messages") {
    const action = options.messageAction ?? "list";
    const method = action === "retry-delivery" ? "messages.retryDelivery" : `messages.${action}`;
    const params = action === "list" ? { limit: 20 } : { id: options.messageId };
    try {
      const response = await requestGatewayControl(
        { socketPath: paths.socketPath },
        { id: `messages-${process.pid}`, method, params },
      );
      if (!response.ok) {
        process.stderr.write(`Novi: ${response.error.message}\n`);
        process.exitCode = 1;
        return;
      }
      if (options.json) {
        process.stdout.write(
          `${JSON.stringify({ version: 1, action, ...asObject(response.result) })}\n`,
        );
      } else if (action === "list") {
        process.stdout.write(
          formatMessageSummaries(
            (asObject(response.result).records ?? []) as MessageRecordSummary[],
          ),
        );
      } else {
        process.stdout.write(
          formatMessageSummaries([asObject(response.result).record as MessageRecordSummary]),
        );
      }
      process.exitCode = 0;
    } catch {
      process.stderr.write("Novi: Gateway is stopped\n");
      process.exitCode = 1;
    }
    return;
  }
  if (options.action === "health") {
    const check = options.healthCheck ?? "ready";
    try {
      const response = await requestGatewayControl(
        { socketPath: paths.socketPath },
        { id: `health-${process.pid}`, method: `health.${check}` },
      );
      if (!response.ok) throw new Error(response.error.message);
      const result = response.result as { ok?: unknown; state?: unknown };
      const ok = result.ok === true;
      const state = typeof result.state === "string" ? result.state : "unknown";
      process.stdout.write(
        options.json
          ? `${JSON.stringify({ version: 1, check, ok, state })}\n`
          : `${check}: ${ok ? "ok" : "failed"} (${state})\n`,
      );
      process.exitCode = ok ? 0 : 1;
    } catch {
      const result = { version: 1, check, ok: false, state: "stopped" };
      process.stdout.write(
        options.json ? `${JSON.stringify(result)}\n` : `${check}: failed (stopped)\n`,
      );
      process.exitCode = 1;
    }
    return;
  }

  let snapshot: GatewayRuntimeSnapshot | ReturnType<typeof stoppedGatewaySnapshot>;
  try {
    const response = await requestGatewayControl(
      { socketPath: paths.socketPath },
      { id: `status-${process.pid}`, method: "status.get" },
    );
    if (!response.ok) throw new Error(response.error.message);
    snapshot = response.result as GatewayRuntimeSnapshot;
  } catch {
    snapshot = stoppedGatewaySnapshot();
  }
  process.stdout.write(
    options.json ? `${JSON.stringify(snapshot)}\n` : formatGatewayStatus(snapshot),
  );
  process.exitCode = gatewayStatusExitCode(snapshot.state);
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
