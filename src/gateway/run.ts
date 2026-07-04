import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { BootstrapOptions } from "../bootstrap.js";
import { prepareGatewayEnv } from "../bootstrap.js";
import { probeProviderConfigured, formatHeadlessGuidance } from "../onboarding.js";
import { loadTrust, resolveProjectTrust, hasGatedResources } from "../trust.js";
import { loadSettings, resolveSettings } from "../settings.js";
import { loadGatewayConfig } from "./config.js";
import { createChannels } from "./channels/index.js";
import { NoviAgentAdapter } from "./agent/novi-agent-adapter.js";
import { GatewaySessionManager } from "./core/session-manager.js";
import { GatewayApp } from "./core/gateway-app.js";
import { createCommandRegistry } from "./core/commands.js";

/** Options for `runGateway`, mirroring the relevant CLI flags. */
export interface RunGatewayOptions extends BootstrapOptions {
  /** Explicit `--config <path>` for gateway.json (optional). */
  configPath?: string;
}

function fail(message: string): never {
  process.stderr.write(`Novi: ${message}\n`);
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
    fail(formatHeadlessGuidance(probeResult.provider));
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
    process.stderr.write(
      `warning: trust resolution failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  } finally {
    await trustEnv.cleanup();
  }

  // 3. One-time env preparation (env / credentials / settings / models / ...).
  const gatewayEnv = await prepareGatewayEnv({ ...options, trusted });

  // 4. Load gateway.json (user + project layers, project gated by trust).
  const { config, warnings } = await loadGatewayConfig(gatewayEnv.env, {
    filePath: options.configPath,
    cwd,
    trusted,
  });
  for (const warning of warnings) {
    process.stderr.write(`warning: ${warning}\n`);
  }
  if (config.channels.length === 0) {
    fail("no channels configured — nothing to listen on. Edit ~/.novi/gateway.json");
  }

  // 5. Build channels + adapter + session manager.
  const channels = createChannels(config.channels, {
    editIntervalMs: config.stream.editIntervalMs,
  });
  const agent = new NoviAgentAdapter(gatewayEnv);
  const sessionManager = new GatewaySessionManager({
    agent,
    idleTimeoutMs: config.session.idleTimeoutMs,
    maxConcurrentSessions: config.session.maxConcurrent,
    queueMode: config.queue.mode,
  });
  const commands = createCommandRegistry();

  // 6. Start the gateway app.
  const app = new GatewayApp({
    channels,
    agent,
    sessionManager,
    queueMode: config.queue.mode,
    queueModeByChannel: config.queue.byChannel,
    allowlist: config.security.allowlist,
    commands,
    gatewayEnv,
  });

  await app.start();

  // 7. Graceful shutdown on SIGINT/SIGTERM.
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void app
      .stop()
      .catch((e) => {
        process.stderr.write(
          `warning: gateway shutdown error: ${e instanceof Error ? e.message : String(e)}\n`,
        );
      })
      .finally(() => {
        process.exit(0);
      });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
