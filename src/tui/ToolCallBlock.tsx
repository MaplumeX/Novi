import { Box, Text } from "ink";
import type { AgentToolCall } from "@earendil-works/pi-agent-core/node";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { theme } from "./theme.js";

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

/** Truncate an array of lines to MAX_RESULT_LINES, appending a "more" hint. */
function truncateLines(lines: string[]): string[] {
  if (lines.length <= MAX_RESULT_LINES) return lines;
  const more = lines.length - MAX_RESULT_LINES;
  return [...lines.slice(0, MAX_RESULT_LINES), `… (${more} more lines)`];
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

function renderDiff(diffLines: DiffLine[]): React.ReactElement {
  const truncated = truncateLines(
    diffLines.map((d) => `${d.kind === "del" ? "-" : d.kind === "add" ? "+" : " "} ${d.text}`),
  );
  return (
    <Box flexDirection="column">
      {truncated.map((line, idx) => {
        if (line.startsWith("- ")) {
          return (
            <Text key={idx} color={theme.diff.del}>
              {line}
            </Text>
          );
        }
        if (line.startsWith("+ ")) {
          return (
            <Text key={idx} color={theme.diff.add}>
              {line}
            </Text>
          );
        }
        return (
          <Text key={idx} color={theme.dim}>
            {line}
          </Text>
        );
      })}
    </Box>
  );
}

/** Render the expanded content for a specific tool type. */
function renderExpanded(call: AgentToolCall, result?: ToolResultMessage): React.ReactElement {
  const args = call.arguments ?? {};
  switch (call.name) {
    case "edit_file": {
      const oldText = typeof args.oldText === "string" ? args.oldText : "";
      const newText = typeof args.newText === "string" ? args.newText : "";
      return (
        <Box flexDirection="column">
          <Text color={theme.dim}>path: {typeof args.path === "string" ? args.path : ""}</Text>
          {renderDiff(simpleDiff(oldText, newText))}
        </Box>
      );
    }
    case "write_file": {
      const content = typeof args.content === "string" ? args.content : "";
      const lines = truncateLines(content.split("\n"));
      return (
        <Box flexDirection="column">
          <Text color={theme.dim}>path: {typeof args.path === "string" ? args.path : ""}</Text>
          {lines.map((line, idx) => (
            <Text key={idx}>{line}</Text>
          ))}
        </Box>
      );
    }
    case "bash": {
      const cmd = typeof args.command === "string" ? args.command : "";
      const output = result
        ? result.content
            .filter((c): c is { type: "text"; text: string } => c.type === "text")
            .map((c) => c.text)
            .join("\n")
        : "";
      const lines = truncateLines(output.split("\n"));
      return (
        <Box flexDirection="column">
          <Text color={theme.dim}>$ {cmd}</Text>
          {result?.isError ? (
            <Text color={theme.status.error}>exit: error</Text>
          ) : null}
          {lines.map((line, idx) => (
            <Text key={idx}>{line}</Text>
          ))}
        </Box>
      );
    }
    default: {
      // Generic fallback: args JSON + result text
      const argsJson = JSON.stringify(args, null, 2);
      const resultText = result
        ? result.content
            .filter((c): c is { type: "text"; text: string } => c.type === "text")
            .map((c) => c.text)
            .join("\n")
        : "";
      const lines = truncateLines(resultText.split("\n"));
      return (
        <Box flexDirection="column">
          <Text color={theme.dim}>{argsJson}</Text>
          {lines.length > 0 ? (
            lines.map((line, idx) => (
              <Text key={idx}>{line}</Text>
            ))
          ) : null}
        </Box>
      );
    }
  }
}

export function ToolCallBlock({ call, result, expanded }: ToolCallBlockProps): React.ReactElement {
  const summary = summarizeArgs(call.name, call.arguments ?? {});
  const badgeColor = result?.isError ? theme.status.error : result ? theme.status.idle : theme.status.active;
  if (!expanded) {
    return (
      <Text>
        <Text color={badgeColor}>●</Text>{" "}
        <Text color={theme.dim}>⚙ {call.name}</Text>
        {summary ? <Text color={theme.dim}> — {summary}</Text> : null}
        {result?.isError ? <Text color={theme.status.error}> (error)</Text> : null}
      </Text>
    );
  }
  return (
    <Box flexDirection="column">
      <Box borderStyle="single" borderColor={theme.border} paddingX={1}>
        <Text>
          <Text color={badgeColor}>●</Text>{" "}
          <Text color={theme.dim}>⚙ {call.name}</Text>
          {summary ? <Text color={theme.dim}> — {summary}</Text> : null}
          {result?.isError ? <Text color={theme.status.error}> (error)</Text> : null}
        </Text>
      </Box>
      <Box paddingLeft={1}>
        <Box flexDirection="column">{renderExpanded(call, result)}</Box>
      </Box>
    </Box>
  );
}
