import { useState } from "react";
import { Box, useInput } from "ink";
import type { ApprovalChoice } from "../permissions/types.js";
import type { PermissionPromptState } from "../permissions/tui-approver.js";
import { Panel } from "./components/Panel.js";
import { SelectionRow } from "./components/SelectionRow.js";

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
export function PermissionPrompt({ prompt, onChoose }: PermissionPromptProps): React.ReactElement {
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
    <Panel
      title={`Allow ${prompt.toolName}?`}
      description={prompt.summary}
      footer="1/2/3 choose · ↑↓ navigate · Enter confirm · Esc deny"
      tone="warning"
    >
      <Box flexDirection="column">
        {OPTIONS.map((option, index) => (
          <SelectionRow key={option.value} selected={index === cursor} shortcut={option.key}>
            {option.label}
          </SelectionRow>
        ))}
      </Box>
    </Panel>
  );
}
