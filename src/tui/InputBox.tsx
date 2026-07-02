import { Text, useInput } from "ink";
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
import { parseBang, runBang } from "./bang.js";
import { openExternalEditor } from "./external-editor.js";
import { loadFileCandidates } from "./file-picker.js";

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
}

/**
 * Full editor input box: cursor model, multi-line, Emacs keybindings,
 * `@file` trigger, `!`/`!!` shell bangs, Ctrl+G external editor, Tab path completion.
 *
 * Lines starting with `/` are routed to `onCommand`; bang-prefixed lines
 * (`!` / `!!`) are handled by {@link runBang}. While a turn is running, plain
 * prompts are held back — commands and bangs remain usable.
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
}: InputBoxProps): React.ReactElement {
  function submit(): void {
    const text = state.text.trim();
    if (!text) {
      setState({ text: "", cursor: 0 });
      return;
    }

    // Bang detection (! / !!).
    const bang = parseBang(state.text.trimStart());
    if (bang.kind !== "none") {
      setState({ text: "", cursor: 0 });
      void runBang(bang, { env, cwd, onPrompt, print: onNotice });
      return;
    }

    setState({ text: "", cursor: 0 });
    if (text.startsWith("/")) {
      onCommand(text);
      return;
    }
    if (phase !== "idle") return;
    onPrompt(text);
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
      if (key.backspace) { setState(deleteWordBackward); return; }
    }

    // --- Arrow keys ---
    if (key.leftArrow) { setState((s) => moveLeft(s)); return; }
    if (key.rightArrow) { setState((s) => moveRight(s)); return; }
    if (key.upArrow) { setState(moveLineUp); return; }
    if (key.downArrow) { setState(moveLineDown); return; }

    // --- Return / Enter ---
    if (key.return) {
      if (key.shift) { setState((s) => insert(s, "\n")); return; }
      submit();
      return;
    }

    // --- Backspace / Delete ---
    if (key.backspace) { setState(backspace); return; }
    if (key.delete) { setState(deleteForward); return; }

    // --- Tab: path completion ---
    if (key.tab) { void tabComplete(); return; }

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

  const busyHint = phase !== "idle" && !state.text.startsWith("/") && !state.text.startsWith("!")
    ? " (working…)"
    : "";

  const before = state.text.slice(0, state.cursor);
  const at = state.text.slice(state.cursor);

  return (
    <Text>
      <Text dimColor>› </Text>
      {before}
      <Text dimColor>▏</Text>
      {at}
      {busyHint ? <Text dimColor>{busyHint}</Text> : null}
    </Text>
  );
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
