import { useState } from "react";
import { Box, Text, useInput } from "ink";
import { theme } from "./theme.js";
import type { ApprovalChoice } from "../permissions/types.js";
import type { PermissionPromptState } from "../permissions/tui-approver.js";

interface PermissionPromptProps {
  prompt: PermissionPromptState;
  onChoose: (choice: ApprovalChoice) => void;
}

const OPTIONS: { value: ApprovalChoice; label: string; key: string }[] = [
  { value: "once", label: "Allow once", key: "1" },
  { value: "session", label: "Allow for this session", key: "2" },
  { value: "deny", label: "Deny", key: "3" },
];

/**
 * In-app overlay for tool permission confirmation.
 * Keys: 1/2/3 or ↑↓+Enter; Esc = Deny.
 */
export function PermissionPrompt({
  prompt,
  onChoose,
}: PermissionPromptProps): React.ReactElement {
  const [cursor, setCursor] = useState(0);

  useInput((value, key) => {
    if (key.upArrow) {
      setCursor((c) => (c - 1 + OPTIONS.length) % OPTIONS.length);
      return;
    }
    if (key.downArrow) {
      setCursor((c) => (c + 1) % OPTIONS.length);
      return;
    }
    if (key.return) {
      onChoose(OPTIONS[cursor]!.value);
      return;
    }
    if (key.escape) {
      onChoose("deny");
      return;
    }
    if (value === "1") {
      onChoose("once");
      return;
    }
    if (value === "2") {
      onChoose("session");
      return;
    }
    if (value === "3") {
      onChoose("deny");
      return;
    }
  });

  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={theme.accent} paddingX={1}>
      <Text bold color={theme.accent}>
        Allow tool: {prompt.toolName}
      </Text>
      <Text color={theme.dim}>{prompt.summary}</Text>
      <Text> </Text>
      {OPTIONS.map((o, i) => (
        <Text key={o.value} color={i === cursor ? theme.accent : undefined}>
          {i === cursor ? "› " : "  "}
          [{o.key}] {o.label}
        </Text>
      ))}
      <Text color={theme.dim}>1/2/3 or ↑↓+Enter · Esc = Deny</Text>
    </Box>
  );
}
