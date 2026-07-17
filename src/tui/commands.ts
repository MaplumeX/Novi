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
import type { ToolCatalogSnapshot } from "../tools/contracts.js";
import type { QueueState } from "./useHarnessState.js";
import { summarizeUsage, formatTokens, formatCost } from "./usage.js";
import { loadTrust, resolveProjectTrust, saveTrust, hasGatedResources } from "../trust.js";
import { matchScopedModels } from "./scoped-models.js";
import { getNoviDir } from "../config.js";
import {
  isHttpServerConfig,
  isStdioServerConfig,
  resolveMcpPlan,
  setMcpApproval,
  type McpPlan,
  type McpPlanEntry,
} from "../mcp/index.js";
import {
  appendPending,
  loadImageFile,
  MAX_PENDING_IMAGES,
  encodeImageBytes,
  type PendingImage,
} from "../images/encode.js";
import { createClipboardImageReader, type ClipboardImageReader } from "../images/clipboard.js";
import * as skillsHub from "../skills-hub/skills-hub.js";
import type { UpdateResult } from "../skills-hub/skills-hub.js";
import type { Risk, SkillLockEntry } from "../skills-hub/types.js";
import type { AgentRunRuntime } from "../agents/runtime.js";
import { summarizeAgentRun } from "../agents/format.js";

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

/** Result of classifying a slash command as a skill invoke. */
export type SkillCommandParse =
  | { kind: "skill"; skillName: string; additionalInstructions?: string }
  | { kind: "not-skill" }
  | { kind: "invalid"; reason: string };

/**
 * Classify a parsed slash command as a `/skill:name [args]` invoke.
 *
 * Pure function for unit testing. Only the `skill:` prefix form is accepted
 * (D1) — bare `/skill name` is not a skill command.
 */
export function parseSkillCommand(name: string, args: string): SkillCommandParse {
  if (!name.startsWith("skill:")) return { kind: "not-skill" };
  const skillName = name.slice("skill:".length);
  if (!skillName) {
    return { kind: "invalid", reason: "Usage: /skill:<name> [args]" };
  }
  const trimmed = args.trim();
  return {
    kind: "skill",
    skillName,
    ...(trimmed ? { additionalInstructions: trimmed } : {}),
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
  cliOverrides: BootstrapResult["cliOverrides"];
  /** Update the resolved-settings state (after a /settings save). */
  setSettings: (s: ResolvedSettings) => void;
  /** Current resolved settings (read-only view for commands like /trust). */
  settings: ResolvedSettings;
  /** Queued steer/followUp/nextTurn messages (projected from queue_update). */
  queue: QueueState;
  /** Pending image attachments for the next prompt/steer/followUp. */
  pendingImages: PendingImage[];
  /** Append images to pending (enforces max 8). Prints on failure. */
  addPendingImages: (items: PendingImage[]) => void;
  /** Clear all pending images. */
  clearPendingImages: () => void;
  /** Process-level child-agent runtime, absent when disabled. */
  agentRuns?: AgentRunRuntime;
  /** Optional injectable clipboard reader (tests / platform override). */
  clipboardReader?: ClipboardImageReader;
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
  | { kind: "imagePicker" }
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

/** Format the validated catalog for `/tools` without reading raw harness events. */
export function formatToolCatalog(catalog: ToolCatalogSnapshot): string {
  const availability = new Map(catalog.availability.map((entry) => [entry.name, entry]));
  const lines = ["Tools:"];
  if (catalog.catalogRevision) lines.push(`  catalog revision ${catalog.catalogRevision}`);
  for (const source of catalog.externalSources ?? []) {
    lines.push(
      `  ${source.sourceId}  ${source.health}  revision=${source.revision}${source.diagnostic ? `  ${source.diagnostic}` : ""}`,
    );
  }
  for (const descriptor of catalog.descriptors) {
    const state = availability.get(descriptor.name);
    const status = state?.status ?? "unavailable";
    const sourceLabel =
      descriptor.source.kind === "external"
        ? `external:${descriptor.source.id}`
        : `${descriptor.source.kind}:${descriptor.source.id}`;
    lines.push(
      `  ${descriptor.name}  ${status}  [${sourceLabel}] ` + descriptor.capabilities.join(","),
    );
    if (state?.reason) lines.push(`    ${state.reasonCode ?? "UNAVAILABLE"}: ${state.reason}`);
  }
  if (catalog.diagnostics.length > 0) {
    lines.push("Diagnostics:", ...catalog.diagnostics.map((diagnostic) => `  ${diagnostic}`));
  }
  return lines.join("\n");
}

function formatMcpTransportSummary(entry: McpPlanEntry): string {
  if (!entry.config) return "-";
  if (isStdioServerConfig(entry.config)) {
    const args = entry.config.args?.length ? ` ${entry.config.args.join(" ")}` : "";
    return `stdio:${entry.config.command}${args}`;
  }
  if (isHttpServerConfig(entry.config)) {
    return `http:${entry.config.url}`;
  }
  return "-";
}

/** Format MCP server rows for `/mcp list`. */
export function formatMcpList(plan: McpPlan, catalog: ToolCatalogSnapshot): string {
  if (plan.entries.length === 0) {
    return [
      "No MCP servers configured.",
      "User: ~/.novi/mcp.json  Project: .mcp.json (requires /mcp approve, not /trust).",
    ].join("\n");
  }
  const lines = ["MCP servers:"];
  for (const entry of plan.entries) {
    const toolCount = catalog.descriptors.filter(
      (d) => d.source.kind === "external" && d.source.id === `mcp:${entry.name}`,
    ).length;
    const activeCount = catalog.activeToolNames.filter((name) =>
      catalog.descriptors.some(
        (d) =>
          d.name === name && d.source.kind === "external" && d.source.id === `mcp:${entry.name}`,
      ),
    ).length;
    lines.push(
      `  ${entry.name}  origin=${entry.origin}  status=${entry.status}  tools=${activeCount}/${toolCount}  ${formatMcpTransportSummary(entry)}`,
    );
    if (entry.reason) lines.push(`    ${entry.reason}`);
  }
  if (plan.diagnostics.length > 0) {
    lines.push("Diagnostics:", ...plan.diagnostics.map((d) => `  ${d}`));
  }
  lines.push(
    "Note: /trust is project settings/skills trust; /mcp approve is MCP server connection approval.",
  );
  return lines.join("\n");
}

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
        const { diagnostics } = await ctx.handle.replace({
          session,
          sessionPath: meta.path,
          reloadResources: true,
        });
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
            current ? `Session name: ${current}` : "Session has no name. Usage: /name <name>",
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
          usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
        const hasUsage =
          usage.inputTokens !== 0 ||
          usage.outputTokens !== 0 ||
          usage.cacheReadTokens !== 0 ||
          usage.cacheWriteTokens !== 0 ||
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
    name: "tools",
    description: "Show active, disabled, denied, and unavailable tools",
    run: async (ctx) => {
      ctx.print(formatToolCatalog(ctx.handle.toolCatalog));
    },
  },
  {
    name: "mcp",
    description:
      "Manage MCP servers (/mcp [list|approve <name>|deny <name>|reconnect [name]]). Distinct from /trust.",
    run: async (ctx, args) => {
      await runMcpCommand(ctx, args);
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
          const resolved = resolveSettings(
            settingsLoad.merged,
            settingsLoad.layers,
            ctx.cliOverrides,
          );
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
    description:
      "Manage scoped models for Ctrl+P cycling (/scoped-models [add|remove|clear] <pattern>)",
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
  {
    name: "image",
    description: "Attach a local image (/image [path] | /image clear)",
    run: async (ctx, args) => {
      const trimmed = args.trim();
      if (!trimmed) {
        ctx.setOverlay({ kind: "imagePicker" });
        return;
      }
      if (trimmed.toLowerCase() === "clear") {
        if (ctx.pendingImages.length === 0) {
          ctx.print("No pending images.");
          return;
        }
        ctx.clearPendingImages();
        ctx.print("Cleared pending images.");
        return;
      }
      const result = await loadImageFile(ctx.env, trimmed);
      if (!result.ok) {
        ctx.print(result.error);
        return;
      }
      ctx.addPendingImages([result.value]);
    },
  },
  {
    name: "paste-image",
    description: "Attach an image from the system clipboard (Ctrl+I)",
    run: async (ctx) => {
      await pasteImageFromClipboard(ctx);
    },
  },
  {
    name: "agents",
    description: "Inspect and manage child-agent runs",
    run: async (ctx, args) => {
      await runAgentsCommand(ctx, args);
    },
  },
  {
    name: "skills",
    description: "Manage skills (search/install/update/uninstall/list)",
    run: async (ctx, args) => {
      await runSkillsCommand(ctx, args);
    },
  },
];

const COMMAND_HINT =
  "Try /quit /model /tools /agents /mcp /session /new /resume /name /compact /settings /trust /scoped-models /reload /image /paste-image /skills /skill:<name>.";

async function runAgentsCommand(ctx: CommandContext, args: string): Promise<void> {
  if (!ctx.agentRuns) {
    ctx.print("Child agents are disabled.");
    return;
  }
  const metadata = await ctx.session.getMetadata();
  const owner = { parentSessionId: metadata.id, generation: metadata.id };
  const [sub = "list", runId] = args.trim().split(/\s+/, 2);
  if (sub === "list") {
    const runs = await ctx.agentRuns.manager.list(owner);
    ctx.print(
      runs.length > 0
        ? runs.map((run) => JSON.stringify(summarizeAgentRun(run))).join("\n")
        : "No agent runs.",
    );
    return;
  }
  if (sub === "stop-all" || (sub === "cancel" && runId === "all")) {
    const runs = await ctx.agentRuns.manager.cancelAll(owner);
    ctx.print(`Cancellation requested for ${runs.length} agent run(s).`);
    return;
  }
  if (!runId) {
    ctx.print("Usage: /agents list|info|log|cancel|retry|stop-all [run-id]");
    return;
  }
  if (sub === "cancel") {
    const run = await ctx.agentRuns.manager.cancel(owner, runId);
    ctx.print(JSON.stringify(summarizeAgentRun(run)));
    return;
  }
  if (sub === "retry") {
    const run = await ctx.agentRuns.manager.retry(owner, runId);
    ctx.print(`Retried as ${run.id}.`);
    return;
  }
  if (sub === "info" || sub === "log") {
    const run = await ctx.agentRuns.manager.get(owner, runId);
    if (!run) {
      ctx.print(`Agent run not found: ${runId}`);
      return;
    }
    ctx.print(
      [
        JSON.stringify(summarizeAgentRun(run)),
        ...(run.childSession ? [`Transcript: ${run.childSession.path}`] : []),
        ...(run.result !== undefined ? [`Result:\n${run.result}`] : []),
        ...(run.error ? [`Error ${run.error.code}: ${run.error.message}`] : []),
      ].join("\n"),
    );
    return;
  }
  ctx.print("Usage: /agents list|info|log|cancel|retry|stop-all [run-id]");
}

/** `/mcp` subcommands: list / approve / deny / reconnect. */
async function runMcpCommand(ctx: CommandContext, args: string): Promise<void> {
  const trimmed = args.trim();
  const spaceIdx = trimmed.search(/\s/);
  const sub = (spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)).toLowerCase() || "list";
  const rest = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

  if (sub === "list" || sub === "") {
    const plan = await resolveMcpPlan(ctx.env, ctx.cwd);
    ctx.print(formatMcpList(plan, ctx.handle.toolCatalog));
    return;
  }

  if (sub === "approve" || sub === "deny") {
    if (!rest) {
      ctx.print(`Usage: /mcp ${sub} <server>`);
      return;
    }
    const plan = await resolveMcpPlan(ctx.env, ctx.cwd);
    const entry = plan.entries.find((e) => e.name === rest);
    if (!entry) {
      ctx.print(`Unknown MCP server: ${rest}`);
      return;
    }
    if (entry.origin !== "project") {
      ctx.print(
        `MCP server "${entry.name}" is origin=${entry.origin}; approval store is only required for project servers.`,
      );
      // Still allow writing an entry if user insists? Prefer no-op with guidance.
      return;
    }
    try {
      await setMcpApproval(ctx.env, {
        serverName: entry.name,
        fingerprint: entry.fingerprint,
        decision: sub === "approve" ? "approved" : "denied",
        origin: "project",
        projectRoot: ctx.cwd,
      });
    } catch (e) {
      ctx.print(`Failed to save MCP approval: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    try {
      const { diagnostics, toolCatalog } = await ctx.handle.refreshTools();
      for (const d of diagnostics) ctx.print(`warning: ${d}`);
      const nextPlan = await resolveMcpPlan(ctx.env, ctx.cwd);
      ctx.print(
        `MCP server "${entry.name}" ${sub === "approve" ? "approved" : "denied"}.\n` +
          formatMcpList(nextPlan, toolCatalog),
      );
    } catch (e) {
      ctx.print(`MCP tool refresh failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    return;
  }

  if (sub === "reconnect") {
    try {
      // Explicit reconnect: re-resolve plan + rebuild assembly (no background reconnect).
      const planBefore = await resolveMcpPlan(ctx.env, ctx.cwd);
      if (rest && !planBefore.entries.some((e) => e.name === rest)) {
        ctx.print(`Unknown MCP server: ${rest}`);
        return;
      }
      const { diagnostics, toolCatalog } = await ctx.handle.refreshTools();
      for (const d of diagnostics) ctx.print(`warning: ${d}`);
      const plan = await resolveMcpPlan(ctx.env, ctx.cwd);
      ctx.print(
        rest
          ? `Reconnected MCP server "${rest}".\n${formatMcpList(plan, toolCatalog)}`
          : `Reconnected MCP servers.\n${formatMcpList(plan, toolCatalog)}`,
      );
    } catch (e) {
      ctx.print(`MCP reconnect failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    return;
  }

  ctx.print("Usage: /mcp [list|approve <name>|deny <name>|reconnect [name]]");
}

const SKILLS_USAGE =
  "Usage: /skills [search <query> | install <ref> [--force] [--confirm] | update [name] | uninstall <name> | list]";

/** Format a scan verdict for human-readable display in `/skills list`. */
function formatScanVerdict(entry: SkillLockEntry): string {
  if (!entry.scan) return "no scan";
  const risks: Risk[] = [];
  const v = entry.scan.verdicts;
  if (v.ath) risks.push(v.ath.risk);
  if (v.socket) risks.push(v.socket.risk);
  if (v.snyk) risks.push(v.snyk.risk);
  if (risks.length === 0) return "scanned";
  return risks.join(",");
}

/**
 * `/skills` subcommand dispatcher: search / install / update / uninstall / list.
 *
 * Delegates all side effects (network, filesystem, lock) to the skills-hub
 * facade. This function only parses arguments and formats results for the
 * TUI notice area.
 */
async function runSkillsCommand(ctx: CommandContext, args: string): Promise<void> {
  const trimmed = args.trim();
  if (!trimmed) {
    ctx.print(SKILLS_USAGE);
    return;
  }
  const spaceIdx = trimmed.search(/\s/);
  const sub = (spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)).toLowerCase();
  const rest = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

  if (sub === "search") {
    if (!rest) {
      ctx.print("Usage: /skills search <query>");
      return;
    }
    try {
      const results = await skillsHub.search(rest);
      if (results.length === 0) {
        ctx.print("No skills found.");
        return;
      }
      const lines = [
        "Skills:",
        ...results.map((r) => `  ${r.name}  ${r.source}  installs=${r.installs}`),
      ];
      ctx.print(lines.join("\n"));
    } catch {
      ctx.print("Search failed (check network).");
    }
    return;
  }

  if (sub === "install") {
    if (!rest) {
      ctx.print("Usage: /skills install <ref> [--force] [--confirm]");
      return;
    }
    const tokens = rest.split(/\s+/);
    const force = tokens.includes("--force");
    const confirmed = tokens.includes("--confirm");
    const ref = tokens.filter((t) => !t.startsWith("--")).join(" ");
    if (!ref) {
      ctx.print("Usage: /skills install <ref> [--force] [--confirm]");
      return;
    }

    const installResult = await skillsHub.install(ctx.env, ref, {
      force,
      confirm: async () => confirmed,
    });

    if (installResult.ok) {
      const verdictLabel =
        installResult.verdict === "unknown" ? "no scan" : `scan=${installResult.verdict}`;
      ctx.print(
        `Installed skill ${installResult.name} to ${installResult.path} (${verdictLabel}). Run /reload to activate.`,
      );
      return;
    }

    // Not ok — distinguish dangerous block from trust-confirmation-needed.
    if (installResult.reason.includes("dangerous")) {
      ctx.print(`Blocked: dangerous scan verdict for "${ref}". Installation aborted.`);
      return;
    }
    // Trust prompt or warn — show the notice and ask user to re-run with --confirm.
    const scanNote = installResult.reason.includes("trust")
      ? "No security scan coverage for this source."
      : `Security warning: ${installResult.reason}`;
    ctx.print(
      [
        `Third-party skill "${ref}" requires confirmation.`,
        scanNote,
        `To proceed, re-run: /skills install ${ref}${force ? " --force" : ""} --confirm`,
      ].join("\n"),
    );
    return;
  }

  if (sub === "update") {
    const name = rest || undefined;
    try {
      const result: UpdateResult = await skillsHub.update(ctx.env, {
        name,
        confirm: async () => true,
      });
      const lines: string[] = [];
      if (result.updated.length > 0) lines.push(`Updated: ${result.updated.join(", ")}`);
      if (result.upToDate.length > 0) lines.push(`Up-to-date: ${result.upToDate.join(", ")}`);
      if (result.failed.length > 0)
        lines.push(`Failed: ${result.failed.map((f) => `${f.name} (${f.error})`).join(", ")}`);
      if (lines.length === 0) lines.push("No hub-installed skills to update.");
      ctx.print(lines.join("\n"));
    } catch (e) {
      ctx.print(`Update failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    return;
  }

  if (sub === "uninstall") {
    if (!rest) {
      ctx.print("Usage: /skills uninstall <name>");
      return;
    }
    try {
      const result = await skillsHub.uninstall(ctx.env, rest);
      if (result.ok) {
        ctx.print(`Uninstalled ${rest}.`);
      } else {
        ctx.print(`Uninstall failed: ${result.reason ?? "unknown error"}`);
      }
    } catch (e) {
      ctx.print(`Uninstall failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    return;
  }

  if (sub === "list") {
    try {
      const entries = await skillsHub.list(ctx.env);
      if (entries.length === 0) {
        ctx.print("No hub-installed skills. Use /skills search <query>.");
        return;
      }
      const lines = [
        "Skills:",
        ...entries.map(
          (e) =>
            `  ${e.name}  ${e.source}  v=${e.version ?? "-"}  installed=${e.installedAt}  ${formatScanVerdict(e)}`,
        ),
      ];
      ctx.print(lines.join("\n"));
    } catch (e) {
      ctx.print(`List failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    return;
  }

  ctx.print(SKILLS_USAGE);
}

/**
 * Read the system clipboard image and append it to pending.
 * Shared by `/paste-image` and Ctrl+I.
 */
export async function pasteImageFromClipboard(ctx: CommandContext): Promise<void> {
  const reader = ctx.clipboardReader ?? createClipboardImageReader();
  const clip = await reader.readImage();
  if (!clip.ok) {
    ctx.print(clip.error);
    return;
  }
  const label = `clipboard-${ctx.pendingImages.length + 1}.png`;
  const encoded = encodeImageBytes(clip.value.bytes, clip.value.mimeType, label);
  if (!encoded.ok) {
    ctx.print(encoded.error);
    return;
  }
  ctx.addPendingImages([encoded.value]);
}

/**
 * Build the addPendingImages callback used by App (enforce capacity + print).
 */
export function makeAddPendingImages(
  getPending: () => PendingImage[],
  setPending: (next: PendingImage[]) => void,
  print: (text: string) => void,
): (items: PendingImage[]) => void {
  return (items) => {
    const result = appendPending(getPending(), items);
    if (!result.ok) {
      print(result.error);
      return;
    }
    setPending(result.value);
    const added = items.map((i) => i.label).join(", ");
    print(`Attached ${added} (${result.value.length}/${MAX_PENDING_IMAGES})`);
  };
}

/** Execute a `/name args` input line against the registry. */
export async function runCommand(line: string, ctx: CommandContext): Promise<void> {
  const { name, args } = parseCommand(line);
  if (!name) {
    ctx.print(`Empty command. ${COMMAND_HINT}`);
    return;
  }

  // Skill invoke takes priority over static COMMANDS and prompt-template fallback (R7).
  const skillCmd = parseSkillCommand(name, args);
  if (skillCmd.kind === "invalid") {
    ctx.print(skillCmd.reason);
    return;
  }
  if (skillCmd.kind === "skill") {
    if (!ctx.isIdle) {
      ctx.print(`Harness is busy; /skill:${skillCmd.skillName} requires idle.`);
      return;
    }
    const skills = ctx.harness.getResources().skills ?? [];
    if (!skills.some((s) => s.name === skillCmd.skillName)) {
      ctx.print(`Unknown skill: ${skillCmd.skillName}`);
      return;
    }
    ctx.print(`Invoking skill: ${skillCmd.skillName}`);
    const invoke =
      skillCmd.additionalInstructions !== undefined
        ? ctx.harness.skill(skillCmd.skillName, skillCmd.additionalInstructions)
        : ctx.harness.skill(skillCmd.skillName);
    invoke.catch((e: unknown) => {
      ctx.print(`Skill failed: ${e instanceof Error ? e.message : String(e)}`);
    });
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
  ctx.print(`Unknown command: /${name}. ${COMMAND_HINT}`);
}
