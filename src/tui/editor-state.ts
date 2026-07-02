/**
 * Cursor-position editor model for InputBox.
 *
 * All functions are pure — they take an {@link EditorState} and return a new
 * one. No side effects, no React. Unit-testable in isolation.
 *
 * Word boundary: a "word" is a maximal run of non-whitespace characters.
 * Emacs/Readline semantics: word-level moves skip leading whitespace then the
 * word itself.
 */

export interface EditorState {
  text: string;
  /** Character offset, 0 <= cursor <= text.length. */
  cursor: number;
}

// ---------------------------------------------------------------------------
// Single-character operations
// ---------------------------------------------------------------------------

/** Insert `value` at the cursor position and advance the cursor. */
export function insert(state: EditorState, value: string): EditorState {
  const { text, cursor } = state;
  return {
    text: text.slice(0, cursor) + value + text.slice(cursor),
    cursor: cursor + value.length,
  };
}

/** Delete the character immediately before the cursor (Backspace). */
export function backspace(state: EditorState): EditorState {
  const { text, cursor } = state;
  if (cursor === 0) return state;
  return {
    text: text.slice(0, cursor - 1) + text.slice(cursor),
    cursor: cursor - 1,
  };
}

/** Delete the character at the cursor position (Delete / fn+Backspace). */
export function deleteForward(state: EditorState): EditorState {
  const { text, cursor } = state;
  if (cursor >= text.length) return state;
  return {
    text: text.slice(0, cursor) + text.slice(cursor + 1),
    cursor,
  };
}

// ---------------------------------------------------------------------------
// Movement
// ---------------------------------------------------------------------------

/** Move the cursor left by one character or one word. */
export function moveLeft(state: EditorState, byWord = false): EditorState {
  const { text, cursor } = state;
  if (cursor === 0) return state;
  if (!byWord) return { ...state, cursor: cursor - 1 };

  let pos = cursor;
  // Skip whitespace to the left.
  while (pos > 0 && /\s/.test(text[pos - 1])) pos--;
  // Skip the non-whitespace word.
  while (pos > 0 && !/\s/.test(text[pos - 1])) pos--;
  return { ...state, cursor: pos };
}

/** Move the cursor right by one character or one word. */
export function moveRight(state: EditorState, byWord = false): EditorState {
  const { text, cursor } = state;
  if (cursor >= text.length) return state;
  if (!byWord) return { ...state, cursor: cursor + 1 };

  let pos = cursor;
  // Skip whitespace to the right.
  while (pos < text.length && /\s/.test(text[pos])) pos++;
  // Skip the non-whitespace word.
  while (pos < text.length && !/\s/.test(text[pos])) pos++;
  return { ...state, cursor: pos };
}

/** Move to the start of the current line (Ctrl+A / Home). */
export function moveToLineStart(state: EditorState): EditorState {
  const before = state.text.slice(0, state.cursor);
  const lastNewline = before.lastIndexOf("\n");
  const pos = lastNewline === -1 ? 0 : lastNewline + 1;
  return { ...state, cursor: pos };
}

/** Move to the end of the current line (Ctrl+E / End). */
export function moveToLineEnd(state: EditorState): EditorState {
  const after = state.text.slice(state.cursor);
  const nextNewline = after.indexOf("\n");
  const pos = nextNewline === -1 ? state.text.length : state.cursor + nextNewline;
  return { ...state, cursor: pos };
}

/**
 * Move the cursor up one line, preserving the column as closely as possible.
 * If already on the first line, move to the very start.
 */
export function moveLineUp(state: EditorState): EditorState {
  const { line, col } = getLineCol(state.text, state.cursor);
  if (line === 0) return moveToLineStart(state);
  const lineLengths = getLineLengths(state.text);
  return { ...state, cursor: colToCursor(lineLengths, line - 1, col) };
}

/**
 * Move the cursor down one line, preserving the column as closely as possible.
 * If already on the last line, move to the very end.
 */
export function moveLineDown(state: EditorState): EditorState {
  const { line, col } = getLineCol(state.text, state.cursor);
  const lineLengths = getLineLengths(state.text);
  if (line >= lineLengths.length - 1) return moveToLineEnd(state);
  return { ...state, cursor: colToCursor(lineLengths, line + 1, col) };
}

// ---------------------------------------------------------------------------
// Word / line deletion
// ---------------------------------------------------------------------------

/** Delete the word before the cursor (Ctrl+W / Alt+Backspace). */
export function deleteWordBackward(state: EditorState): EditorState {
  const { text, cursor } = state;
  if (cursor === 0) return state;
  let pos = cursor;
  while (pos > 0 && /\s/.test(text[pos - 1])) pos--;
  while (pos > 0 && !/\s/.test(text[pos - 1])) pos--;
  return {
    text: text.slice(0, pos) + text.slice(cursor),
    cursor: pos,
  };
}

/** Delete the word after the cursor (Alt+D). */
export function deleteWordForward(state: EditorState): EditorState {
  const { text, cursor } = state;
  if (cursor >= text.length) return state;
  let pos = cursor;
  while (pos < text.length && /\s/.test(text[pos])) pos++;
  while (pos < text.length && !/\s/.test(text[pos])) pos++;
  return {
    text: text.slice(0, cursor) + text.slice(pos),
    cursor,
  };
}

/** Delete from the cursor to the start of the line (Ctrl+U). */
export function deleteToLineStart(state: EditorState): EditorState {
  const before = state.text.slice(0, state.cursor);
  const lastNewline = before.lastIndexOf("\n");
  const start = lastNewline === -1 ? 0 : lastNewline + 1;
  return {
    text: state.text.slice(0, start) + state.text.slice(state.cursor),
    cursor: start,
  };
}

/** Delete from the cursor to the end of the line (Ctrl+K). */
export function deleteToLineEnd(state: EditorState): EditorState {
  const after = state.text.slice(state.cursor);
  const nextNewline = after.indexOf("\n");
  const end = nextNewline === -1 ? state.text.length : state.cursor + nextNewline;
  return {
    text: state.text.slice(0, state.cursor) + state.text.slice(end),
    cursor: state.cursor,
  };
}

// ---------------------------------------------------------------------------
// Helpers: line/column math
// ---------------------------------------------------------------------------

/** Return the 0-based line index and column for a cursor position. */
function getLineCol(text: string, cursor: number): { line: number; col: number } {
  const before = text.slice(0, cursor);
  const lines = before.split("\n");
  return { line: lines.length - 1, col: lines[lines.length - 1]!.length };
}

/** Return the character length of each line. */
function getLineLengths(text: string): number[] {
  return text.split("\n").map((l) => l.length);
}

/**
 * Convert a (line, col) pair back to a flat cursor offset.
 * The column is clamped to the target line's length.
 */
function colToCursor(lineLengths: number[], line: number, col: number): number {
  let offset = 0;
  for (let i = 0; i < line; i++) {
    // +1 for the "\n" that separates line i from i+1.
    offset += lineLengths[i]! + 1;
  }
  return offset + Math.min(col, lineLengths[line] ?? 0);
}
