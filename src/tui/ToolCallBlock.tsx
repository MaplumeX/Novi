import { Box, Text } from "ink";
import type { AgentToolCall } from "@earendil-works/pi-agent-core/node";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { icons, theme } from "./theme.js";

const MAX_RESULT_LINES = 20;

interface ToolCallBlockProps {
  call: AgentToolCall;
  /** Matching tool result, if it has arrived yet. */
  result?: ToolResultMessage;
  expanded: boolean;
}

/** Extract a one-line summary of the tool call arguments. */
function summarizeArgs(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "edit_file":
    case "write_file": {
      const path = typeof args.path === "string" ? args.path : "";
      return path;
    }
    case "bash": {
      const cmd = typeof args.command === "string" ? args.command : "";
      return cmd.length > 60 ? cmd.slice(0, 57) + "…" : cmd;
    }
    case "read_file":
    case "ls":
    case "glob":
    case "grep": {
      const path = typeof args.path === "string" ? args.path : "";
      const pattern = typeof args.pattern === "string" ? args.pattern : "";
      return pattern ? `${path} ${pattern}`.trim() : path;
    }
    default:
      return "";
  }
}

/** Simple LCS-based line diff producing {type, line} entries. */
interface DiffLine {
  kind: "ctx" | "del" | "add";
  text: string;
}

function simpleDiff(oldText: string, newText: string): DiffLine[] {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  const n = a.length;
  const m = b.length;
  // LCS table
  const dp: number[][] = Array(n + 1)
    .fill(null)
    .map(() => Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const result: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      result.push({ kind: "ctx", text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      result.push({ kind: "del", text: a[i] });
      i++;
    } else {
      result.push({ kind: "add", text: b[j] });
      j++;
    }
  }
  while (i < n) {
    result.push({ kind: "del", text: a[i++] });
  }
  while (j < m) {
    result.push({ kind: "add", text: b[j++] });
  }
  return result;
}

/** `+{adds} -{dels}` stat for an edit_file diff. */
function diffStat(diffLines: DiffLine[]): string {
  let adds = 0;
  let dels = 0;
  for (const d of diffLines) {
    if (d.kind === "add") adds++;
    else if (d.kind === "del") dels++;
  }
  return `+${adds} -${dels}`;
}

/** Collect the text content parts of a tool result into a single string. */
function resultText(result?: ToolResultMessage): string {
  return result
    ? result.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("\n")
    : "";
}

/** Render the expanded content lines for a specific tool type. */
function expandedContentLines(call: AgentToolCall, result?: ToolResultMessage): DiffLine[] | string[] {
  const args = call.arguments ?? {};
  switch (call.name) {
    case "edit_file": {
      const oldText = typeof args.oldText === "string" ? args.oldText : "";
      const newText = typeof args.newText === "string" ? args.newText : "";
      return simpleDiff(oldText, newText);
    }
    case "write_file": {
      const content = typeof args.content === "string" ? args.content : "";
      return content.split("\n");
    }
    case "bash": {
      const output = resultText(result);
      return output.split("\n");
    }
    default: {
      const argsJson = JSON.stringify(args, null, 2);
      const text = resultText(result);
      return text.length > 0 ? [...argsJson.split("\n"), ...text.split("\n")] : argsJson.split("\n");
    }
  }
}

/** Render the collapsed summary line for a specific tool type. */
function collapsedSummaryLine(call: AgentToolCall, result?: ToolResultMessage): string {
  const args = call.arguments ?? {};
  switch (call.name) {
    case "edit_file": {
      const oldText = typeof args.oldText === "string" ? args.oldText : "";
      const newText = typeof args.newText === "string" ? args.newText : "";
      return `Updated — ${diffStat(simpleDiff(oldText, newText))}`;
    }
    case "write_file": {
      const content = typeof args.content === "string" ? args.content : "";
      return `Wrote ${content.split("\n").length} lines`;
    }
    case "bash": {
      if (result?.isError) return "exit: error";
      const output = resultText(result);
      const first = output.split("\n")[0] ?? "";
      return first;
    }
    default: {
      const text = resultText(result);
      return text.split("\n")[0] ?? "";
    }
  }
}

/** Count of content lines beyond the collapsed preview (1 line). */
function collapsedExtraLines(call: AgentToolCall, result?: ToolResultMessage): number {
  const lines = expandedContentLines(call, result);
  return Math.max(0, lines.length - 1);
}

export function ToolCallBlock({ call, result, expanded }: ToolCallBlockProps): React.ReactElement {
  const summary = summarizeArgs(call.name, call.arguments ?? {});
  const badgeColor = result?.isError
    ? theme.status.error
    : result
      ? theme.status.idle
      : theme.status.active;
  const isError = result?.isError === true;
  const running = !result;

  const header = (
    <Text>
      <Text color={badgeColor}>{icons.statusDot}</Text>{" "}
      <Text color={theme.dim}>{call.name}</Text>
      {summary ? <Text color={theme.dim}>({summary})</Text> : null}
      {isError ? <Text color={theme.status.error}> (error)</Text> : null}
    </Text>
  );

  if (expanded) {
    const isDiff = call.name === "edit_file";
    const isBash = call.name === "bash";
    const cmd = isBash && typeof call.arguments?.command === "string" ? call.arguments.command : "";

    // Build the full tree line list (strings + per-line color), then prefix
    // `⎿` on the first line and 2-space-indent the rest to align under it.
    interface TreeLine {
      text: string;
      color?: string;
    }
    const treeLines: TreeLine[] = [];
    if (isBash) {
      treeLines.push({ text: `$ ${cmd}`, color: theme.dim });
    }
    if (isDiff) {
      const diffLines = expandedContentLines(call, result) as DiffLine[];
      for (const d of diffLines) {
        const prefix = d.kind === "del" ? "- " : d.kind === "add" ? "+ " : "  ";
        const color = d.kind === "del" ? theme.diff.del : d.kind === "add" ? theme.diff.add : theme.dim;
        treeLines.push({ text: `${prefix}${d.text}`, color });
      }
    } else if (isBash) {
      const output = resultText(result);
      for (const line of output.split("\n")) {
        treeLines.push({ text: line });
      }
      if (isError) {
        treeLines.push({ text: "exit: error", color: theme.status.error });
      }
    } else {
      for (const line of expandedContentLines(call, result) as string[]) {
        treeLines.push({ text: line });
      }
    }
    // Drop a trailing empty line just before an `exit: error` for bash.
    if (isBash && isError && treeLines[treeLines.length - 2]?.text === "") {
      treeLines.splice(treeLines.length - 2, 1);
    }
    // Truncate the tree: preserve per-line colors, append a dim "more" hint.
    let rendered: TreeLine[];
    if (treeLines.length <= MAX_RESULT_LINES) {
      rendered = treeLines;
    } else {
      const more = treeLines.length - MAX_RESULT_LINES;
      rendered = [...treeLines.slice(0, MAX_RESULT_LINES), { text: `… (${more} more lines)`, color: theme.dim }];
    }

    return (
      <Box flexDirection="column">
        {header}
        <Box flexDirection="column">
          {rendered.map((l, idx) => {
            const prefix = idx === 0 ? `${icons.bracket} ` : "  ";
            return (
              <Text key={idx} color={l.color}>
                {prefix}
                {l.text}
              </Text>
            );
          })}
        </Box>
      </Box>
    );
  }

  // Collapsed: header + ⎿ summary + optional expand hint
  const summaryLine = running ? "…" : collapsedSummaryLine(call, result);
  const extra = collapsedExtraLines(call, result);
  return (
    <Box flexDirection="column">
      {header}
      <Box flexDirection="column">
        <Text color={theme.dim}>
          {icons.bracket} {summaryLine}
        </Text>
        {extra > 0 ? (
          <Text color={theme.dim}>  +{extra} lines (ctrl+o to expand)</Text>
        ) : null}
      </Box>
    </Box>
  );
}