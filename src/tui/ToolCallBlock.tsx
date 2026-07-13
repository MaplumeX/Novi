import { Box, Text } from "ink";
import type { AgentToolCall } from "@earendil-works/pi-agent-core/node";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { ToolCallView } from "./useHarnessState.js";
import {
  toolAction,
  toolDetailLines,
  toolResultMessageText,
  toolResultSummary,
  truncateDetailLines,
  type ToolDetailLine,
  type ToolStatus,
} from "./tool-presentation.js";
import { Spinner } from "./components/Spinner.js";
import { icons, theme } from "./theme.js";

interface ToolCallBlockProps {
  call: AgentToolCall;
  result?: ToolResultMessage;
  live?: ToolCallView;
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
export function ToolCallBlock({
  call,
  result,
  live,
  detailed,
}: ToolCallBlockProps): React.ReactElement {
  const args = call.arguments ?? live?.args ?? {};
  const status: ToolStatus = result
    ? result.isError
      ? "error"
      : "done"
    : (live?.status ?? "running");
  const resultText = result
    ? toolResultMessageText(result)
    : (live?.resultText ?? live?.partialText ?? "");
  const action = toolAction(call.name, args);
  const summary = toolResultSummary({ name: call.name, args, status, resultText });
  const detailLines = detailed
    ? truncateDetailLines(toolDetailLines({ name: call.name, args, status, resultText }))
    : [];
  const statusColor =
    status === "error"
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
          ) : status === "error" ? (
            icons.error
          ) : (
            icons.success
          )}
        </Text>{" "}
        <Text bold>{action.action}</Text>
        {action.target ? <Text color={theme.text.muted}> {action.target}</Text> : null}
      </Text>
      {summary ? (
        <Text color={status === "error" ? theme.status.error : theme.text.muted}>
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
