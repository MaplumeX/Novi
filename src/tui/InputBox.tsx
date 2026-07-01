import { useState } from "react";
import { Text, useInput } from "ink";
import type { Phase } from "./useHarnessState.js";

interface InputBoxProps {
  phase: Phase;
  onPrompt: (text: string) => void;
  onCommand: (text: string) => void;
}

/**
 * Single-line-aware input with optional multi-line (Shift+Enter). Enter submits.
 * Lines starting with `/` are routed to `onCommand`; everything else to
 * `onPrompt`. While a turn is running, plain prompts are not sent — a
 * "working…" hint is shown instead — but commands (e.g. `/abort`) still run.
 *
 * Shift+Enter multi-line support is best-effort: terminals that don't
 * distinguish Shift+Enter degrade to single-line, which satisfies the AC.
 */
export function InputBox({ phase, onPrompt, onCommand }: InputBoxProps): React.ReactElement {
  const [input, setInput] = useState("");

  function submit(): void {
    const text = input.trim();
    setInput("");
    if (!text) return;
    if (text.startsWith("/")) {
      onCommand(text);
      return;
    }
    if (phase !== "idle") {
      // Commands remain usable during a turn; plain prompts are held back.
      return;
    }
    onPrompt(text);
  }

  useInput((value, key) => {
    if (key.return) {
      if (key.shift) {
        setInput((prev) => `${prev}\n`);
      } else {
        submit();
      }
      return;
    }
    if (key.backspace || key.delete) {
      setInput((prev) => prev.slice(0, -1));
      return;
    }
    if (!value || key.ctrl || key.meta) return;
    // Accumulate printable chars; newlines from paste are preserved.
    setInput((prev) => prev + value);
  });

  const busyHint = phase !== "idle" && !input.startsWith("/")
    ? " (working…)"
    : "";

  return (
    <Text>
      <Text dimColor>› </Text>
      {input}
      <Text dimColor>▏</Text>
      {busyHint ? <Text dimColor>{busyHint}</Text> : null}
    </Text>
  );
}
