import { useState } from "react";
import { Text, Box, useInput, render } from "ink";
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
    <Box flexDirection="column" marginTop={1}>
      <Text bold>Project trust</Text>
      <Text color={theme.dim}>
        This folder contains a `.novi/` with project-level settings, skills,
        prompts, or a custom models file.
      </Text>
      <Text color={theme.dim}>Working directory: {cwd}</Text>
      <Text> </Text>
      {OPTIONS.map((o, i) => (
        <Text key={o.value} color={i === cursor ? theme.accent : undefined}>
          {i === cursor ? "› " : "  "}
          {o.label}
          {i === cursor ? <Text color={theme.dim}> — {o.hint}</Text> : null}
        </Text>
      ))}
      <Text> </Text>
      <Text color={theme.dim}>↑↓ navigate · Enter select · Esc/Ctrl-C abort</Text>
    </Box>
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
