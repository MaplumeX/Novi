import { Text, Box } from "ink";
import type { HarnessState } from "./useHarnessState.js";

type StatusBarProps = Pick<
  HarnessState,
  "phase" | "model" | "thinkingLevel" | "activeToolNames" | "queue"
>;

/** Single status line driven entirely by `HarnessState` (never raw events). */
export function StatusBar({
  phase,
  model,
  thinkingLevel,
  activeToolNames,
  queue,
}: StatusBarProps): React.ReactElement {
  const queueLen = queue.steer.length + queue.followUp.length + queue.nextTurn.length;
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
    </Box>
  );
}
