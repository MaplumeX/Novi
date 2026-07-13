import { layout } from "./theme.js";

export type ToolStatus = "running" | "done" | "error" | "cancelled";

export interface ToolDetailLine {
  kind: "normal" | "muted" | "add" | "delete" | "error";
  text: string;
}

interface ToolPresentationInput {
  name: string;
  args: Record<string, unknown>;
  status: ToolStatus;
  resultText: string;
}

function stringArg(args: Record<string, unknown>, key: string): string {
  return typeof args[key] === "string" ? args[key] : "";
}

interface CanonicalEdit {
  oldText: string;
  newText: string;
}

function canonicalEdits(args: Record<string, unknown>): CanonicalEdit[] {
  return Array.isArray(args.edits)
    ? args.edits.flatMap((value) => {
        if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
        const edit = value as Record<string, unknown>;
        return typeof edit.oldText === "string" && typeof edit.newText === "string"
          ? [{ oldText: edit.oldText, newText: edit.newText }]
          : [];
      })
    : [];
}

/** Compact arbitrary text to one terminal-friendly line. */
export function compactLine(text: string, max: number = layout.previewWidth): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** Last non-empty line is the most useful live preview for streaming output. */
export function lastMeaningfulLine(text: string): string {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.at(-1) ?? "";
}

/** First non-empty line is the default error/result summary. */
export function firstMeaningfulLine(text: string): string {
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function querySummary(args: Record<string, unknown>): string {
  const queries = args.queries;
  if (!Array.isArray(queries)) return "";
  const values = queries.flatMap((entry) => {
    if (entry === null || typeof entry !== "object") return [];
    const query = (entry as Record<string, unknown>).query;
    return typeof query === "string" ? [query] : [];
  });
  return compactLine(values.join(" · "));
}

function urlSummary(args: Record<string, unknown>): string {
  const urls = args.urls;
  if (!Array.isArray(urls)) return "";
  const values = urls.filter((value): value is string => typeof value === "string");
  if (values.length === 0) return "";
  if (values.length === 1) return compactLine(values[0]!);
  return `${compactLine(values[0]!)} +${values.length - 1}`;
}

/** Human-facing action and key target for built-ins, with a readable fallback. */
export function toolAction(
  name: string,
  args: Record<string, unknown>,
  label?: string,
): { action: string; target: string } {
  const path = stringArg(args, "path");
  const pattern = stringArg(args, "pattern");
  switch (name) {
    case "read_file":
      return { action: "Read", target: path };
    case "write_file":
      return { action: "Write", target: path };
    case "edit_file":
      return { action: "Update", target: path };
    case "bash":
      return { action: "Run", target: compactLine(stringArg(args, "command")) };
    case "ls":
      return { action: "List", target: path || "." };
    case "glob":
      return {
        action: "Find files",
        target: compactLine([path, pattern].filter(Boolean).join(" ")),
      };
    case "grep":
      return {
        action: "Search",
        target: compactLine([pattern, path].filter(Boolean).join(" in ")),
      };
    case "web_search":
      return { action: "Search web", target: querySummary(args) };
    case "fetch_content":
      return { action: "Fetch", target: urlSummary(args) };
    case "todo": {
      const action = stringArg(args, "action");
      return {
        action: action === "add" ? "Add todo" : action === "update" ? "Update todo" : "List todos",
        target: compactLine(stringArg(args, "content") || stringArg(args, "id")),
      };
    }
    default:
      return {
        action: label || name.replace(/[_-]+/g, " ").replace(/^./, (char) => char.toUpperCase()),
        target: path || pattern,
      };
  }
}

interface DiffLine {
  kind: "context" | "delete" | "add";
  text: string;
}

/** Small LCS line diff retained from the previous edit-file presentation. */
export function simpleDiff(oldText: string, newText: string): DiffLine[] {
  const before = oldText.split("\n");
  const after = newText.split("\n");
  const table: number[][] = Array(before.length + 1)
    .fill(null)
    .map(() => Array(after.length + 1).fill(0));

  for (let i = before.length - 1; i >= 0; i--) {
    for (let j = after.length - 1; j >= 0; j--) {
      table[i]![j] =
        before[i] === after[j]
          ? table[i + 1]![j + 1]! + 1
          : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }

  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      lines.push({ kind: "context", text: before[i]! });
      i++;
      j++;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      lines.push({ kind: "delete", text: before[i++]! });
    } else {
      lines.push({ kind: "add", text: after[j++]! });
    }
  }
  while (i < before.length) lines.push({ kind: "delete", text: before[i++]! });
  while (j < after.length) lines.push({ kind: "add", text: after[j++]! });
  return lines;
}

function diffStat(args: Record<string, unknown>): string {
  const lines = canonicalEdits(args).flatMap((edit) => simpleDiff(edit.oldText, edit.newText));
  const additions = lines.filter((line) => line.kind === "add").length;
  const deletions = lines.filter((line) => line.kind === "delete").length;
  return `+${additions} -${deletions}`;
}

/** One compact result line. Errors always surface their first useful line. */
export function toolResultSummary({
  name,
  args,
  status,
  resultText,
}: ToolPresentationInput): string {
  if (status === "running") {
    return compactLine(lastMeaningfulLine(resultText));
  }
  if (status === "error" || status === "cancelled") {
    return compactLine(firstMeaningfulLine(resultText) || "Tool failed");
  }
  switch (name) {
    case "edit_file":
      return `Updated ${diffStat(args)}`;
    case "write_file":
      return `Wrote ${stringArg(args, "content").split("\n").length} lines`;
    case "read_file":
      return resultText ? `Read ${resultText.split("\n").length} lines` : "Read complete";
    case "bash": {
      const lines = resultText
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      const firstOutput = lines.find((line) => !/^exit\s+0$/i.test(line));
      return compactLine(firstOutput ?? "Command completed");
    }
    case "fetch_content": {
      const urls = args.urls;
      const count = Array.isArray(urls) ? urls.length : 0;
      return count > 0 ? `Fetched ${count} ${count === 1 ? "item" : "items"}` : "Fetch complete";
    }
    default:
      return compactLine(firstMeaningfulLine(resultText) || "Completed");
  }
}

/** Full detail lines shared by live and persisted calls. */
export function toolDetailLines({
  name,
  args,
  status,
  resultText,
}: ToolPresentationInput): ToolDetailLine[] {
  if (name === "edit_file") {
    const edits = canonicalEdits(args);
    return edits.flatMap((edit, index) => [
      ...(edits.length > 1
        ? [{ kind: "muted" as const, text: `@@ edit ${index + 1}/${edits.length} @@` }]
        : []),
      ...simpleDiff(edit.oldText, edit.newText).map((line) => ({
        kind:
          line.kind === "add"
            ? ("add" as const)
            : line.kind === "delete"
              ? ("delete" as const)
              : ("muted" as const),
        text: `${line.kind === "add" ? "+ " : line.kind === "delete" ? "- " : "  "}${line.text}`,
      })),
    ]);
  }

  const lines: ToolDetailLine[] = [];
  if (name === "bash") {
    lines.push({ kind: "muted", text: `$ ${stringArg(args, "command")}` });
  } else if (name === "write_file") {
    lines.push(
      ...stringArg(args, "content")
        .split("\n")
        .map((text) => ({ kind: "normal" as const, text })),
    );
  } else {
    const json = JSON.stringify(args, null, 2);
    if (json && json !== "{}") {
      lines.push(...json.split("\n").map((text) => ({ kind: "muted" as const, text })));
    }
  }
  if (resultText) {
    lines.push(
      ...resultText.split("\n").map((text) => ({
        kind: status === "error" ? ("error" as const) : ("normal" as const),
        text,
      })),
    );
  }
  return lines;
}

export function truncateDetailLines(lines: ToolDetailLine[]): ToolDetailLine[] {
  if (lines.length <= layout.toolResultLines) return lines;
  const hidden = lines.length - layout.toolResultLines;
  return [
    ...lines.slice(0, layout.toolResultLines),
    { kind: "muted", text: `… ${hidden} more lines` },
  ];
}
