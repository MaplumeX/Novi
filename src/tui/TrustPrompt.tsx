import { useState } from "react";
import { Box, Text, useInput, render } from "ink";
import { Panel } from "./components/Panel.js";
import { SelectionRow } from "./components/SelectionRow.js";
import { theme } from "./theme.js";

/** The user's choice from the trust prompt. */
export type TrustChoice = "once" | "always" | "never" | "abort";

interface TrustPromptProps {
  cwd: string;
  onChoose: (choice: TrustChoice) => void;
}

const OPTIONS: { value: TrustChoice; label: string; hint: string }[] = [
  { value: "once", label: "Trust once", hint: "load this session only" },
  { value: "always", label: "Always trust", hint: "save for this folder + parent" },
  { value: "never", label: "Never trust", hint: "save; skip project resources" },
  { value: "abort", label: "Abort", hint: "exit Novi" },
];

/**
 * Standalone trust prompt overlay (rendered before the main app, mirroring the
 * `OnboardingWizard` render pattern). Shows the cwd and offers four choices.
 *
 * This is NOT an in-App overlay: it runs in its own `render()` instance so the
 * decision is made before `bootstrap()` is called.
 */
export function TrustPrompt({ cwd, onChoose }: TrustPromptProps): React.ReactElement {
  const [cursor, setCursor] = useState(0);

  useInput((_value, key) => {
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
      onChoose("abort");
      return;
    }
    if (key.ctrl && _value === "c") {
      onChoose("abort");
      return;
    }
  });

  return (
    <Panel
      title="Project trust"
      description="This folder can load project settings, skills, prompts, and model configuration."
      footer="↑↓ navigate · Enter select · Esc/Ctrl-C abort"
      tone="warning"
    >
      <Box flexDirection="column">
        <Text color={theme.text.muted}>Working directory: {cwd}</Text>
        <Text> </Text>
        {OPTIONS.map((option, index) => (
          <SelectionRow
            key={option.value}
            selected={index === cursor}
            description={index === cursor ? option.hint : undefined}
          >
            {option.label}
          </SelectionRow>
        ))}
      </Box>
    </Panel>
  );
}

/**
 * Render the trust prompt standalone and await the user's decision.
 *
 * Mirrors `renderOnboardingWizard`: own `render()` instance, resolves on choice.
 */
export function renderTrustPrompt(cwd: string): Promise<TrustChoice> {
  return new Promise<TrustChoice>((resolve) => {
    let resolved = false;
    const instance = render(
      <TrustPrompt
        cwd={cwd}
        onChoose={(choice) => {
          if (resolved) return;
          resolved = true;
          instance.unmount();
          resolve(choice);
        }}
      />,
    );
  });
}
