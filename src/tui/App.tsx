import { useState } from "react";
import { Text, useApp, useInput, render } from "ink";
import type { AgentHarness } from "@earendil-works/pi-agent-core/node";
import { useHarnessState } from "./useHarnessState.js";

interface AppProps {
  harness: AgentHarness;
  sessionPath: string;
}

function App({ harness, sessionPath }: AppProps) {
  const { streamingText, phase } = useHarnessState(harness);
  const [input, setInput] = useState("");
  const { exit } = useApp();

  async function submit(): Promise<void> {
    const text = input.trim();
    if (!text || phase !== "idle") {
      return;
    }
    setInput("");
    // Fire and forget; the subscribe hook drives all rendering. Errors here
    // surface as the harness emitting an assistant message with stopReason
    // "error"; child 2 will wire richer error UI.
    harness.prompt(text).catch(() => {
      /* surfaced via events in later children */
    });
  }

  // Ink enables raw mode while the app is mounted, so Ctrl-C arrives here as a
  // key event instead of SIGINT. Abort the harness, then exit cleanly.
  useInput((value, key) => {
    if (key.ctrl && value === "c") {
      void harness.abort().finally(() => {
        exit();
        process.exit(0);
      });
      return;
    }
    if (key.return) {
      void submit();
      return;
    }
    if (key.backspace || key.delete) {
      setInput((prev) => prev.slice(0, -1));
      return;
    }
    // Ignore other control sequences; accumulate printable chars.
    if (value && !key.ctrl && !key.meta) {
      setInput((prev) => prev + value);
    }
  });

  return (
    <>
      {streamingText.length > 0 ? (
        <Text>{streamingText}</Text>
      ) : (
        <Text dimColor>(no output yet)</Text>
      )}
      <Text> </Text>
      <Text>
        {phase === "turn" ? (
          <Text dimColor>working…</Text>
        ) : (
          <Text>
            <Text dimColor>› </Text>
            {input}
            <Text dimColor>▏</Text>
          </Text>
        )}
      </Text>
      <Text dimColor>session: {sessionPath}</Text>
      <Text dimColor>Ctrl-C to exit</Text>
    </>
  );
}

export function renderApp(harness: AgentHarness, sessionPath: string): void {
  render(<App harness={harness} sessionPath={sessionPath} />);
}
