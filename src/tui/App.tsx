import { useState } from "react";
import { Text, useApp, useInput, render } from "ink";
import type { AgentHarness } from "@earendil-works/pi-agent-core/node";
import type { Session, JsonlSessionMetadata } from "@earendil-works/pi-agent-core/node";
import type { Models } from "@earendil-works/pi-ai";
import { useHarnessState } from "./useHarnessState.js";
import { MessageList } from "./MessageList.js";
import { StatusBar } from "./StatusBar.js";
import { InputBox } from "./InputBox.js";
import { runCommand, type CommandContext } from "./commands.js";

interface AppProps {
  harness: AgentHarness;
  session: Session<JsonlSessionMetadata>;
  sessionPath: string;
  models: Models;
  sessionsDir: string;
}

function App({ harness, session, sessionPath, models, sessionsDir }: AppProps) {
  const state = useHarnessState(harness, session);
  const { exit } = useApp();
  const [notice, setNotice] = useState<string[]>([]);

  const print = (text: string): void => {
    setNotice(text.split("\n"));
  };

  const commandCtx: CommandContext = {
    harness,
    models,
    sessionsDir,
    isIdle: state.phase === "idle",
    exit: () => {
      exit();
      process.exit(0);
    },
    print,
  };

  function handlePrompt(text: string): void {
    // Idle guarantees are enforced by InputBox; just dispatch.
    harness.prompt(text).catch((e) => {
      print(`Prompt failed: ${e instanceof Error ? e.message : String(e)}`);
    });
  }

  async function handleCommand(text: string): Promise<void> {
    try {
      await runCommand(text, commandCtx);
    } catch (e) {
      print(`Command failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Ctrl-C aborts the current turn / exits. Text input is handled by InputBox.
  useInput((value, key) => {
    if (key.ctrl && value === "c") {
      void harness.abort().finally(() => {
        exit();
        process.exit(0);
      });
    }
  });

  return (
    <>
      <MessageList
        messages={state.messages}
        streamingText={state.streamingText}
        streamingToolCalls={state.streamingToolCalls}
      />
      {notice.length > 0
        ? notice.map((line, i) => (
            <Text key={i} dimColor>
              {line || " "}
            </Text>
          ))
        : null}
      <StatusBar
        phase={state.phase}
        model={state.model}
        thinkingLevel={state.thinkingLevel}
        activeToolNames={state.activeToolNames}
        queue={state.queue}
      />
      <InputBox phase={state.phase} onPrompt={handlePrompt} onCommand={(t) => void handleCommand(t)} />
      <Text dimColor>session: {sessionPath}</Text>
      <Text dimColor>/help for commands · Ctrl-C to exit</Text>
    </>
  );
}

export function renderApp(
  harness: AgentHarness,
  session: Session<JsonlSessionMetadata>,
  sessionPath: string,
  models: Models,
  sessionsDir: string,
): void {
  render(
    <App
      harness={harness}
      session={session}
      sessionPath={sessionPath}
      models={models}
      sessionsDir={sessionsDir}
    />,
  );
}
