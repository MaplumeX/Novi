import { useRef, useState } from "react";
import { Text, useApp, useInput, render } from "ink";
import type { Models } from "@earendil-works/pi-ai";
import { JsonlSessionRepo } from "@earendil-works/pi-agent-core/node";
import type { JsonlSessionMetadata } from "@earendil-works/pi-agent-core/node";
import { useHarnessState } from "./useHarnessState.js";
import { MessageList } from "./MessageList.js";
import { StatusBar } from "./StatusBar.js";
import { InputBox } from "./InputBox.js";
import { SettingsForm } from "./SettingsForm.js";
import { FilePicker } from "./file-picker.js";
import { SessionPicker } from "./SessionPicker.js";
import { ModelPicker } from "./ModelPicker.js";
import { runCommand, nextThinkingLevel, type CommandContext, type Overlay } from "./commands.js";
import {
  createHarnessHandle,
  type HarnessHandle,
} from "./harness-handle.js";
import { insert, type EditorState } from "./editor-state.js";
import { messageText, restoreText } from "./queue-helpers.js";
import type { BootstrapResult } from "../bootstrap.js";
import { theme, divider } from "./theme.js";

/** Overlay union: null = normal input; settings = form; filePicker = @file; sessionPicker = /resume. */
// Type re-exported from commands.ts to keep the variants in one place.

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
  const [toolExpanded, setToolExpanded] = useState(false);
  const [inputHistory, setInputHistory] = useState<string[]>([]);
  const [historyBrowse, setHistoryBrowse] = useState<{
    index: number;
    savedText: string;
  } | null>(null);

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
    queue: state.queue,
  };

  function recordHistory(text: string): void {
    setInputHistory((prev) => [...prev, text]);
    setHistoryBrowse(null);
  }

  function handlePrompt(text: string): void {
    recordHistory(text);
    handle.harness.prompt(text).catch((e) => {
      print(`Prompt failed: ${e instanceof Error ? e.message : String(e)}`);
    });
  }

  function handleSteer(text: string): void {
    recordHistory(text);
    handle.harness.steer(text).catch((e) => {
      print(`Steer failed: ${e instanceof Error ? e.message : String(e)}`);
    });
  }

  function handleFollowUp(text: string): void {
    recordHistory(text);
    handle.harness.followUp(text).catch((e) => {
      print(`FollowUp failed: ${e instanceof Error ? e.message : String(e)}`);
    });
  }

  /** Single-line non-slash mode ↑: load the previous history entry. */
  function handleHistoryUp(): void {
    if (inputHistory.length === 0) return;
    if (historyBrowse === null) {
      const index = inputHistory.length - 1;
      const text = inputHistory[index]!;
      setHistoryBrowse({ index, savedText: editorState.text });
      setEditorState({ text, cursor: text.length });
    } else if (historyBrowse.index > 0) {
      const index = historyBrowse.index - 1;
      const text = inputHistory[index]!;
      setHistoryBrowse({ ...historyBrowse, index });
      setEditorState({ text, cursor: text.length });
    }
  }

  /** Single-line non-slash mode ↓: load the next history entry or restore. */
  function handleHistoryDown(): void {
    if (historyBrowse === null) return;
    const index = historyBrowse.index + 1;
    if (index >= inputHistory.length) {
      setEditorState({ text: historyBrowse.savedText, cursor: historyBrowse.savedText.length });
      setHistoryBrowse(null);
    } else {
      const text = inputHistory[index]!;
      setHistoryBrowse({ ...historyBrowse, index });
      setEditorState({ text, cursor: text.length });
    }
  }

  /** Escape: abort + restore during a turn; clear the editor when idle; no-op in compaction. */
  async function handleEscapeAbort(): Promise<void> {
    if (state.phase === "compaction") return;
    if (state.phase !== "turn") {
      setEditorState({ text: "", cursor: 0 });
      return;
    }
    // Abort returns the steer/followUp messages that were cleared, so restore
    // them into the editor alongside any unsent text the user was still typing.
    try {
      const result = await handle.harness.abort();
      const queuedTexts = [
        ...result.clearedSteer.map(messageText),
        ...result.clearedFollowUp.map(messageText),
      ];
      setEditorState((prev) => {
        const combined = restoreText(queuedTexts, prev.text);
        return { text: combined, cursor: combined.length };
      });
    } catch (e) {
      print(`Abort failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Alt+Up: preview the last queued message into the editor (no real dequeue). */
  function handleAltUp(): void {
    const all = [
      ...state.queue.steer,
      ...state.queue.followUp,
      ...state.queue.nextTurn,
    ];
    if (all.length === 0) {
      print("Queue is empty.");
      return;
    }
    const last = all[all.length - 1]!;
    const text = messageText(last);
    setEditorState({ text, cursor: text.length });
  }

  /** Shift+Tab: cycle the thinking level (off→minimal→…→xhigh→off). */
  function handleCycleThinking(): void {
    const next = nextThinkingLevel(state.thinkingLevel);
    void handle.harness.setThinkingLevel(next);
    print(`Thinking: ${next}`);
  }

  async function handleCommand(text: string): Promise<void> {
    try {
      await runCommand(text, commandCtx);
    } catch (e) {
      print(`Command failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Ctrl-C aborts the current turn / exits. When an overlay is open, Ctrl-C
  // closes the overlay instead. Ctrl-O toggles tool call expansion.
  useInput((value, key) => {
    if (key.ctrl && value === "o") {
      setToolExpanded((v) => !v);
      return;
    }
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
        streamingThinking={state.streamingThinking}
        streamingToolCalls={state.streamingToolCalls}
        toolExpanded={toolExpanded}
      />
      {notice.length > 0
        ? notice.map((line, i) => (
            <Text key={i} color={theme.dim}>
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
        lastUsage={state.lastUsage}
        cumulativeUsage={state.cumulativeUsage}
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
          onSteer={handleSteer}
          onFollowUp={handleFollowUp}
          onCycleThinking={handleCycleThinking}
          onEscapeAbort={() => void handleEscapeAbort()}
          onAltUp={handleAltUp}
          onHistoryUp={handleHistoryUp}
          onHistoryDown={handleHistoryDown}
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
      ) : overlay.kind === "sessionPicker" ? (
        <SessionPicker
          sessions={overlay.sessions}
          onPick={(info) => {
            void (async () => {
              try {
                const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: sessionsDir });
                const session = await repo.open({ path: info.path } as JsonlSessionMetadata);
                await handle.replace({ session, sessionPath: info.path, reloadResources: true });
                setOverlay(null);
                print(`Resumed session: ${info.path}`);
              } catch (e) {
                setOverlay(null);
                print(`Resume failed: ${e instanceof Error ? e.message : String(e)}`);
              }
            })();
          }}
          onCancel={() => setOverlay(null)}
        />
      ) : overlay.kind === "modelPicker" ? (
        <ModelPicker
          models={overlay.models}
          currentIndex={overlay.currentIndex}
          onPick={(entry) => {
            void (async () => {
              try {
                const model = models.getModel(entry.provider, entry.id)!;
                await handle.harness.setModel(model);
                setOverlay(null);
                print(`Switched to ${entry.provider}/${entry.id}.`);
              } catch (e) {
                setOverlay(null);
                print(`Switch failed: ${e instanceof Error ? e.message : String(e)}`);
              }
            })();
          }}
          onCancel={() => setOverlay(null)}
        />
      ) : null}
      <Text color={theme.dim}>{divider()}</Text>
      <Text color={theme.dim}>session: {handle.sessionPath}</Text>
      <Text color={theme.dim}>
        /help for commands · Ctrl-C to exit · Ctrl-O: {toolExpanded ? "collapse" : "expand"}
      </Text>
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
