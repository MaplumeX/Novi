import { Text, Box } from "ink";
import type { HarnessState } from "./useHarnessState.js";
import { formatUsageBar } from "./usage.js";

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
  return (
    <Box>
      <Text dimColor>[</Text>
      <Text color={phase === "idle" ? "green" : "yellow"}>{phase}</Text>
      <Text dimColor>]</Text>
      <Text dimColor> model:</Text>
      <Text>{model.provider}/{model.id}</Text>
      <Text dimColor> thinking:</Text>
      <Text>{thinkingLevel}</Text>
      <Text dimColor> tools:</Text>
      <Text>{activeToolNames.length}</Text>
      <Text dimColor> queue:</Text>
      <Text>{queueLen}</Text>
      {queueLen > 0 ? (
        <Text dimColor>
          {" "}
          (s{queue.steer.length} f{queue.followUp.length} n{queue.nextTurn.length})
        </Text>
      ) : null}
      <Text dimColor> </Text>
      <Text>{usageBar}</Text>
    </Box>
  );
}
