import { useEffect, useMemo, useRef, useState } from "react";
import { Text, useApp, useInput, render, useStdout } from "ink";
import type { Models } from "@earendil-works/pi-ai";
import { JsonlSessionRepo } from "@earendil-works/pi-agent-core/node";
import type { JsonlSessionMetadata } from "@earendil-works/pi-agent-core/node";
import { useHarnessState } from "./useHarnessState.js";
import { resolveCompactionSettings } from "../compaction.js";
import { MessageList } from "./MessageList.js";
import { StatusBar } from "./StatusBar.js";
import { InputBox } from "./InputBox.js";
import { SettingsForm } from "./SettingsForm.js";
import { FilePicker } from "./file-picker.js";
import { SessionPicker } from "./SessionPicker.js";
import { ModelPicker } from "./ModelPicker.js";
import { PermissionPrompt } from "./PermissionPrompt.js";
import { runCommand, nextThinkingLevel, type CommandContext, type Overlay } from "./commands.js";
import {
  createHarnessHandle,
  type HarnessHandle,
} from "./harness-handle.js";
import { insert, type EditorState } from "./editor-state.js";
import { messageText, restoreText } from "./queue-helpers.js";
import { matchScopedModels, nextScopedIndex } from "./scoped-models.js";
import type { BootstrapResult } from "../bootstrap.js";
import type { TuiApprover, PermissionPromptState } from "../permissions/index.js";
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
  scopedModels: string[];
  /** Process-lifetime flags for permission re-resolve on /reload. */
  yes: boolean;
  settingsLayers: BootstrapResult["settingsLayers"];
  /** Interactive Approver (shared with bootstrap gate). */
  tuiApprover: TuiApprover | undefined;
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
  scopedModels,
  yes,
  settingsLayers,
  tuiApprover,
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
        trusted: initialHandle.trusted,
        permissionGate: initialHandle.permissionGate,
        permissionStore: initialHandle.permissionStore,
      },
      {
        env,
        models,
        cwd,
        systemPrompt,
        setHandle: (h) => setHandleRef.current?.(h),
        yes,
        approver: tuiApprover,
        permissionStore: initialHandle.permissionStore,
        permissionGate: initialHandle.permissionGate,
        settingsLayers,
      },
    ),
  );
  setHandleRef.current = setHandle;
  void initialHandle;

  const [settings, setSettings] = useState(resolvedSettings);
  const compactionSettings = useMemo(() => resolveCompactionSettings(settings), [settings]);

  const state = useHarnessState(handle.harness, handle.session, compactionSettings);
  const { exit } = useApp();
  const terminalWidth = useStdout().stdout?.columns ?? 80;
  const [notice, setNotice] = useState<string[]>([]);
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [editorState, setEditorState] = useState<EditorState>({ text: "", cursor: 0 });
  const [toolExpanded, setToolExpanded] = useState(false);
  const [inputHistory, setInputHistory] = useState<string[]>([]);
  const [historyBrowse, setHistoryBrowse] = useState<{
    index: number;
    savedText: string;
  } | null>(null);
  const [permissionPrompt, setPermissionPrompt] = useState<PermissionPromptState | null>(null);

  // Subscribe to TUI Approver prompts (lifecycle = process; store survives replace).
  useEffect(() => {
    if (!tuiApprover) return;
    return tuiApprover.subscribe(setPermissionPrompt);
  }, [tuiApprover]);

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
    settings,
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
    // Pending permission prompts resolve as deny on abort (fail-closed).
    tuiApprover?.denyAll();
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

  /** Ctrl+P / Shift+Ctrl+P: cycle scoped models (settings.scopedModels). */
  function handleCycleScopedModel(reverse: boolean): void {
    if (scopedModels.length === 0) {
      print("No scoped models configured. Set scopedModels in /settings.");
      return;
    }
    // Build the full configured-provider model list (same logic as /model).
    void (async () => {
      try {
        const all: { provider: string; id: string }[] = [];
        for (const provider of models.getProviders()) {
          const providerModels = models.getModels(provider.id);
          if (providerModels.length === 0) continue;
          const auth = await models.getAuth(providerModels[0]!);
          if (!auth) continue;
          for (const m of providerModels) all.push({ provider: provider.id, id: m.id });
        }
        const scoped = matchScopedModels(scopedModels, all);
        if (scoped.length === 0) {
          print("No models match the scopedModels patterns.");
          return;
        }
        const current = handle.harness.getModel();
        const currentIdx = scoped.findIndex(
          (e) => e.provider === current.provider && e.id === current.id,
        );
        const start = currentIdx >= 0 ? currentIdx : 0;
        const nextIdx = nextScopedIndex(start, scoped.length, reverse);
        const target = scoped[nextIdx]!;
        const model = models.getModel(target.provider, target.id);
        if (!model) {
          print(`Scoped model not found: ${target.provider}/${target.id}`);
          return;
        }
        await handle.harness.setModel(model);
        print(`Model: ${target.provider}/${target.id}`);
      } catch (e) {
        print(`Switch failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    })();
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
  // Ctrl-P / Shift-Ctrl-P cycle scoped models.
  useInput((value, key) => {
    if (key.ctrl && value === "o") {
      setToolExpanded((v) => !v);
      return;
    }
    if (key.ctrl && value === "p") {
      handleCycleScopedModel(key.shift);
      return;
    }
    if (key.ctrl && value === "c") {
      if (permissionPrompt !== null) {
        tuiApprover?.denyAll();
        return;
      }
      if (overlay !== null) {
        setOverlay(null);
        return;
      }
      tuiApprover?.denyAll();
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
      {permissionPrompt !== null && tuiApprover ? (
        <PermissionPrompt
          prompt={permissionPrompt}
          onChoose={(choice) => tuiApprover.respond(choice)}
        />
      ) : overlay === null ? (
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
          terminalWidth={terminalWidth}
        />
      ) : overlay.kind === "settings" ? (
        <SettingsForm
          settings={settings}
          env={env}
          cwd={cwd}
          cliOverrides={cliOverrides}
          onSaved={(updated) => setSettings(updated)}
          onExit={() => setOverlay(null)}
          onReload={() => {
            void (async () => {
              // Match /reload: re-read layers so permissions re-resolve correctly.
              const { loadSettings, resolveSettings } = await import("../settings.js");
              const loaded = await loadSettings(env, cwd, { includeProject: handle.trusted });
              const newResolved = resolveSettings(loaded.merged, loaded.layers, cliOverrides);
              setSettings(newResolved);
              const { diagnostics } = await handle.replace({
                reloadResources: true,
                resolvedSettings: newResolved,
                settingsLayers: loaded.layers,
              });
              for (const d of diagnostics) print(`warning: ${d}`);
            })();
          }}
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
                const { diagnostics } = await handle.replace({ session, sessionPath: info.path, reloadResources: true });
                setOverlay(null);
                for (const d of diagnostics) print(`warning: ${d}`);
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
      <Text color={theme.dim}>{divider(terminalWidth)}</Text>
      <StatusBar
        model={state.model}
        thinkingLevel={state.thinkingLevel}
        lastUsage={state.lastUsage}
        cumulativeUsage={state.cumulativeUsage}
      />
      <Text color={theme.dim}>session: {handle.sessionPath}</Text>
      <Text color={theme.dim}>
        /help for commands · Ctrl-C to exit · Ctrl-O: {toolExpanded ? "collapse" : "expand"}
      </Text>
    </>
  );
}

export function renderApp(
  bootstrapResult: BootstrapResult,
  sessionsDir: string,
  tuiApprover?: TuiApprover,
): void {
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
    {
      harness,
      session,
      sessionPath,
      trusted: bootstrapResult.trusted,
      permissionGate: bootstrapResult.permissionGate,
      permissionStore: bootstrapResult.permissionStore,
    },
    {
      env,
      models,
      cwd,
      systemPrompt,
      setHandle: () => {
        // Rebound inside App; no-op here.
      },
      yes: bootstrapResult.yes,
      approver: tuiApprover,
      permissionStore: bootstrapResult.permissionStore,
      permissionGate: bootstrapResult.permissionGate,
      settingsLayers: bootstrapResult.settingsLayers,
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
      scopedModels={bootstrapResult.scopedModels}
      yes={bootstrapResult.yes}
      settingsLayers={bootstrapResult.settingsLayers}
      tuiApprover={tuiApprover}
    />,
  );
}
