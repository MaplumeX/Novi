import path from "node:path";
import { Box, Text } from "ink";
import type { HarnessState } from "./useHarnessState.js";
import { formatUsageBar } from "./usage.js";
import { icons, theme } from "./theme.js";

interface StatusBarProps extends Pick<
  HarnessState,
  "model" | "thinkingLevel" | "lastUsage" | "cumulativeUsage"
> {
  sessionPath: string;
  detailed: boolean;
  agentRuns?: { queued: number; running: number };
}

/** Compact footer for runtime context and the one global transcript toggle. */
export function StatusBar({
  model,
  thinkingLevel,
  lastUsage,
  cumulativeUsage,
  sessionPath,
  detailed,
  agentRuns,
}: StatusBarProps): React.ReactElement {
  const usageBar = formatUsageBar(lastUsage, cumulativeUsage, model.contextWindow ?? 0);
  const sessionName = path.basename(sessionPath);
  return (
    <Box paddingX={1}>
      <Text color={theme.text.muted} wrap="wrap">
        {model.provider}/{model.id} {icons.mode} think:{thinkingLevel} {icons.mode} {usageBar}{" "}
        {icons.mode} session:{sessionName} {icons.mode} Ctrl-O{" "}
        {agentRuns && agentRuns.queued + agentRuns.running > 0
          ? `agents:${agentRuns.running} running/${agentRuns.queued} queued ${icons.mode} `
          : ""}
        {detailed ? "hide details" : "show details"} {icons.mode} /help
      </Text>
    </Box>
  );
}
