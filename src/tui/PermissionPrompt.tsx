import { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { ApprovalChoice } from "../permissions/types.js";
import type { PermissionPromptState } from "../permissions/tui-approver.js";
import { Panel } from "./components/Panel.js";
import { SelectionRow } from "./components/SelectionRow.js";

interface PermissionPromptProps {
  prompt: PermissionPromptState;
  onChoose: (choice: ApprovalChoice) => void;
}

const ALL_OPTIONS: { value: ApprovalChoice; label: string; key: string }[] = [
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
  const options = prompt.sessionGrantAvailable
    ? ALL_OPTIONS
    : ALL_OPTIONS.filter((option) => option.value !== "session");

  useEffect(() => setCursor(0), [prompt.toolCallId, prompt.target]);

  useInput((value, key) => {
    if (key.upArrow) {
      setCursor((c) => (c - 1 + options.length) % options.length);
      return;
    }
    if (key.downArrow) {
      setCursor((c) => (c + 1) % options.length);
      return;
    }
    if (key.return) {
      onChoose(options[cursor]!.value);
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
    if (value === "2" && prompt.sessionGrantAvailable) {
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
      description={`${prompt.capability} · ${prompt.scope}${prompt.source?.kind === "agent-run" ? ` · agent ${prompt.source.label ?? prompt.source.runId} (${prompt.source.profile})` : ""}`}
      footer={
        prompt.sessionGrantAvailable
          ? "1/2/3 choose · ↑↓ navigate · Enter confirm · Esc deny"
          : "1/3 choose · session grant unavailable · ↑↓ navigate · Enter confirm · Esc deny"
      }
      tone="warning"
    >
      <Box flexDirection="column">
        <Text>Target: {prompt.target}</Text>
        <Text>Reason: {prompt.reason}</Text>
        <Text>Summary: {prompt.summary}</Text>
        {prompt.shellBoundaryWarning ? (
          <Text color="yellow">
            Warning: shell approval is not a filesystem sandbox; the command and its children may
            access paths outside the workspace.
          </Text>
        ) : null}
        {options.map((option, index) => (
          <SelectionRow key={option.value} selected={index === cursor} shortcut={option.key}>
            {option.label}
          </SelectionRow>
        ))}
      </Box>
    </Panel>
  );
}
