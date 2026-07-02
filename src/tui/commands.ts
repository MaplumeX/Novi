import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  AgentHarness,
  AgentMessage,
  Session,
  SessionTreeEntry,
  ThinkingLevel,
} from "@earendil-works/pi-agent-core/node";
import type { JsonlSessionMetadata, ExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { Models, TextContent } from "@earendil-works/pi-ai";
import type { HarnessHandle } from "./harness-handle.js";
import type { ResolvedSettings } from "../settings.js";
import { loadSettings, resolveSettings } from "../settings.js";
import type { BootstrapResult } from "../bootstrap.js";

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
  session: Session<JsonlSessionMetadata>;
  sessionsDir: string;
  /** Whether the harness is idle (true) mid-turn (false). */
  isIdle: boolean;
  /** Request the Ink app to exit cleanly. */
  exit: () => void;
  /** Emit a (possibly multi-line) notice line into the TUI output area. */
  print: (text: string) => void;
  // --- config-personalization (child 1) ---
  /** Replaceable harness holder (for /reload, /new, /resume). */
  handle: HarnessHandle;
  /** Overlay setter: open the settings form (or future overlays). */
  setOverlay: (overlay: null | { kind: "settings" }) => void;
  /** Execution env (for settings file reads/writes). */
  env: ExecutionEnv;
  /** Working directory. */
  cwd: string;
  /** System-prompt provider (reused by harness rebuild). */
  systemPrompt: BootstrapResult["systemPrompt"];
  /** CLI overrides for settings re-resolution. */
  cliOverrides: { provider?: string; model?: string; thinkingLevel?: ThinkingLevel };
  /** Update the resolved-settings state (after a /settings save). */
  setSettings: (s: ResolvedSettings) => void;
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
        ctx.print("No active tools.");
        return;
      }
      ctx.print(
        [
          "Active tools:",
          ...tools.map((t) => `  - ${t.name} — ${t.label}: ${t.description}`),
        ].join("\n"),
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
    description: "Compact context (optional custom instructions)",
    run: async (ctx, args) => {
      if (!ctx.isIdle) {
        ctx.print("Harness is busy; /compact requires idle.");
        return;
      }
      try {
        const result = await ctx.harness.compact(args || undefined);
        const summary = result.summary.slice(0, 80);
        ctx.print(`Compacted (was ${result.tokensBefore} tokens): ${summary}`);
      } catch (e) {
        ctx.print(`Compact failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  },
  {
    name: "tree",
    description: "List session tree entries",
    run: async (ctx) => {
      let entries: SessionTreeEntry[];
      try {
        entries = await ctx.session.getEntries();
      } catch (e) {
        ctx.print(`Failed to read tree: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
      if (entries.length === 0) {
        ctx.print("Session tree is empty.");
        return;
      }
      const lines = entries.map((e) => {
        const summary = entrySummary(e).slice(0, 40);
        return `  ${e.id}  ${e.type}${summary ? `  ${summary}` : ""}`;
      });
      ctx.print(["Session tree:", ...lines].join("\n"));
    },
  },
  {
    name: "settings",
    description: "Open the interactive settings form",
    run: async (ctx) => {
      ctx.setOverlay({ kind: "settings" });
    },
  },
  {
    name: "reload",
    description: "Reload settings, skills, prompts, and context files",
    run: async (ctx) => {
      if (!ctx.isIdle) {
        ctx.print("Harness is busy; /reload requires idle.");
        return;
      }
      try {
        await ctx.handle.replace({ reloadResources: true });
        // Re-read settings.json so the /settings form reflects the on-disk
        // state. (Model/thinking/streamOptions are replayed from the old
        // harness by design; settings file changes to those fields take
        // effect on next full restart, not mid-session.)
        const loaded = await loadSettings(ctx.env, ctx.cwd);
        for (const diagnostic of loaded.diagnostics) {
          ctx.print(`warning: ${diagnostic}`);
        }
        ctx.setSettings(resolveSettings(loaded.merged, loaded.layers, ctx.cliOverrides));
        ctx.print("Reloaded settings, skills, prompts, and context files.");
      } catch (e) {
        ctx.print(`Reload failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  },
  {
    name: "goto",
    description: "Jump to a session entry by id",
    run: async (ctx, args) => {
      const id = args.trim().split(/\s+/)[0];
      if (!id) {
        ctx.print("Usage: /goto <id>  (use /tree to list ids)");
        return;
      }
      if (!ctx.isIdle) {
        ctx.print("Harness is busy; /goto requires idle.");
        return;
      }
      try {
        const result = await ctx.harness.navigateTree(id, { summarize: true });
        if (result.cancelled) {
          ctx.print("Navigation cancelled.");
          return;
        }
        // `session_tree` event triggers a branch reload in useHarnessState.
        ctx.print(`Switched to ${id}.`);
        if (result.editorText) {
          ctx.print(`Editor text: ${result.editorText}`);
        }
      } catch (e) {
        ctx.print(`Goto failed: ${e instanceof Error ? e.message : String(e)}`);
      }
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

/**
 * Best-effort short preview of a session tree entry for `/tree`.
 *
 * Display-only: never throws across the message-content union.
 */
function entrySummary(entry: SessionTreeEntry): string {
  switch (entry.type) {
    case "message":
      return messagePreview(entry.message);
    case "compaction":
    case "branch_summary":
      return entry.summary;
    case "label":
      return entry.label ?? "";
    case "model_change":
      return `${entry.provider}/${entry.modelId}`;
    case "thinking_level_change":
      return entry.thinkingLevel;
    case "active_tools_change":
      return entry.activeToolNames.join(",");
    case "session_info":
      return entry.name ?? "";
    case "custom":
    case "custom_message":
      return entry.customType;
    case "leaf":
      return entry.targetId ?? "";
    default:
      return "";
  }
}

/** Extract a plain-text preview from any agent message shape. */
function messagePreview(message: AgentMessage): string {
  switch (message.role) {
    case "user":
    case "assistant":
    case "toolResult": {
      const content = message.content;
      if (typeof content === "string") return content;
      if (!Array.isArray(content)) return "";
      return content
        .filter((c): c is TextContent => c.type === "text")
        .map((c) => c.text)
        .join(" ");
    }
    case "bashExecution":
      return message.command;
    case "custom": {
      const content = message.content;
      if (typeof content === "string") return content;
      return content
        .filter((c): c is TextContent => c.type === "text")
        .map((c) => c.text)
        .join(" ");
    }
    case "branchSummary":
    case "compactionSummary":
      return message.summary;
    default:
      return "";
  }
}
