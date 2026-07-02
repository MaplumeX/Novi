import { Text, Box } from "ink";
import type { HarnessState } from "./useHarnessState.js";
import { formatUsageBar } from "./usage.js";
import { theme } from "./theme.js";

type StatusBarProps = Pick<
  HarnessState,
  "phase" | "model" | "thinkingLevel" | "activeToolNames" | "queue" | "lastUsage" | "cumulativeUsage"
>;

/** Single status line driven entirely by `HarnessState` (never raw events). */
export function StatusBar({
  phase,
  model,
  thinkingLevel,
  activeToolNames,
  queue,
  lastUsage,
  cumulativeUsage,
}: StatusBarProps): React.ReactElement {
  const queueLen = queue.steer.length + queue.followUp.length + queue.nextTurn.length;
  const usageBar = formatUsageBar(
    lastUsage,
    cumulativeUsage,
    model.contextWindow ?? 0,
  );
  const isActive = phase !== "idle";
  const statusColor = isActive ? theme.status.active : theme.status.idle;
  const statusIcon = isActive ? "◉" : "●";
  return (
    <Box>
      <Text color={statusColor}>{statusIcon}</Text>
      <Text color={theme.dim}> {phase} </Text>
      <Text color={theme.dim}>│</Text>
      <Text> {model.provider}/{model.id}</Text>
      <Text color={theme.dim}> │ think:{thinkingLevel} </Text>
      <Text color={theme.dim}>│</Text>
      <Text> ⚙{activeToolNames.length}</Text>
      <Text color={theme.dim}> ⏵{queueLen}</Text>
      {queueLen > 0 ? (
        <Text color={theme.dim}>
          {" "}
          (s{queue.steer.length} f{queue.followUp.length} n{queue.nextTurn.length})
        </Text>
      ) : null}
      <Text color={theme.dim}> │ </Text>
      <Text>{usageBar}</Text>
    </Box>
  );
}
