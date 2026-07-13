import { useEffect, useState } from "react";
import { Text, Box, useInput } from "ink";
import path from "node:path";
import type { ExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { ResolvedSettings } from "../settings.js";
import { writeSettings, loadSettings, resolveSettings } from "../settings.js";
import { loadCredentials, getCredentialsPath } from "../credentials.js";
import { getNoviDir } from "../config.js";
import { Panel } from "./components/Panel.js";
import { icons, theme } from "./theme.js";
import type { BootstrapResult } from "../bootstrap.js";

interface SettingsFormProps {
  settings: ResolvedSettings;
  env: ExecutionEnv;
  cwd: string;
  cliOverrides: BootstrapResult["cliOverrides"];
  onSaved: (updated: ResolvedSettings) => void;
  onExit: () => void;
  onReload: () => void;
}

type FieldType = "text" | "number" | "toggle" | "select" | "readonly";

interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  options?: readonly string[];
}

const THINKING_LEVELS: readonly string[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
const TRUST_OPTIONS: readonly string[] = ["ask", "always", "never"];

const TRANSPORT_OPTIONS: readonly string[] = ["sse", "websocket", "websocket-cached", "auto"];
const QUEUE_MODE_OPTIONS: readonly string[] = ["one-at-a-time", "all"];

const FIELDS: readonly FieldDef[] = [
  { key: "defaultProvider", label: "defaultProvider", type: "text" },
  { key: "defaultModel", label: "defaultModel", type: "text" },
  {
    key: "defaultThinkingLevel",
    label: "defaultThinkingLevel",
    type: "select",
    options: THINKING_LEVELS,
  },
  {
    key: "defaultProjectTrust",
    label: "defaultProjectTrust",
    type: "select",
    options: TRUST_OPTIONS,
  },
  { key: "transport", label: "transport", type: "select", options: TRANSPORT_OPTIONS },
  { key: "steeringMode", label: "steeringMode", type: "select", options: QUEUE_MODE_OPTIONS },
  { key: "followUpMode", label: "followUpMode", type: "select", options: QUEUE_MODE_OPTIONS },
  { key: "scopedModels", label: "scopedModels (comma-sep)", type: "text" },
  {
    key: "permissions.rules",
    label: "permissions.rules (edit JSON)",
    type: "readonly",
  },
  {
    key: "permissions.externalWriteAllowlist",
    label: "permissions.externalWriteAllowlist (global JSON only)",
    type: "readonly",
  },
  { key: "artifacts.enabled", label: "artifacts.enabled (JSON policy)", type: "readonly" },
  ...[
    "modelBytes",
    "modelLines",
    "memoryBytes",
    "partialBytes",
    "partialUpdatesPerSecond",
    "timeoutMs",
    "maxConcurrentCalls",
    "traversalFiles",
    "traversalDepth",
    "resultCount",
    "artifactSessionBytes",
    "artifactGlobalBytes",
    "artifactMaxAgeMs",
    "webCacheBytes",
    "webCacheMaxAgeMs",
  ].map((name) => ({
    key: `toolBudgets.${name}`,
    label: `toolBudgets.${name} (JSON/CLI)`,
    type: "readonly" as const,
  })),
  { key: "compaction.enabled", label: "compaction.enabled", type: "toggle" },
  { key: "compaction.reserveTokens", label: "compaction.reserveTokens", type: "number" },
  { key: "compaction.keepRecentTokens", label: "compaction.keepRecentTokens", type: "number" },
  { key: "retry.provider.timeoutMs", label: "retry.provider.timeoutMs", type: "number" },
  { key: "retry.provider.maxRetries", label: "retry.provider.maxRetries", type: "number" },
  {
    key: "retry.provider.maxRetryDelayMs",
    label: "retry.provider.maxRetryDelayMs",
    type: "number",
  },
];

function getFieldValue(settings: ResolvedSettings, key: string): string {
  if (key === "permissions.rules") {
    return `${settings.permissions?.rules?.length ?? 0} rule(s)`;
  }
  if (key === "permissions.externalWriteAllowlist") {
    return settings.permissions?.externalWriteAllowlist?.join(", ") ?? "";
  }
  const parts = key.split(".");
  let cursor: unknown = settings;
  for (const part of parts) {
    if (cursor === null || cursor === undefined || typeof cursor !== "object") {
      return "";
    }
    cursor = (cursor as Record<string, unknown>)[part];
  }
  if (cursor === undefined || cursor === null) {
    return "";
  }
  return String(cursor);
}

function getSource(settings: ResolvedSettings, key: string): string {
  return settings._sources[key] ?? "default";
}

/** Mask a secret, showing the first 3 and last 4 characters only. */
function maskSecret(value: string): string {
  if (value.length <= 8) return "••••";
  return `${value.slice(0, 3)}...${value.slice(-4)}`;
}

export function SettingsForm({
  settings,
  env,
  cwd,
  cliOverrides,
  onSaved,
  onExit,
  onReload,
}: SettingsFormProps): React.ReactElement {
  const [cursor, setCursor] = useState(0);
  const [editing, setEditing] = useState<number | null>(null);
  const [editBuffer, setEditBuffer] = useState("");
  const [savePrompt, setSavePrompt] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // Local draft of edits (dot-path → value).
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  // Credentials loaded from ~/.novi/credentials.json (read-only, masked).
  const [creds, setCreds] = useState<Record<string, string>>({});
  useEffect(() => {
    void loadCredentials(env).then(setCreds);
  }, [env]);

  const field = FIELDS[cursor];
  const baseValue = field
    ? draft[field.key] !== undefined
      ? String(draft[field.key])
      : getFieldValue(settings, field.key)
    : "";
  const effectiveValue = editing !== null && editing === cursor ? editBuffer : baseValue;

  useInput((value, key) => {
    // --- Save-prompt mode ---
    if (savePrompt) {
      if (value === "g" || value === "G") {
        void doSave("global");
        setSavePrompt(false);
      } else if (value === "p" || value === "P") {
        void doSave("project");
        setSavePrompt(false);
      } else if (key.escape) {
        setSavePrompt(false);
      }
      return;
    }

    // --- Edit mode ---
    if (editing !== null) {
      const f = FIELDS[editing];
      if (key.return) {
        let val: unknown = editBuffer;
        if (f.type === "number") {
          val = editBuffer.trim() === "" ? undefined : Number(editBuffer);
          if (typeof val === "number" && Number.isNaN(val)) val = undefined;
        } else if (f.type === "toggle") {
          val = editBuffer === "true";
        } else if (f.key === "scopedModels") {
          // comma-separated text → string[] (trim, drop empties)
          val = editBuffer
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
          if ((val as string[]).length === 0) val = undefined;
        }
        setDraft((prev) => ({ ...prev, [f.key]: val }));
        setEditing(null);
        setEditBuffer("");
        setMessage(null);
        return;
      }
      if (key.escape) {
        setEditing(null);
        setEditBuffer("");
        return;
      }
      if (
        (f.type === "select" || f.type === "toggle") &&
        (key.upArrow || key.downArrow) &&
        f.options
      ) {
        const idx = f.options.indexOf(editBuffer);
        const next = key.upArrow
          ? idx <= 0
            ? f.options.length - 1
            : idx - 1
          : (idx + 1) % f.options.length;
        setEditBuffer(f.options[next]);
        return;
      }
      if (f.type === "toggle") {
        // Any letter key flips true/false.
        if (value && !key.ctrl && !key.meta) {
          setEditBuffer(editBuffer === "true" ? "false" : "true");
        }
        return;
      }
      if (key.backspace || key.delete) {
        setEditBuffer((prev) => prev.slice(0, -1));
        return;
      }
      if (key.ctrl || key.meta || !value) return;
      setEditBuffer((prev) => prev + value);
      return;
    }

    // --- Browse mode ---
    // 'r' after a save → reload.
    if (message && message.includes("Saved") && value === "r") {
      onReload();
      setMessage("Reloading…");
      return;
    }
    if (key.upArrow) {
      setCursor((c) => (c - 1 + FIELDS.length) % FIELDS.length);
      return;
    }
    if (key.downArrow) {
      setCursor((c) => (c + 1) % FIELDS.length);
      return;
    }
    if (key.return) {
      const f = FIELDS[cursor];
      if (f.type === "readonly") {
        setMessage("Permission rules are edited in settings.json and applied with /reload.");
        return;
      }
      if (f.type === "toggle") {
        // Toggle directly: flip and commit (stay in browse mode).
        const cur = baseValue === "true";
        setDraft((prev) => ({ ...prev, [f.key]: !cur }));
        setMessage(null);
        return;
      }
      if (f.type === "select" && f.options) {
        setEditBuffer(baseValue || f.options[0]);
      } else {
        setEditBuffer(baseValue);
      }
      setEditing(cursor);
      setMessage(null);
      return;
    }
    if (value === "s") {
      setSavePrompt(true);
      return;
    }
    if (key.escape) {
      onExit();
      return;
    }
  });

  async function doSave(target: "global" | "project"): Promise<void> {
    const targetPath =
      target === "global"
        ? path.join(getNoviDir(), "settings.json")
        : path.join(cwd, ".novi", "settings.json");
    try {
      await writeSettings(env, targetPath, draft);
      const loaded = await loadSettings(env, cwd);
      const resolved = resolveSettings(loaded.merged, loaded.layers, cliOverrides);
      onSaved(resolved);
      setDraft({});
      setMessage(
        `Saved to ${target === "global" ? "~/.novi" : ".novi"}/settings.json — press r to reload, other key to continue.`,
      );
    } catch (e) {
      setMessage(`Save failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const lines: React.ReactElement[] = [];
  const footer = savePrompt
    ? "g save global · p save project · Esc cancel"
    : editing !== null
      ? "Enter apply · Esc cancel"
      : "↑↓ navigate · Enter edit · s save · Esc exit";

  for (let i = 0; i < FIELDS.length; i++) {
    const f = FIELDS[i];
    const isCursor = i === cursor && editing === null;
    const isEditing = i === cursor && editing !== null;
    const src = getSource(settings, f.key);
    const val = i === cursor ? effectiveValue : getFieldValue(settings, f.key);
    const modified = draft[f.key] !== undefined;
    const marker = isEditing ? icons.edit : isCursor ? icons.selection : modified ? "*" : " ";
    lines.push(
      <Text key={f.key} color={isCursor || isEditing ? theme.accent : undefined}>
        {marker} {f.label}: {val || "(unset)"} <Text color={theme.text.muted}>[{src}]</Text>
        {isEditing && f.type === "select" ? <Text color={theme.text.muted}> ↑↓ cycle</Text> : null}
      </Text>,
    );
  }

  if (message) {
    lines.push(
      <Text
        key="msg"
        color={message.startsWith("Save failed") ? theme.status.error : theme.status.success}
      >
        {message}
      </Text>,
    );
  }

  // Read-only credentials section (from ~/.novi/credentials.json).
  const credEntries = Object.entries(creds);
  lines.push(
    <Text key="creds-hdr" bold>
      Credentials (read-only — {getCredentialsPath()})
    </Text>,
  );
  if (credEntries.length === 0) {
    lines.push(
      <Text key="creds-empty" color={theme.text.muted}>
        {" "}
        (none configured)
      </Text>,
    );
  } else {
    for (const [name, value] of credEntries) {
      lines.push(
        <Text key={name}>
          {" "}
          {name}: {maskSecret(value)}
        </Text>,
      );
    }
  }

  return (
    <Panel
      title="Settings"
      description={savePrompt ? "Choose where to save the current changes." : undefined}
      footer={footer}
    >
      <Box flexDirection="column">{lines}</Box>
    </Panel>
  );
}
