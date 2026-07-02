#!/usr/bin/env node
import { parseArgs } from "node:util";
import { bootstrap } from "./bootstrap.js";
import { getSessionsDir } from "./config.js";
import { renderApp } from "./tui/App.js";
import { runPrint, runJson } from "./headless/run.js";

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

try {
  const result = await bootstrap({
    cwd: values.cwd,
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
    resumePath: values.resume,
  });

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
