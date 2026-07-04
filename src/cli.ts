#!/usr/bin/env node
import { parseArgs } from "node:util";
import { bootstrap } from "./bootstrap.js";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { getSessionsDir } from "./config.js";
import { renderApp } from "./tui/App.js";
import { runPrint, runJson } from "./headless/run.js";
import { probeProviderConfigured, formatHeadlessGuidance } from "./onboarding.js";
import { renderOnboardingWizard } from "./tui/OnboardingWizard.js";
import {
  loadTrust,
  hasGatedResources,
  resolveProjectTrust,
  saveTrust,
} from "./trust.js";
import { loadSettings, resolveSettings } from "./settings.js";
import { renderTrustPrompt } from "./tui/TrustPrompt.js";

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
      "  --mode <mode>     Headless mode: \"json\" streams all events as JSONL",
      "  -a, --approve     Trust project-local files for this run",
      "  --no-approve      Ignore project-local files for this run",
      "  -h, --help        Show this help",
    ].join("\n") + "\n",
  );
  process.exit(0);
}

if (values.print && values.mode === "json") {
  fail("--print and --mode json are mutually exclusive");
}

const promptText = positionals.join(" ");

const isHeadless = values.print || values.mode === "json";

const cliOverrides = {
  provider: values.provider,
  model: values.model,
  thinkingLevel: values.thinking as
    | "off"
    | "minimal"
    | "low"
    | "medium"
    | "high"
    | "xhigh"
    | undefined,
};

const bootstrapOptions = {
  cwd: values.cwd,
  ...cliOverrides,
  resumePath: values.resume,
};

// Pre-bootstrap credential probe. The check runs before bootstrap() so the
// TUI onboarding wizard can run before the harness is constructed (it writes
// credentials/settings, then bootstrap() loads them). Headless mode never
// starts an interactive wizard — it prints guidance and exits.
async function main(): Promise<void> {
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
  const trustEnv = new NodeExecutionEnv({ cwd, shellEnv: process.env });
  let trusted = true;
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

  try {
    const result = await bootstrap({ ...bootstrapOptions, trusted });

    if (values.print) {
      await runPrint({ result, prompt: promptText });
    } else if (values.mode === "json") {
      await runJson({ result, prompt: promptText });
    } else {
      renderApp(result, getSessionsDir());
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(`Novi: ${message}`);
  }
}

await main();
