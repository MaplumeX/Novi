import { promises as fs } from "node:fs";
import path from "node:path";
import {
  JsonlSessionRepo,
  uuidv7,
  parseCommandArgs,
  substituteArgs,
} from "@earendil-works/pi-agent-core/node";
import type {
  AgentHarness,
  Session,
  SessionTreeEntry,
  ThinkingLevel,
  JsonlSessionMetadata,
  ExecutionEnv,
} from "@earendil-works/pi-agent-core/node";
import type { Models } from "@earendil-works/pi-ai";
import type { HarnessHandle } from "./harness-handle.js";
import type { ResolvedSettings } from "../settings.js";
import { loadSettings, resolveSettings } from "../settings.js";
import type { BootstrapResult } from "../bootstrap.js";
import type { QueueState } from "./useHarnessState.js";
import { messageText } from "./queue-helpers.js";
import { summarizeUsage, formatTokens, formatCost } from "./usage.js";

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
  /** Overlay setter: open the settings form, session picker, etc. */
  setOverlay: (overlay: Overlay) => void;
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
  /** Queued steer/followUp/nextTurn messages (projected from queue_update). */
  queue: QueueState;
}

/** Overlay variants openable from commands. */
export type Overlay =
  | null
  | { kind: "settings" }
  | { kind: "filePicker" }
  | { kind: "sessionPicker"; sessions: import("./SessionPicker.js").SessionInfo[] };

export interface Command {
  name: string;
  description: string;
  run: (ctx: CommandContext, args: string) => Promise<void>;
}

export const THINKING_LEVELS: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

/**
 * Return the next thinking level in the {@link THINKING_LEVELS} cycle,
 * wrapping from the last entry back to the first.
 *
 * Pure function so it can be unit-tested in isolation.
 */
export function nextThinkingLevel(current: ThinkingLevel): ThinkingLevel {
  const idx = THINKING_LEVELS.indexOf(current);
  if (idx === -1) return THINKING_LEVELS[0]!;
  return THINKING_LEVELS[(idx + 1) % THINKING_LEVELS.length]!;
}

/**
 * Best-effort scan of a session jsonl file for the most recent `session_info`
 * entry carrying a name. Cheaper than a full `Session` open (no tree build),
 * and lets the `/resume` picker display user-set names.
 */
async function loadSessionDisplayName(
  env: ExecutionEnv,
  filePath: string,
): Promise<string | undefined> {
  const res = await env.readTextLines(filePath);
  if (!res.ok) return undefined;
  let name: string | undefined;
  for (const line of res.value) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (
      entry !== null &&
      typeof entry === "object" &&
      (entry as { type?: string }).type === "session_info" &&
      typeof (entry as { name?: unknown }).name === "string"
    ) {
      name = (entry as { name: string }).name;
    }
  }
  return name;
}

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
    description: "Show or switch the active model (/model [provider/]<modelId>)",
    run: async (ctx, args) => {
      const current = ctx.harness.getModel();
      if (!args) {
        // List the current provider's models with the active one marked.
        const providerModels = ctx.models.getModels(current.provider);
        const lines = [`Current model: ${current.provider}/${current.id}`];
        if (providerModels.length > 0) {
          lines.push(`Models for ${current.provider}:`);
          for (const m of providerModels) {
            const marker = m.id === current.id ? "›" : " ";
            lines.push(`  ${marker} ${m.id}`);
          }
          lines.push(
            `Switch with: /model <modelId>  or  /model <provider>/<modelId>`,
          );
        }
        ctx.print(lines.join("\n"));
        return;
      }
      // `<modelId>` (no slash) → switch within the current provider.
      // `<provider>/<modelId>` → cross-provider switch (existing behavior).
      let provider: string;
      let modelId: string;
      const sep = args.indexOf("/");
      if (sep <= 0) {
        provider = current.provider;
        modelId = args;
      } else {
        provider = args.slice(0, sep);
        modelId = args.slice(sep + 1);
      }
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
    description: "Start a new session",
    run: async (ctx) => {
      if (!ctx.isIdle) {
        ctx.print("Harness is busy; /new requires idle.");
        return;
      }
      try {
        const repo = new JsonlSessionRepo({ fs: ctx.env, sessionsRoot: ctx.sessionsDir });
        const id = uuidv7();
        const session = await repo.create({ cwd: ctx.cwd, id });
        const meta = await session.getMetadata();
        await ctx.handle.replace({ session, sessionPath: meta.path, reloadResources: true });
        ctx.print(`New session: ${meta.path}`);
      } catch (e) {
        ctx.print(`New session failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  },
  {
    name: "resume",
    description: "Browse and resume a previous session",
    run: async (ctx) => {
      try {
        const repo = new JsonlSessionRepo({ fs: ctx.env, sessionsRoot: ctx.sessionsDir });
        const metas = await repo.list({ cwd: ctx.cwd });
        if (metas.length === 0) {
          ctx.print("No previous sessions found.");
          return;
        }
        const sessions = await Promise.all(
          metas.map(async (m) => {
            const displayName = await loadSessionDisplayName(ctx.env, m.path);
            return {
              label: displayName ?? path.basename(m.path),
              path: m.path,
              mtime: new Date(m.createdAt),
            };
          }),
        );
        ctx.setOverlay({ kind: "sessionPicker", sessions });
      } catch (e) {
        ctx.print(`Resume failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  },
  {
    name: "name",
    description: "Name the current session (/name <name>)",
    run: async (ctx, args) => {
      const name = args.trim();
      if (!name) {
        try {
          const current = await ctx.session.getSessionName();
          ctx.print(
            current
              ? `Session name: ${current}`
              : "Session has no name. Usage: /name <name>",
          );
        } catch (e) {
          ctx.print(`Failed: ${e instanceof Error ? e.message : String(e)}`);
        }
        return;
      }
      try {
        await ctx.session.appendSessionName(name);
        ctx.print(`Session named: ${name}`);
      } catch (e) {
        ctx.print(`Name failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  },
  {
    name: "session",
    description: "Show current session info",
    run: async (ctx) => {
      try {
        const meta = await ctx.session.getMetadata();
        const branch = await ctx.session.getBranch();
        const messageEntries = branch.filter((e) => e.type === "message");
        const messages = messageEntries.map((e) => e.message);
        const usage = summarizeUsage(messages);
        const model = ctx.harness.getModel();
        const contextWindow = model.contextWindow ?? 0;
        const cumulativeTokens =
          usage.inputTokens + usage.outputTokens +
          usage.cacheReadTokens + usage.cacheWriteTokens;
        const hasUsage =
          usage.inputTokens !== 0 || usage.outputTokens !== 0 ||
          usage.cacheReadTokens !== 0 || usage.cacheWriteTokens !== 0 ||
          usage.cost !== 0;
        const retry = ctx.harness.getStreamOptions();
        const lines = [
          "Session:",
          `  file: ${meta.path}`,
          `  id: ${meta.id}`,
          `  messages: ${messageEntries.length}`,
        ];
        try {
          const name = await ctx.session.getSessionName();
          if (name) lines.push(`  name: ${name}`);
        } catch {
          // session without a name — omit
        }
        lines.push(
          `  tokens: ${hasUsage ? formatTokens(cumulativeTokens) : "-"} ` +
            `(${hasUsage ? `${formatTokens(usage.inputTokens)} in / ${formatTokens(usage.outputTokens)} out` : "no usage"})`,
          `  cost: ${formatCost(usage.cost, hasUsage)}`,
          `  context window: ${contextWindow > 0 ? formatTokens(contextWindow) : "-"}`,
          `  retry: timeout=${retry.timeoutMs ?? "-"} retries=${retry.maxRetries ?? "-"} maxDelay=${retry.maxRetryDelayMs ?? "-"}`,
        );
        ctx.print(lines.join("\n"));
      } catch (e) {
        ctx.print(`Session info failed: ${e instanceof Error ? e.message : String(e)}`);
      }
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
    name: "queue",
    description: "Show queued steer/followUp/nextTurn messages",
    run: async (ctx) => {
      const { steer, followUp, nextTurn } = ctx.queue;
      const total = steer.length + followUp.length + nextTurn.length;
      if (total === 0) {
        ctx.print("Queue is empty.");
        return;
      }
      const lines: string[] = ["Queue:"];
      for (const m of steer) lines.push(`  [steer]     ${messageText(m).slice(0, 80)}`);
      for (const m of followUp) lines.push(`  [followUp]  ${messageText(m).slice(0, 80)}`);
      for (const m of nextTurn) lines.push(`  [nextTurn]  ${messageText(m).slice(0, 80)}`);
      ctx.print(lines.join("\n"));
    },
  },
  {
    name: "templates",
    description: "List available prompt templates",
    run: async (ctx) => {
      const templates = ctx.harness.getResources().promptTemplates ?? [];
      if (templates.length === 0) {
        ctx.print("No prompt templates loaded.");
        return;
      }
      ctx.print(
        [
          "Prompt templates:",
          ...templates.map((t) => `  /${t.name}${t.description ? ` — ${t.description}` : ""}`),
        ].join("\n"),
      );
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
  if (command) {
    await command.run(ctx, args);
    return;
  }
  // Prompt-template fallback: `/<templateName> [args]` → substituteArgs → prompt.
  const templates = ctx.harness.getResources().promptTemplates ?? [];
  const template = templates.find((t) => t.name === name);
  if (template) {
    if (!ctx.isIdle) {
      ctx.print(`Harness is busy; /${name} requires idle.`);
      return;
    }
    const parsedArgs = parseCommandArgs(args);
    const content = substituteArgs(template.content, parsedArgs);
    ctx.print(`Expanding template: ${name}`);
    ctx.harness.prompt(content).catch((e: unknown) => {
      ctx.print(`Template prompt failed: ${e instanceof Error ? e.message : String(e)}`);
    });
    return;
  }
  ctx.print(`Unknown command: /${name}. Try /help.`);
}

/**
 * Best-effort short preview of a session tree entry for `/tree`.
 *
 * Display-only: never throws across the message-content union.
 */
function entrySummary(entry: SessionTreeEntry): string {
  switch (entry.type) {
    case "message":
      return messageText(entry.message);
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
