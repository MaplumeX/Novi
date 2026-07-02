#!/usr/bin/env node
import { parseArgs } from "node:util";
import { bootstrap } from "./bootstrap.js";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { getSessionsDir } from "./config.js";
import { renderApp } from "./tui/App.js";
import { runPrint, runJson } from "./headless/run.js";
import { probeProviderConfigured, formatHeadlessGuidance } from "./onboarding.js";
import { renderOnboardingWizard } from "./tui/OnboardingWizard.js";

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
    help: { type: "boolean", short: "h", default: false },
  },
  allowPositionals: true,
  strict: true,
});

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

  try {
    const result = await bootstrap(bootstrapOptions);

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
