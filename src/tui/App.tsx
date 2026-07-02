import { useRef, useState } from "react";
import { Text, useApp, useInput, render } from "ink";
import type { Models } from "@earendil-works/pi-ai";
import { useHarnessState } from "./useHarnessState.js";
import { MessageList } from "./MessageList.js";
import { StatusBar } from "./StatusBar.js";
import { InputBox } from "./InputBox.js";
import { SettingsForm } from "./SettingsForm.js";
import { FilePicker } from "./file-picker.js";
import { runCommand, type CommandContext } from "./commands.js";
import {
  createHarnessHandle,
  type HarnessHandle,
} from "./harness-handle.js";
import { insert, type EditorState } from "./editor-state.js";
import type { BootstrapResult } from "../bootstrap.js";

/** Overlay union: null = normal input; settings = form; filePicker = @file. */
type Overlay = null | { kind: "settings" } | { kind: "filePicker" };

interface AppProps {
  /** Initial handle; App re-binds replace to its own setState in a useState init. */
  initialHandle: HarnessHandle;
  models: Models;
  sessionsDir: string;
  env: BootstrapResult["env"];
  cwd: string;
  systemPrompt: BootstrapResult["systemPrompt"];
  resolvedSettings: BootstrapResult["resolvedSettings"];
  cliOverrides: BootstrapResult["cliOverrides"];
}

function App({
  initialHandle,
  models,
  sessionsDir,
  env,
  cwd,
  systemPrompt,
  resolvedSettings,
  cliOverrides,
}: AppProps): React.ReactElement {
  // ref so the handle created in the useState initializer can reach it.
  // setHandle is assigned immediately after useState returns, well before any
  // replace() call, so the closure never sees a null ref in practice.
  const setHandleRef = useRef<((h: HarnessHandle) => void) | null>(null);

  const [handle, setHandle] = useState<HarnessHandle>(() =>
    createHarnessHandle(
      {
        harness: initialHandle.harness,
        session: initialHandle.session,
        sessionPath: initialHandle.sessionPath,
      },
      {
        env,
        models,
        cwd,
        systemPrompt,
        setHandle: (h) => setHandleRef.current?.(h),
      },
    ),
  );
  setHandleRef.current = setHandle;
  void initialHandle;

  const state = useHarnessState(handle.harness, handle.session);
  const { exit } = useApp();
  const [notice, setNotice] = useState<string[]>([]);
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [settings, setSettings] = useState(resolvedSettings);
  const [editorState, setEditorState] = useState<EditorState>({ text: "", cursor: 0 });

  const print = (text: string): void => {
    setNotice(text.split("\n"));
  };

  const commandCtx: CommandContext = {
    harness: handle.harness,
    models,
    session: handle.session,
    sessionsDir,
    isIdle: state.phase === "idle",
    exit: () => {
      exit();
      process.exit(0);
    },
    print,
    handle,
    setOverlay,
    env,
    cwd,
    systemPrompt,
    cliOverrides,
    setSettings,
  };

  function handlePrompt(text: string): void {
    handle.harness.prompt(text).catch((e) => {
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

  // Ctrl-C aborts the current turn / exits. When an overlay is open, Ctrl-C
  // closes the overlay instead.
  useInput((value, key) => {
    if (key.ctrl && value === "c") {
      if (overlay !== null) {
        setOverlay(null);
        return;
      }
      void handle.harness.abort().finally(() => {
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
      {overlay === null ? (
        <InputBox
          phase={state.phase}
          cwd={cwd}
          env={env}
          state={editorState}
          setState={setEditorState}
          onPrompt={handlePrompt}
          onCommand={(t) => void handleCommand(t)}
          onOpenFilePicker={() => setOverlay({ kind: "filePicker" })}
          onNotice={print}
        />
      ) : overlay.kind === "settings" ? (
        <SettingsForm
          settings={settings}
          env={env}
          cwd={cwd}
          cliOverrides={cliOverrides}
          onSaved={(updated) => setSettings(updated)}
          onExit={() => setOverlay(null)}
          onReload={() => void handle.replace({ reloadResources: true })}
        />
      ) : overlay.kind === "filePicker" ? (
        <FilePicker
          cwd={cwd}
          env={env}
          initialQuery=""
          onInsert={(filePath) => {
            setEditorState((prev) => insert(prev, filePath));
            setOverlay(null);
          }}
          onCancel={() => setOverlay(null)}
        />
      ) : null}
      <Text dimColor>session: {handle.sessionPath}</Text>
      <Text dimColor>/help for commands · Ctrl-C to exit</Text>
    </>
  );
}

export function renderApp(bootstrapResult: BootstrapResult, sessionsDir: string): void {
  const {
    env,
    models,
    session,
    sessionPath,
    harness,
    cwd,
    systemPrompt,
    resolvedSettings,
    cliOverrides,
  } = bootstrapResult;

  // Build the initial handle. Its replace closure is rebound inside App's
  // useState initializer to call the component's setState, so this initial
  // handle is only used to seed the first render.
  const initialHandle = createHarnessHandle(
    { harness, session, sessionPath },
    {
      env,
      models,
      cwd,
      systemPrompt,
      setHandle: () => {
        // Rebound inside App; no-op here.
      },
    },
  );

  render(
    <App
      initialHandle={initialHandle}
      models={models}
      sessionsDir={sessionsDir}
      env={env}
      cwd={cwd}
      systemPrompt={systemPrompt}
      resolvedSettings={resolvedSettings}
      cliOverrides={cliOverrides}
    />,
  );
}
