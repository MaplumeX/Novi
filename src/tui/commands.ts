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
  ThinkingLevel,
  JsonlSessionMetadata,
  ExecutionEnv,
} from "@earendil-works/pi-agent-core/node";
import type { Models } from "@earendil-works/pi-ai";
import type { HarnessHandle } from "./harness-handle.js";
import type { ResolvedSettings } from "../settings.js";
import { loadSettings, resolveSettings, writeSettings } from "../settings.js";
import type { BootstrapResult } from "../bootstrap.js";
import type { QueueState } from "./useHarnessState.js";
import { summarizeUsage, formatTokens, formatCost } from "./usage.js";
import { loadTrust, resolveProjectTrust, saveTrust, hasGatedResources } from "../trust.js";
import { matchScopedModels } from "./scoped-models.js";
import { getNoviDir } from "../config.js";

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
  /** Current resolved settings (read-only view for commands like /trust). */
  settings: ResolvedSettings;
  /** Queued steer/followUp/nextTurn messages (projected from queue_update). */
  queue: QueueState;
}

/** A selectable entry in the model picker list. */
export interface ModelEntry {
  provider: string;
  id: string;
}

/** Overlay variants openable from commands. */
export type Overlay =
  | null
  | { kind: "settings" }
  | { kind: "filePicker" }
  | { kind: "sessionPicker"; sessions: import("./SessionPicker.js").SessionInfo[] }
  | { kind: "modelPicker"; models: ModelEntry[]; currentIndex: number };

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
 * Best-effort scan of a session jsonl file for a display name, in priority order:
 *   1. the most recent `session_info` entry carrying a user-set name (`/name`)
 *   2. the text of the first user message
 * Cheaper than a full `Session` open (no tree build), and lets the `/resume`
 * picker show something meaningful instead of the raw file basename.
 */
async function loadSessionDisplayName(
  env: ExecutionEnv,
  filePath: string,
): Promise<string | undefined> {
  const res = await env.readTextLines(filePath);
  if (!res.ok) return undefined;
  let name: string | undefined;
  let firstUserText: string | undefined;
  for (const line of res.value) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (entry === null || typeof entry !== "object") continue;
    const e = entry as { type?: string; name?: unknown; message?: unknown };
    if (e.type === "session_info" && typeof e.name === "string") {
      name = e.name;
      continue;
    }
    if (firstUserText === undefined && e.type === "message") {
      const msg = e.message as { role?: unknown; content?: unknown } | undefined;
      if (msg?.role === "user" && Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (
            part !== null &&
            typeof part === "object" &&
            (part as { type?: string }).type === "text" &&
            typeof (part as { text?: unknown }).text === "string"
          ) {
            firstUserText = (part as { text: string }).text
              .replace(/[\r\n]+/g, " ")
              .trim()
              .slice(0, 80);
            break;
          }
        }
      }
    }
  }
  return name ?? firstUserText;
}

/** Command registry. */
export const COMMANDS: readonly Command[] = [
  {
    name: "quit",
    description: "Exit Novi",
    run: async (ctx) => {
      ctx.exit();
    },
  },
  {
    name: "model",
    description: "Show or switch the active model (/model [provider/]<modelId>)",
    run: async (ctx, args) => {
      const current = ctx.harness.getModel();
      if (!args) {
        // Build a flat list of models from every provider whose credential
        // is currently usable (local auth check, no network call), then open
        // the interactive model picker overlay.
        const entries: ModelEntry[] = [];
        for (const provider of ctx.models.getProviders()) {
          const providerModels = ctx.models.getModels(provider.id);
          if (providerModels.length === 0) continue;
          const auth = await ctx.models.getAuth(providerModels[0]!);
          if (!auth) continue;
          for (const m of providerModels) {
            entries.push({ provider: provider.id, id: m.id });
          }
        }
        const currentIndex = entries.findIndex(
          (e) => e.provider === current.provider && e.id === current.id,
        );
        ctx.setOverlay({
          kind: "modelPicker",
          models: entries,
          currentIndex: currentIndex >= 0 ? currentIndex : 0,
        });
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
        const { diagnostics } = await ctx.handle.replace({ session, sessionPath: meta.path, reloadResources: true });
        for (const d of diagnostics) ctx.print(`warning: ${d}`);
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
    name: "settings",
    description: "Open the interactive settings form",
    run: async (ctx) => {
      ctx.setOverlay({ kind: "settings" });
    },
  },
  {
    name: "trust",
    description: "Save project trust decision (/trust [always|never])",
    run: async (ctx, args) => {
      const cwd = ctx.cwd;
      const arg = args.trim().toLowerCase();
      if (!arg) {
        // No argument: show the current trust status + source.
        try {
          const db = await loadTrust(ctx.env);
          const gated = await hasGatedResources(ctx.env, cwd);
          const settingsLoad = await loadSettings(ctx.env, cwd);
          const resolved = resolveSettings(settingsLoad.merged, settingsLoad.layers, ctx.cliOverrides);
          const decision = resolveProjectTrust(cwd, db, {
            defaultProjectTrust: resolved.defaultProjectTrust,
            isHeadless: false,
          });
          const lines = [
            `Working directory: ${cwd}`,
            `Gated resources present: ${gated ? "yes" : "no"}`,
            `Current decision: ${decision}${gated ? "" : " (no gate — no gated resources)"}`,
            `defaultProjectTrust: ${resolved.defaultProjectTrust ?? "ask (default)"} [${ctx.settings._sources.defaultProjectTrust ?? "default"}]`,
          ];
          // Show the applicable trust.json entry (cwd or nearest parent).
          let dir = path.resolve(cwd);
          for (;;) {
            const entry = db[dir];
            if (entry) {
              lines.push(`trust.json entry: ${entry} for ${dir}`);
              break;
            }
            const parent = path.dirname(dir);
            if (parent === dir) break;
            dir = parent;
          }
          ctx.print(lines.join("\n"));
        } catch (e) {
          ctx.print(`Trust status failed: ${e instanceof Error ? e.message : String(e)}`);
        }
        return;
      }
      if (arg !== "always" && arg !== "never") {
        ctx.print("Usage: /trust [always|never]. Default is always.");
        return;
      }
      try {
        await saveTrust(ctx.env, cwd, arg);
        ctx.print(
          arg === "always"
            ? `Saved trust decision "${arg}" for ${cwd} (and parent). Restart Novi for it to take effect.`
            : `Saved trust decision "${arg}" for ${cwd}. Restart Novi for it to take effect.`,
        );
      } catch (e) {
        ctx.print(`Trust save failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  },
  {
    name: "scoped-models",
    description: "Manage scoped models for Ctrl+P cycling (/scoped-models [add|remove|clear] <pattern>)",
    run: async (ctx, args) => {
      const trimmed = args.trim();
      const current: string[] = ctx.settings.scopedModels ?? [];
      if (!trimmed) {
        // No args: list current patterns + matched models.
        if (current.length === 0) {
          ctx.print("No scoped models configured. Usage: /scoped-models add <provider/id-pattern>");
          return;
        }
        const all: { provider: string; id: string }[] = [];
        for (const provider of ctx.models.getProviders()) {
          for (const m of ctx.models.getModels(provider.id)) {
            all.push({ provider: provider.id, id: m.id });
          }
        }
        const matched = matchScopedModels(current, all);
        const lines = [
          "Scoped patterns:",
          ...current.map((p) => `  ${p}`),
          "Matched models:",
          ...matched.map((m) => `  ${m.provider}/${m.id}`),
        ];
        ctx.print(lines.join("\n"));
        return;
      }
      const spaceIdx = trimmed.search(/\s/);
      const sub = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
      const rest = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();
      let next: string[];
      if (sub === "clear") {
        next = [];
      } else if ((sub === "add" || sub === "remove") && rest) {
        if (sub === "add") {
          next = current.includes(rest) ? current : [...current, rest];
        } else {
          next = current.filter((p) => p !== rest);
        }
      } else {
        ctx.print("Usage: /scoped-models [add <pattern> | remove <pattern> | clear]");
        return;
      }
      const targetPath = path.join(getNoviDir(), "settings.json");
      try {
        await writeSettings(ctx.env, targetPath, {
          scopedModels: next.length > 0 ? next : null,
        });
        ctx.print(
          next.length > 0
            ? `Updated scopedModels (${next.length}). Run /reload or restart to apply.`
            : "Cleared scopedModels. Run /reload or restart to apply.",
        );
      } catch (e) {
        ctx.print(`Save failed: ${e instanceof Error ? e.message : String(e)}`);
      }
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
        // Re-read settings.json FIRST so the reload applies the fresh on-disk
        // model/thinking/streamOptions/queue-modes to the new harness (R4).
        // Honor trust gate for project layer; pass layers for permission re-resolve.
        const loaded = await loadSettings(ctx.env, ctx.cwd, {
          includeProject: ctx.handle.trusted,
        });
        for (const diagnostic of loaded.diagnostics) {
          ctx.print(`warning: ${diagnostic}`);
        }
        const newResolved = resolveSettings(loaded.merged, loaded.layers, ctx.cliOverrides);
        ctx.setSettings(newResolved);
        const { diagnostics } = await ctx.handle.replace({
          reloadResources: true,
          resolvedSettings: newResolved,
          settingsLayers: loaded.layers,
        });
        for (const d of diagnostics) ctx.print(`warning: ${d}`);
        ctx.print("Reloaded settings, skills, prompts, and context files.");
      } catch (e) {
        ctx.print(`Reload failed: ${e instanceof Error ? e.message : String(e)}`);
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
    ctx.print("Empty command. Try /quit /model /session /new /resume /name /compact /settings /trust /scoped-models /reload.");
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
  ctx.print(`Unknown command: /${name}. Try /quit /model /session /new /resume /name /compact /settings /trust /scoped-models /reload.`);
}
