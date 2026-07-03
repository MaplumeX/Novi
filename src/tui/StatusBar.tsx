import { Text, Box } from "ink";
import type { HarnessState } from "./useHarnessState.js";
import { formatUsageBar } from "./usage.js";
import { theme } from "./theme.js";

type StatusBarProps = Pick<
  HarnessState,
  "model" | "thinkingLevel" | "lastUsage" | "cumulativeUsage"
>;

/** Single status line driven entirely by `HarnessState` (never raw events). */
export function StatusBar({
  model,
  thinkingLevel,
  lastUsage,
  cumulativeUsage,
}: StatusBarProps): React.ReactElement {
  const usageBar = formatUsageBar(
    lastUsage,
    cumulativeUsage,
    model.contextWindow ?? 0,
  );
  return (
    <Box>
      <Text> {model.provider}/{model.id}</Text>
      <Text color={theme.dim}> │ think:{thinkingLevel} │ </Text>
      <Text>{usageBar}</Text>
    </Box>
  );
}
