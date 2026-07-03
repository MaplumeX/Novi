import { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { ExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { Phase } from "./useHarnessState.js";
import {
  insert,
  backspace,
  deleteForward,
  moveLeft,
  moveRight,
  moveToLineStart,
  moveToLineEnd,
  moveLineUp,
  moveLineDown,
  deleteWordBackward,
  deleteWordForward,
  deleteToLineStart,
  deleteToLineEnd,
  type EditorState,
} from "./editor-state.js";
import { COMMANDS } from "./commands.js";
import { parseBang, runBang } from "./bang.js";
import { openExternalEditor } from "./external-editor.js";
import { loadFileCandidates } from "./file-picker.js";
import { theme, divider, icons } from "./theme.js";
import { Spinner } from "./components/Spinner.js";

interface InputBoxProps {
  phase: Phase;
  cwd: string;
  env: ExecutionEnv;
  /** Lifted editor state (owned by App so it survives overlay transitions). */
  state: EditorState;
  setState: React.Dispatch<React.SetStateAction<EditorState>>;
  onPrompt: (text: string) => void;
  onCommand: (text: string) => void;
  /** Open the filePicker overlay (called when user types `@`). */
  onOpenFilePicker: () => void;
  /** Surface a notice line (e.g. external editor / bang errors). */
  onNotice: (msg: string) => void;
  /** Steer the in-flight turn (called during phase "turn"). */
  onSteer: (text: string) => void;
  /** Queue a follow-up for after the turn completes (phase "turn"). */
  onFollowUp: (text: string) => void;
  /** Escape during a turn: abort + restore queued text to the editor. */
  onEscapeAbort: () => void;
  /** Alt+Up: preview the last queued message into the editor. */
  onAltUp: () => void;
  /** Single-line, non-slash mode: browse input history backwards. */
  onHistoryUp: () => void;
  /** Single-line, non-slash mode: browse input history forwards. */
  onHistoryDown: () => void;
  /** Shift+Tab: cycle the thinking level (off→minimal→…→xhigh→off). */
  onCycleThinking: () => void;
  /** Terminal width for full-width dividers. */
  terminalWidth: number;
}

/**
 * Full editor input box: cursor model, multi-line, Emacs keybindings,
 * `@file` trigger, `!`/`!!` shell bangs, Ctrl+G external editor, Tab path completion.
 *
 * Lines starting with `/` are routed to `onCommand`; bang-prefixed lines
 * (`!` / `!!`) are handled by {@link runBang}. During a turn, Enter steers
 * the in-flight response and Alt+Enter queues a follow-up; Escape aborts and
 * restores queued text. Commands and bangs remain usable in any phase.
 */
export function InputBox({
  phase,
  cwd,
  env,
  state,
  setState,
  onPrompt,
  onCommand,
  onOpenFilePicker,
  onNotice,
  onSteer,
  onFollowUp,
  onEscapeAbort,
  onAltUp,
  onHistoryUp,
  onHistoryDown,
  onCycleThinking,
  terminalWidth,
}: InputBoxProps): React.ReactElement {
  // --- Slash command list state ---
  const [slashSelectedIndex, setSlashSelectedIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);

  // Derive slash query from the text: text after "/" up to the first space.
  const slashQuery = state.text.startsWith("/")
    ? (state.text.slice(1).split(/\s/)[0] ?? "")
    : "";
  const matchedCommands = state.text.startsWith("/")
    ? slashQuery
      ? COMMANDS.filter((c) => c.name.toLowerCase().includes(slashQuery.toLowerCase()))
      : [...COMMANDS]
    : [];
  const slashListOpen = state.text.startsWith("/") && !slashDismissed;
  const slashActive = slashListOpen && matchedCommands.length > 0;

  // Args typed after the command name (everything from the first space).
  // Preserved across Enter/Tab so completion never silently drops user input.
  const firstSpaceIdx = state.text.indexOf(" ");
  const slashArgs = firstSpaceIdx >= 0 ? state.text.slice(firstSpaceIdx) : "";

  // Reset selection and dismissed flag when the query changes.
  useEffect(() => {
    setSlashSelectedIndex(0);
    setSlashDismissed(false);
  }, [slashQuery]);

  function submit(mode: "prompt" | "steer" | "followUp"): void {
    const text = state.text.trim();
    if (!text) {
      setState({ text: "", cursor: 0 });
      return;
    }

    // Bang (! / !!) and slash-commands work in any phase.
    const bang = parseBang(state.text.trimStart());
    if (bang.kind !== "none") {
      setState({ text: "", cursor: 0 });
      void runBang(bang, { env, cwd, onPrompt, print: onNotice });
      return;
    }

    if (text.startsWith("/")) {
      setState({ text: "", cursor: 0 });
      onCommand(text);
      return;
    }

    // Plain prompt: gated by phase. compaction is a no-op (do not clear the
    // editor). idle→prompt, turn→steer/followUp (per the submit mode).
    if (phase === "compaction") return;

    setState({ text: "", cursor: 0 });
    switch (mode) {
      case "prompt":
        onPrompt(text);
        break;
      case "steer":
        onSteer(text);
        break;
      case "followUp":
        onFollowUp(text);
        break;
    }
  }

  /** Extract the path token at cursor for Tab completion. */
  function pathTokenAtCursor(): { start: number; token: string } | null {
    const { text, cursor } = state;
    const before = text.slice(0, cursor);
    let start = before.length;
    while (start > 0) {
      const ch = before[start - 1]!;
      if (ch === "@") {
        start--;
        break;
      }
      if (/\s/.test(ch)) break;
      start--;
    }
    const token = before.slice(start);
    if (!token) return null;
    if (!token.includes("/") && !token.startsWith("@")) return null;
    return { start, token };
  }

  /** Tab: complete path to longest common prefix using glob candidates. */
  async function tabComplete(): Promise<void> {
    const info = pathTokenAtCursor();
    if (!info) return;
    const { start, token } = info;

    const query = token.startsWith("@") ? token.slice(1) : token;
    const candidates = await loadFileCandidates(cwd, query, env, 50);
    if (candidates.length === 0) return;

    const rels = candidates.map((c) => {
      const rel = c.startsWith(cwd) ? c.slice(cwd.length).replace(/^\//, "") : c;
      return rel || c;
    });

    if (rels.length === 1) {
      const replacement = token.startsWith("@") ? `@${rels[0]}` : rels[0]!;
      const cleared = { text: state.text.slice(0, start) + state.text.slice(state.cursor), cursor: start };
      setState(insert(cleared, replacement));
      return;
    }

    const prefix = longestCommonPrefix(rels);
    if (prefix.length > query.length) {
      const replacement = token.startsWith("@") ? `@${prefix}` : prefix;
      const cleared = { text: state.text.slice(0, start) + state.text.slice(state.cursor), cursor: start };
      setState(insert(cleared, replacement));
    } else {
      onOpenFilePicker();
    }
  }

  useInput((value, key) => {
    // --- Ctrl+G: external editor ---
    if (key.ctrl && value === "g") {
      void openExternalEditor(state.text)
        .then((content) => {
          const trimmed = content.replace(/\n$/, "");
          setState({ text: trimmed, cursor: trimmed.length });
        })
        .catch((e) => {
          onNotice(e instanceof Error ? e.message : String(e));
        });
      return;
    }

    // --- Emacs movement keys ---
    if (key.ctrl && !key.meta) {
      switch (value) {
        case "a": setState(moveToLineStart); return;
        case "e": setState(moveToLineEnd); return;
        case "b": setState((s) => moveLeft(s)); return;
        case "f": setState((s) => moveRight(s)); return;
        case "w": setState(deleteWordBackward); return;
        case "u": setState(deleteToLineStart); return;
        case "k": setState(deleteToLineEnd); return;
        case "j": setState((s) => insert(s, "\n")); return;
      }
    }

    // --- Alt (meta) keys ---
    if (key.meta && !key.ctrl) {
      if (value === "b") { setState((s) => moveLeft(s, true)); return; }
      if (value === "f") { setState((s) => moveRight(s, true)); return; }
      if (value === "d") { setState(deleteWordForward); return; }
      // Alt+Up: preview the last queued message into the editor (no real
      // dequeue — the harness still delivers it; see onAltUp in App.tsx).
      if (key.upArrow) { onAltUp(); return; }
      if (key.backspace) { setState(deleteWordBackward); return; }
    }

    // --- Arrow keys ---
    if (key.leftArrow) { setState((s) => moveLeft(s)); return; }
    if (key.rightArrow) { setState((s) => moveRight(s)); return; }
    // ↑/↓ three-state dispatch: slash list → multi-line → input history
    if (key.upArrow) {
      if (slashActive) {
        setSlashSelectedIndex((i) => (i - 1 + matchedCommands.length) % matchedCommands.length);
        return;
      }
      if (state.text.includes("\n")) { setState(moveLineUp); return; }
      onHistoryUp();
      return;
    }
    if (key.downArrow) {
      if (slashActive) {
        setSlashSelectedIndex((i) => (i + 1) % matchedCommands.length);
        return;
      }
      if (state.text.includes("\n")) { setState(moveLineDown); return; }
      onHistoryDown();
      return;
    }

    // --- Return / Enter ---
    if (key.return) {
      // Slash command list active: execute the selected command.
      if (slashActive) {
        const cmd = matchedCommands[
          Math.min(slashSelectedIndex, matchedCommands.length - 1)
        ];
        if (cmd) {
          setState({ text: "", cursor: 0 });
          onCommand(`/${cmd.name}${slashArgs}`);
        }
        return;
      }
      if (key.shift) { setState((s) => insert(s, "\n")); return; }
      // Alt/Meta+Enter: followUp during a turn, prompt when idle.
      if (key.meta) { submit(phase === "turn" ? "followUp" : "prompt"); return; }
      // Plain Enter: steer during a turn, prompt when idle, no-op in compaction.
      if (phase === "turn") { submit("steer"); return; }
      submit("prompt");
      return;
    }

    // --- Escape: close slash list, or abort + restore during a turn ---
    if (key.escape) {
      if (slashListOpen) {
        setSlashDismissed(true);
        return;
      }
      onEscapeAbort();
      return;
    }

    // --- Backspace / Delete ---
    if (key.backspace) { setState(backspace); return; }
    if (key.delete) { setState(deleteForward); return; }

    // --- Tab: slash completion or path completion ---
    // Shift+Tab cycles the thinking level before any Tab handling.
    if (key.tab && key.shift) {
      onCycleThinking();
      return;
    }
    if (key.tab) {
      if (slashActive) {
        const completed = completeSlashSelection(
          matchedCommands,
          slashSelected,
          slashArgs,
        );
        if (completed) {
          setState({ text: completed.text, cursor: completed.cursor });
        }
        return;
      }
      void tabComplete();
      return;
    }

    // --- Printable chars ---
    if (!value || key.ctrl || key.meta) return;

    // `@` triggers the filePicker overlay.
    if (value === "@") {
      setState(insert(state, value));
      onOpenFilePicker();
      return;
    }

    setState((s) => insert(s, value));
  });

  const busy = phase !== "idle" && !state.text.startsWith("/") && !state.text.startsWith("!");

  const before = state.text.slice(0, state.cursor);
  const at = state.text.slice(state.cursor);

  const slashSelected = Math.min(slashSelectedIndex, Math.max(0, matchedCommands.length - 1));

  const maxNameWidth = matchedCommands.length > 0
    ? Math.max(...matchedCommands.map((c) => c.name.length))
    : 0;

  return (
    <Box flexDirection="column">
      <Text color={theme.dim}>{divider(terminalWidth)}</Text>
      <Text>
        <Text color={theme.accent} bold>{icons.prompt} </Text>
        {before}
        <Text color={theme.dim}>▏</Text>
        {at}
        {busy ? (
          <Text>
            {" "}
            <Spinner color={theme.accent} />
            <Text color={theme.dim}> working…</Text>
          </Text>
        ) : null}
      </Text>
      {slashListOpen ? (
        matchedCommands.length > 0 ? (
          <Box flexDirection="column">
            {matchedCommands.map((cmd, i) => (
              <Text key={cmd.name} wrap="truncate">
                {i === slashSelected ? "→ " : "  "}
                {`/${cmd.name}`.padEnd(maxNameWidth + 3)}  {cmd.description}
              </Text>
            ))}
          </Box>
        ) : (
          <Text color={theme.dim}>  No matching commands</Text>
        )
      ) : null}
    </Box>
  );
}

/**
 * Compute the editor result of Tab-completing the slash command list.
 *
 * - Single match: complete to `/<name> ` (trailing space) when no args are
 *   present, or `/<name><args>` when args were already typed.
 * - Multiple matches: complete to the **currently highlighted** command name
 *   (preserving any `slashArgs`).
 *
 * Pure function so the completion logic is unit-testable in isolation.
 * Returns `null` when no completion applies (e.g. empty list).
 */
export function completeSlashSelection(
  matchedCommands: readonly { name: string }[],
  selectedIndex: number,
  slashArgs: string,
): { text: string; cursor: number } | null {
  if (matchedCommands.length === 0) return null;
  if (matchedCommands.length === 1) {
    const name = matchedCommands[0]!.name;
    const completed = slashArgs ? `/${name}${slashArgs}` : `/${name} `;
    return { text: completed, cursor: completed.length };
  }
  const cmd = matchedCommands[
    Math.min(selectedIndex, matchedCommands.length - 1)
  ];
  if (!cmd) return null;
  const completed = `/${cmd.name}${slashArgs}`;
  return { text: completed, cursor: completed.length };
}

/** Compute the longest common prefix string among a list of strings. */
function longestCommonPrefix(strings: string[]): string {
  if (strings.length === 0) return "";
  if (strings.length === 1) return strings[0]!;
  let prefix = strings[0]!;
  for (let i = 1; i < strings.length; i++) {
    while (!strings[i]!.startsWith(prefix)) {
      prefix = prefix.slice(0, -1);
      if (!prefix) return "";
    }
  }
  return prefix;
}
