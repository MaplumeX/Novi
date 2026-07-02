#!/usr/bin/env node
import { parseArgs } from "node:util";
import { bootstrap } from "./bootstrap.js";
import { getSessionsDir } from "./config.js";
import { renderApp } from "./tui/App.js";

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const { values } = parseArgs({
  options: {
    provider: { type: "string" },
    model: { type: "string" },
    thinking: { type: "string", short: "t" },
    cwd: { type: "string" },
    resume: { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
  allowPositionals: false,
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
      "  -h, --help        Show this help",
    ].join("\n") + "\n",
  );
  process.exit(0);
}

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
  renderApp(result, getSessionsDir());
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  fail(`Novi: ${message}`);
}
