import { promises as fs } from "node:fs";
import path from "node:path";
import type { AgentHarness, ThinkingLevel } from "@earendil-works/pi-agent-core/node";
import type { Models } from "@earendil-works/pi-ai";

export interface ParsedCommand {
  name: string;
  args: string;
}

/**
 * Parse a `/name rest...` input line into a command name and the remainder.
 *
 * Pure function (no harness access) so it can be unit-tested in isolation:
 *   parseCommand("/model anthropic/claude-x")
 *     → { name: "model", args: "anthropic/claude-x" }
 */
export function parseCommand(line: string): ParsedCommand {
  const trimmed = line.trim().replace(/^\/+/, "").trim();
  if (!trimmed) return { name: "", args: "" };
  const spaceIdx = trimmed.search(/\s/);
  if (spaceIdx === -1) return { name: trimmed, args: "" };
  return {
    name: trimmed.slice(0, spaceIdx),
    args: trimmed.slice(spaceIdx + 1).trim(),
  };
}

export interface CommandContext {
  harness: AgentHarness;
  models: Models;
  sessionsDir: string;
  /** Whether the harness is idle (true) mid-turn (false). */
  isIdle: boolean;
  /** Request the Ink app to exit cleanly. */
  exit: () => void;
  /** Emit a (possibly multi-line) notice line into the TUI output area. */
  print: (text: string) => void;
}

export interface Command {
  name: string;
  description: string;
  run: (ctx: CommandContext, args: string) => Promise<void>;
}

const THINKING_LEVELS: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

async function listSessionFiles(sessionsDir: string): Promise<Array<{ name: string; mtime: Date }>> {
  let entries: string[];
  try {
    entries = await fs.readdir(sessionsDir);
  } catch {
    return [];
  }
  const files: Array<{ name: string; mtime: Date }> = [];
  for (const entry of entries) {
    const fullPath = path.join(sessionsDir, entry);
    let stat;
    try {
      stat = await fs.stat(fullPath);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      // Session files live one level below the root (per-cwd subdirectories).
      let nested: string[];
      try {
        nested = await fs.readdir(fullPath);
      } catch {
        continue;
      }
      for (const n of nested) {
        if (!n.endsWith(".jsonl")) continue;
        const np = path.join(fullPath, n);
        try {
          const ns = await fs.stat(np);
          files.push({ name: `${path.basename(entry)}/${n}`, mtime: ns.mtime });
        } catch {
          // skip unreadable entries
        }
      }
    } else if (entry.endsWith(".jsonl")) {
      files.push({ name: entry, mtime: stat.mtime });
    }
  }
  files.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  return files.slice(0, 20);
}

/** Command registry, ordered for `/help` display. */
export const COMMANDS: readonly Command[] = [
  {
    name: "help",
    description: "List available commands",
    run: async (ctx) => {
      const lines = COMMANDS.map((c) => `  /${c.name} — ${c.description}`);
      ctx.print(["Commands:", ...lines].join("\n"));
    },
  },
  {
    name: "quit",
    description: "Exit Novi",
    run: async (ctx) => {
      ctx.exit();
    },
  },
  {
    name: "abort",
    description: "Abort the current turn",
    run: async (ctx) => {
      try {
        await ctx.harness.abort();
        ctx.print("Aborted current turn.");
      } catch (e) {
        ctx.print(`Abort failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  },
  {
    name: "model",
    description: "Show or switch the active model (provider/modelId)",
    run: async (ctx, args) => {
      const current = ctx.harness.getModel();
      if (!args) {
        ctx.print(`Current model: ${current.provider}/${current.id}`);
        return;
      }
      const sep = args.indexOf("/");
      if (sep <= 0) {
        ctx.print("Usage: /model <provider>/<modelId>");
        return;
      }
      const provider = args.slice(0, sep);
      const modelId = args.slice(sep + 1);
      const model = ctx.models.getModel(provider, modelId);
      if (!model) {
        ctx.print(`Model not found: ${provider}/${modelId}`);
        return;
      }
      try {
        await ctx.harness.setModel(model);
        ctx.print(`Switched to ${provider}/${modelId}.`);
      } catch (e) {
        ctx.print(`Switch failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  },
  {
    name: "thinking",
    description: "Set the thinking level (off|minimal|low|medium|high|xhigh)",
    run: async (ctx, args) => {
      if (!args) {
        ctx.print(`Current thinking level: ${ctx.harness.getThinkingLevel()}`);
        return;
      }
      if (!THINKING_LEVELS.includes(args as ThinkingLevel)) {
        ctx.print(`Unknown level "${args}". Valid: ${THINKING_LEVELS.join(", ")}`);
        return;
      }
      try {
        await ctx.harness.setThinkingLevel(args as ThinkingLevel);
        ctx.print(`Thinking level set to ${args}.`);
      } catch (e) {
        ctx.print(`Switch failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  },
  {
    name: "tools",
    description: "List active tools",
    run: async (ctx) => {
      const tools = ctx.harness.getActiveTools();
      if (tools.length === 0) {
        ctx.print("No active tools (tool integration arrives in child 3).");
        return;
      }
      ctx.print(
        ["Active tools:", ...tools.map((t) => `  - ${t.name}`)].join("\n"),
      );
    },
  },
  {
    name: "history",
    description: "List recent session files",
    run: async (ctx) => {
      const files = await listSessionFiles(ctx.sessionsDir);
      if (files.length === 0) {
        ctx.print(`No session files found in ${ctx.sessionsDir}`);
        return;
      }
      ctx.print(
        ["Recent sessions:", ...files.map((f) => `  ${f.name}  (${f.mtime.toISOString()})`)].join("\n"),
      );
    },
  },
  {
    name: "new",
    description: "Start a fresh session (manual restart)",
    run: async (ctx) => {
      ctx.print("Quit and restart with: tsx src/cli.ts  (or `novi`)");
    },
  },
  {
    name: "resume",
    description: "Resume a session (manual restart with --resume <path>)",
    run: async (ctx, args) => {
      const target = args || "<path>";
      ctx.print(`Quit and restart with: tsx src/cli.ts --resume ${target}`);
    },
  },
  {
    name: "compact",
    description: "Compact context (not implemented yet)",
    run: async (ctx) => {
      ctx.print("not implemented yet");
    },
  },
  {
    name: "tree",
    description: "Navigate the session tree (not implemented yet)",
    run: async (ctx) => {
      ctx.print("not implemented yet");
    },
  },
  {
    name: "goto",
    description: "Jump to a session entry (not implemented yet)",
    run: async (ctx) => {
      ctx.print("not implemented yet");
    },
  },
];

/** Execute a `/name args` input line against the registry. */
export async function runCommand(
  line: string,
  ctx: CommandContext,
): Promise<void> {
  const { name, args } = parseCommand(line);
  if (!name) {
    ctx.print("Empty command. Try /help.");
    return;
  }
  const command = COMMANDS.find((c) => c.name === name);
  if (!command) {
    ctx.print(`Unknown command: /${name}. Try /help.`);
    return;
  }
  await command.run(ctx, args);
}
