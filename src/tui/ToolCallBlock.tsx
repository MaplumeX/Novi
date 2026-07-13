import { Box, Text } from "ink";
import type { ToolCallView } from "./useHarnessState.js";
import {
  toolAction,
  toolDetailLines,
  toolResultSummary,
  truncateDetailLines,
  type ToolDetailLine,
  type ToolStatus,
} from "./tool-presentation.js";
import { Spinner } from "./components/Spinner.js";
import { icons, theme } from "./theme.js";

interface ToolCallBlockProps {
  view: ToolCallView;
  detailed: boolean;
}

function detailColor(kind: ToolDetailLine["kind"]): string | undefined {
  switch (kind) {
    case "muted":
      return theme.text.muted;
    case "add":
      return theme.diff.add;
    case "delete":
      return theme.diff.del;
    case "error":
      return theme.status.error;
    case "normal":
      return undefined;
  }
}

/** One stable tool row from execution start through persisted history replay. */
export function ToolCallBlock({ view, detailed }: ToolCallBlockProps): React.ReactElement {
  const args = view.args;
  const status: ToolStatus = view.status;
  const resultText = view.resultText ?? view.partialText ?? "";
  const action = toolAction(view.name, args, view.tool.label);
  const summary = toolResultSummary({ name: view.name, args, status, resultText });
  const detailLines = detailed
    ? truncateDetailLines(toolDetailLines({ name: view.name, args, status, resultText }))
    : [];
  const statusColor =
    status === "error" || status === "cancelled"
      ? theme.status.error
      : status === "done"
        ? theme.status.success
        : theme.status.running;

  return (
    <Box flexDirection="column">
      <Text>
        <Text color={statusColor}>
          {status === "running" ? (
            <Spinner color={statusColor} />
          ) : status === "error" || status === "cancelled" ? (
            icons.error
          ) : (
            icons.success
          )}
        </Text>{" "}
        <Text bold>{action.action}</Text>
        {action.target ? <Text color={theme.text.muted}> {action.target}</Text> : null}
      </Text>
      {summary ? (
        <Text
          color={
            status === "error" || status === "cancelled" ? theme.status.error : theme.text.muted
          }
        >
          {icons.guide} {summary}
        </Text>
      ) : null}
      {detailLines.length > 0 ? (
        <Box flexDirection="column" paddingLeft={2}>
          {detailLines.map((line, index) => (
            <Text key={index} color={detailColor(line.kind)}>
              {index === 0 ? icons.bracket : " "} {line.text || " "}
            </Text>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}
