#!/usr/bin/env node
import { parseArgs } from "node:util";
import { bootstrap } from "./bootstrap.js";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { getSessionsDir } from "./config.js";
import { renderApp } from "./tui/App.js";
import { runPrint, runJson } from "./headless/run.js";
import { probeProviderConfigured, formatHeadlessGuidance } from "./onboarding.js";
import { renderOnboardingWizard } from "./tui/OnboardingWizard.js";
import { loadTrust, hasGatedResources, resolveProjectTrust, saveTrust } from "./trust.js";
import { loadSettings, resolveSettings } from "./settings.js";
import { renderTrustPrompt } from "./tui/TrustPrompt.js";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { loadCustomModels } from "./models-loader.js";
import { parseToolBudgetOverrides } from "./tools/runtime/budget.js";

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const { values, positionals } = parseArgs({
  options: {
    provider: { type: "string" },
    model: { type: "string" },
    thinking: { type: "string", short: "t" },
    cwd: { type: "string" },
    resume: { type: "string" },
    print: { type: "boolean", short: "p", default: false },
    mode: { type: "string" },
    approve: { type: "boolean", short: "a", default: false },
    "no-approve": { type: "boolean", default: false },
    yes: { type: "boolean", default: false },
    transport: { type: "string" },
    "steering-mode": { type: "string" },
    "follow-up-mode": { type: "string" },
    models: { type: "string" },
    "list-models": { type: "boolean", default: false },
    gateway: { type: "boolean", default: false },
    config: { type: "string" },
    json: { type: "boolean", default: false },
    kind: { type: "string" },
    "dry-run": { type: "boolean", default: false },
    recover: { type: "boolean", default: false },
    "environment-file": { type: "string" },
    replace: { type: "boolean", default: false },
    force: { type: "boolean", default: false },
    "no-enable": { type: "boolean", default: false },
    "no-start": { type: "boolean", default: false },
    linger: { type: "boolean", default: false },
    lines: { type: "string" },
    follow: { type: "boolean", default: false },
    "tool-budget": { type: "string", multiple: true },
    help: { type: "boolean", short: "h", default: false },
  },
  allowPositionals: true,
  strict: true,
});

// `--no-approve` has no short form: parseArgs only allows single-character
// shorts, and `-n` would collide with `-a` when combined as `-na` (parsed as
// both flags set, where approve wins per resolveProjectTrust priority — the
// opposite of what the user intended). Spell it out as `--no-approve`.

if (values.approve && values["no-approve"]) {
  fail("--approve and --no-approve are mutually exclusive");
}

if (values.help) {
  process.stdout.write(
    [
      "novi — minimal agent TUI",
      "",
      "Usage: novi [--provider <id>] [--model <id>] [--cwd <dir>] [--resume <session.jsonl>]",
      "",
      "Options:",
      "  --provider <id>   Provider id (default: anthropic)",
      "  --model <id>      Model id under the provider (default: claude-sonnet-4-5)",
      "  --thinking <lvl>  Thinking level: off|minimal|low|medium|high|xhigh",
      "  --cwd <dir>       Working directory (default: process.cwd())",
      "  --resume <path>   Resume an existing session JSONL file",
      "  -p, --print       Print mode: run once, print assistant text, exit (no TUI)",
      '  --mode <mode>     Headless mode: "json" streams all events as JSONL',
      "  -a, --approve     Trust project-local files for this run",
      "  --no-approve      Ignore project-local files for this run",
      "  --yes             Auto-approve tools that would ask (ask→allow). Not project trust.",
      "  --transport <t>   Provider transport: sse|websocket|websocket-cached|auto",
      "  --steering-mode <m>   Steering queue mode: one-at-a-time|all",
      "  --follow-up-mode <m>  Follow-up queue mode: one-at-a-time|all",
      "  --models <pats>   Comma-separated scoped-model patterns for Ctrl+P",
      "  --list-models [s] List configured models (optional search filter), then exit",
      "  --gateway         Multi-channel gateway mode (IM bot server; no TUI)",
      "  --config <path>   Path to gateway.json (gateway mode; default ~/.novi/gateway.json)",
      "  gateway agents list|get|cancel|retry [run-id]  Operate durable child runs",
      "  --json            Machine-readable gateway diagnostics/migration/service output",
      "  --kind <kind>     Gateway health check: live|ready",
      "  --dry-run         Inspect a gateway migration/rollback without writing",
      "  --recover         Recover an interrupted gateway migration",
      "  --environment-file <path>  Private EnvironmentFile for service install",
      "  --replace         Replace a changed Novi-owned service unit",
      "  --force           Force removal of a modified regular service unit",
      "  --no-enable       Install the service without enabling it",
      "  --no-start        Install the service without starting it",
      "  --linger          Enable user linger during service install",
      "  --lines <n>       Service log lines (1..10000; default 200)",
      "  --follow          Follow service logs",
      "  --tool-budget <name>=<n>  Override a tool resource budget (repeatable)",
      "  -h, --help        Show this help",
    ].join("\n") + "\n",
  );
  process.exit(0);
}

if (values.print && values.mode === "json") {
  fail("--print and --mode json are mutually exclusive");
}

const promptText = positionals.join(" ");
const gatewayAction = [
  "status",
  "probe",
  "health",
  "messages",
  "agents",
  "migrate",
  "rollback-state",
  "service",
].includes(positionals[0] ?? "")
  ? (positionals[0] as
      | "status"
      | "probe"
      | "health"
      | "messages"
      | "agents"
      | "migrate"
      | "rollback-state"
      | "service")
  : "run";
const requestedHealthKind = values.kind ?? positionals[1];
const gatewayHealthCheck =
  gatewayAction === "health" && (requestedHealthKind === "live" || requestedHealthKind === "ready")
    ? requestedHealthKind
    : undefined;
const requestedMessageAction = positionals[1] ?? "list";
const gatewayMessageAction =
  gatewayAction === "messages" &&
  ["list", "retry", "retry-delivery", "dismiss"].includes(requestedMessageAction)
    ? (requestedMessageAction as "list" | "retry" | "retry-delivery" | "dismiss")
    : undefined;
const requestedAgentAction = positionals[1] ?? "list";
const gatewayAgentAction =
  gatewayAction === "agents" && ["list", "get", "cancel", "retry"].includes(requestedAgentAction)
    ? (requestedAgentAction as "list" | "get" | "cancel" | "retry")
    : undefined;
const requestedServiceAction = positionals[1];
const gatewayServiceAction =
  gatewayAction === "service" &&
  [
    "install",
    "uninstall",
    "start",
    "stop",
    "restart",
    "enable",
    "disable",
    "status",
    "logs",
  ].includes(requestedServiceAction ?? "")
    ? (requestedServiceAction as
        | "install"
        | "uninstall"
        | "start"
        | "stop"
        | "restart"
        | "enable"
        | "disable"
        | "status"
        | "logs")
    : undefined;

if (values.gateway && gatewayAction === "health" && gatewayHealthCheck === undefined) {
  fail("gateway health requires: live or ready");
}
if (values.gateway && gatewayAction === "messages" && gatewayMessageAction === undefined) {
  fail("gateway messages requires: list, retry, retry-delivery, or dismiss");
}
if (values.gateway && gatewayAction === "agents" && gatewayAgentAction === undefined) {
  fail("gateway agents requires: list, get, cancel, or retry");
}
if (
  values.gateway &&
  gatewayAction === "agents" &&
  gatewayAgentAction !== "list" &&
  !positionals[2]
) {
  fail(`gateway agents ${gatewayAgentAction} requires an agent run id`);
}
if (
  values.gateway &&
  gatewayAction === "messages" &&
  gatewayMessageAction !== "list" &&
  !positionals[2]
) {
  fail(`gateway messages ${gatewayMessageAction} requires a message id`);
}
if (
  values.json &&
  (!values.gateway ||
    !["status", "health", "messages", "agents", "migrate", "rollback-state", "service"].includes(
      gatewayAction,
    ))
) {
  fail("--json is supported only for gateway diagnostics, migration, and service commands");
}
if (values.kind !== undefined && (!values.gateway || gatewayAction !== "health")) {
  fail("--kind is supported only for gateway health");
}
if (
  values["dry-run"] &&
  (!values.gateway || !["migrate", "rollback-state"].includes(gatewayAction))
) {
  fail("--dry-run is supported only for gateway migrate/rollback-state");
}
if (values.recover && (!values.gateway || gatewayAction !== "migrate")) {
  fail("--recover is supported only for gateway migrate");
}
if (values.recover && values["dry-run"]) fail("--recover and --dry-run are mutually exclusive");
if (values.gateway && gatewayAction === "rollback-state" && !positionals[1]) {
  fail("gateway rollback-state requires a backup id");
}
if (values.gateway && gatewayAction === "service" && gatewayServiceAction === undefined) {
  fail(
    "gateway service requires: install, uninstall, start, stop, restart, enable, disable, status, or logs",
  );
}
const serviceOnlyFlags = [
  values["environment-file"] !== undefined,
  values.replace,
  values.force,
  values["no-enable"],
  values["no-start"],
  values.linger,
  values.lines !== undefined,
  values.follow,
];
if (serviceOnlyFlags.some(Boolean) && (!values.gateway || gatewayAction !== "service")) {
  fail("service management flags require --gateway service");
}
if (values.lines !== undefined && !/^[0-9]+$/.test(values.lines)) {
  fail("--lines must be an integer");
}
if (
  gatewayAction === "service" &&
  [
    values["environment-file"] !== undefined,
    values.replace,
    values["no-enable"],
    values["no-start"],
    values.linger,
  ].some(Boolean) &&
  gatewayServiceAction !== "install"
) {
  fail("--environment-file/--replace/--no-enable/--no-start/--linger require service install");
}
if (gatewayAction === "service" && values.force && gatewayServiceAction !== "uninstall") {
  fail("--force requires service uninstall");
}
if (
  gatewayAction === "service" &&
  (values.lines !== undefined || values.follow) &&
  gatewayServiceAction !== "logs"
) {
  fail("--lines/--follow require service logs");
}

const isHeadless =
  values.print || values.mode === "json" || values["list-models"] || values.gateway;

const cliOverrides = {
  provider: values.provider,
  model: values.model,
  thinkingLevel: values.thinking as
    "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | undefined,
  transport: values.transport as "sse" | "websocket" | "websocket-cached" | "auto" | undefined,
  steeringMode: values["steering-mode"] as "one-at-a-time" | "all" | undefined,
  followUpMode: values["follow-up-mode"] as "one-at-a-time" | "all" | undefined,
  scopedModels: values.models
    ? values.models
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    : undefined,
};

let toolBudgetOverrides;
try {
  toolBudgetOverrides = parseToolBudgetOverrides(values["tool-budget"] ?? []);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

const bootstrapOptions = {
  cwd: values.cwd,
  ...cliOverrides,
  resumePath: values.resume,
  yes: values.yes === true,
  toolMode: (values.gateway
    ? "gateway"
    : values.print
      ? "print"
      : values.mode === "json"
        ? "json"
        : "tui") as "tui" | "print" | "json" | "gateway",
  toolBudgetOverrides,
};

// Pre-bootstrap credential probe. The check runs before bootstrap() so the
// TUI onboarding wizard can run before the harness is constructed (it writes
// credentials/settings, then bootstrap() loads them). Headless mode never
// starts an interactive wizard — it prints guidance and exits.
async function main(): Promise<void> {
  // --- --list-models [search]: print configured models and exit ---
  // Lightweight: env + creds + settings + custom providers, no session/harness.
  if (values["list-models"]) {
    const search = promptText.toLowerCase();
    const cwd = values.cwd ?? process.cwd();
    const env = new NodeExecutionEnv({ cwd, shellEnv: process.env });
    try {
      // creds + settings, project layer gated conservatively (ask→never).
      const { loadCredentials, injectCredentialsIntoEnv } = await import("./credentials.js");
      const creds = await loadCredentials(env);
      injectCredentialsIntoEnv(creds, process.env);
      const trustDb = await loadTrust(env);
      const decision = resolveProjectTrust(cwd, trustDb, { isHeadless: true });
      const settingsLoad = await loadSettings(env, cwd, { includeProject: decision === "always" });
      for (const d of settingsLoad.diagnostics) process.stderr.write(`warning: ${d}\n`);
      const models = builtinModels();
      const custom = await loadCustomModels(env, cwd, { includeProject: decision === "always" });
      for (const d of custom.diagnostics) process.stderr.write(`warning: ${d}\n`);
      for (const p of custom.providers) models.setProvider(p);
      // Only list models from configured providers (getAuth resolves without
      // a network call), mirroring the /model command's filtering.
      const lines: string[] = [];
      for (const provider of models.getProviders()) {
        const providerModels = models.getModels(provider.id);
        if (providerModels.length === 0) continue;
        const auth = await models.getAuth(providerModels[0]!);
        if (!auth) continue;
        for (const m of providerModels) {
          const label = `${provider.id}/${m.id}  ${m.name}`;
          if (search && !label.toLowerCase().includes(search)) continue;
          lines.push(label);
        }
      }
      process.stdout.write(lines.join("\n") + (lines.length > 0 ? "\n" : ""));
    } finally {
      await env.cleanup();
    }
    process.exit(0);
  }

  if (!(values.gateway && gatewayAction !== "run"))
    try {
      const probeEnv = new NodeExecutionEnv({ cwd: process.cwd(), shellEnv: process.env });
      let probeResult;
      try {
        probeResult = await probeProviderConfigured(probeEnv, cliOverrides);
      } finally {
        await probeEnv.cleanup();
      }

      if (!probeResult.configured) {
        if (isHeadless) {
          fail(formatHeadlessGuidance(probeResult.provider));
        }
        // TUI mode: run the onboarding wizard, which on completion bootstraps
        // and renders the app itself.
        await renderOnboardingWizard(bootstrapOptions);
        return;
      }
    } catch (error) {
      // Probe failure (e.g. corrupt settings) is non-fatal here — let bootstrap()
      // surface the real error via its own resolveModel() guard.
      process.stderr.write(
        `warning: provider check failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }

  // --- Project trust gate ---
  // Resolve trust for the cwd. Only prompt when gated resources exist, the
  // decision is unresolved ("ask"), and we're in TUI mode. Headless modes
  // resolve "ask" → "never" (don't load project resources, don't prompt).
  const cwd = values.cwd ?? process.cwd();
  let trusted = true;
  if (!(values.gateway && gatewayAction !== "run")) {
    const trustEnv = new NodeExecutionEnv({ cwd, shellEnv: process.env });
    try {
      const trustDb = await loadTrust(trustEnv);
      const gated = await hasGatedResources(trustEnv, cwd);
      if (gated) {
        // Read global settings for defaultProjectTrust (project layer excluded:
        // it's gated). `includeProject: false` is conservative but trust.json
        // and defaultProjectTrust are global-only anyway.
        const settingsLoad = await loadSettings(trustEnv, cwd, { includeProject: false });
        const resolved = resolveSettings(settingsLoad.merged, settingsLoad.layers, cliOverrides);
        const decision = resolveProjectTrust(cwd, trustDb, {
          approve: values.approve,
          noApprove: values["no-approve"],
          defaultProjectTrust: resolved.defaultProjectTrust,
          isHeadless,
        });

        if (decision === "ask" && !isHeadless) {
          // TUI: show the trust prompt overlay before bootstrap.
          const choice = await renderTrustPrompt(cwd);
          if (choice === "abort") {
            process.exit(0);
          }
          // Persist always/never (mirrors pi: write to trust.json, no reload).
          if (choice === "always" || choice === "never") {
            await saveTrust(trustEnv, cwd, choice);
          }
          trusted = choice === "always" || choice === "once";
        } else {
          // Resolved decision (always/never) or headless ask→never.
          trusted = decision === "always";
        }
      }
    } catch (error) {
      // Trust resolution failure is non-fatal: default to trusted=false only
      // would be too disruptive; instead default to trusted (current behavior)
      // and warn.
      process.stderr.write(
        `warning: trust resolution failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    } finally {
      await trustEnv.cleanup();
    }
  }

  try {
    if (values.gateway) {
      const { runGateway } = await import("./gateway/run.js");
      await runGateway({
        ...bootstrapOptions,
        trusted,
        configPath: values.config,
        action: gatewayAction,
        json: values.json,
        healthCheck: gatewayHealthCheck,
        messageAction: gatewayMessageAction,
        messageId: positionals[2],
        agentAction: gatewayAgentAction,
        agentRunId: positionals[2],
        dryRun: values["dry-run"],
        recover: values.recover,
        backupId: gatewayAction === "rollback-state" ? positionals[1] : undefined,
        serviceAction: gatewayServiceAction,
        environmentFile: values["environment-file"],
        replace: values.replace,
        force: values.force,
        noEnable: values["no-enable"],
        noStart: values["no-start"],
        linger: values.linger,
        lines: values.lines === undefined ? undefined : Number(values.lines),
        follow: values.follow,
      });
      return;
    }

    // TUI path: interactive Approver. Headless (print/json) stays fail-closed.
    let tuiApprover: import("./permissions/index.js").TuiApprover | undefined;
    if (!values.print && values.mode !== "json") {
      const { TuiApprover } = await import("./permissions/index.js");
      tuiApprover = new TuiApprover();
    }

    const result = await bootstrap({
      ...bootstrapOptions,
      trusted,
      approver: tuiApprover,
    });

    if (values.print) {
      await runPrint({ result, prompt: promptText });
    } else if (values.mode === "json") {
      await runJson({ result, prompt: promptText });
    } else {
      renderApp(result, getSessionsDir(), tuiApprover);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(`Novi: ${message}`);
  }
}

await main();
