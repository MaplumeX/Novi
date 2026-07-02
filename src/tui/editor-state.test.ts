import { describe, expect, it } from "vitest";
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

function st(text: string, cursor = text.length): EditorState {
  return { text, cursor };
}

describe("insert", () => {
  it("inserts at cursor and advances", () => {
    expect(insert(st("hello", 2), "XY")).toEqual(st("heXYllo", 4));
  });

  it("inserts at the beginning", () => {
    expect(insert(st("abc", 0), "Z")).toEqual(st("Zabc", 1));
  });

  it("inserts at the end", () => {
    expect(insert(st("abc", 3), "Z")).toEqual(st("abcZ", 4));
  });

  it("inserts an empty string (no-op)", () => {
    expect(insert(st("abc", 1), "")).toEqual(st("abc", 1));
  });
});

describe("backspace", () => {
  it("deletes the char before cursor", () => {
    expect(backspace(st("hello", 3))).toEqual(st("helo", 2));
  });

  it("does nothing at cursor 0", () => {
    expect(backspace(st("abc", 0))).toEqual(st("abc", 0));
  });

  it("deletes newline backwards", () => {
    expect(backspace(st("ab\ncd", 3))).toEqual(st("abcd", 2));
  });
});

describe("deleteForward", () => {
  it("deletes the char at cursor", () => {
    expect(deleteForward(st("hello", 2))).toEqual(st("helo", 2));
  });

  it("does nothing at end", () => {
    expect(deleteForward(st("abc", 3))).toEqual(st("abc", 3));
  });

  it("deletes newline forward", () => {
    expect(deleteForward(st("ab\ncd", 2))).toEqual(st("abcd", 2));
  });
});

describe("moveLeft", () => {
  it("moves left one char", () => {
    expect(moveLeft(st("abc", 2))).toEqual(st("abc", 1));
  });

  it("stays at 0", () => {
    expect(moveLeft(st("abc", 0))).toEqual(st("abc", 0));
  });

  it("word move skips whitespace then word", () => {
    expect(moveLeft(st("hello world", 11), true)).toEqual(st("hello world", 6));
  });

  it("word move from middle of word goes to word start", () => {
    expect(moveLeft(st("hello", 3), true)).toEqual(st("hello", 0));
  });

  it("word move handles leading whitespace", () => {
    expect(moveLeft(st("abc   ", 6), true)).toEqual(st("abc   ", 0));
  });

  it("word move on empty text is no-op", () => {
    expect(moveLeft(st("", 0), true)).toEqual(st("", 0));
  });
});

describe("moveRight", () => {
  it("moves right one char", () => {
    expect(moveRight(st("abc", 0))).toEqual(st("abc", 1));
  });

  it("stays at end", () => {
    expect(moveRight(st("abc", 3))).toEqual(st("abc", 3));
  });

  it("word move skips whitespace then word", () => {
    expect(moveRight(st("hello world", 0), true)).toEqual(st("hello world", 5));
  });

  it("word move from middle of word goes to word end", () => {
    expect(moveRight(st("hello", 2), true)).toEqual(st("hello", 5));
  });

  it("word move handles trailing whitespace", () => {
    expect(moveRight(st("   abc", 0), true)).toEqual(st("   abc", 6));
  });
});

describe("moveToLineStart", () => {
  it("moves to start of first line", () => {
    expect(moveToLineStart(st("hello world", 5))).toEqual(st("hello world", 0));
  });

  it("moves to start of second line", () => {
    expect(moveToLineStart(st("line1\nline2", 8))).toEqual(st("line1\nline2", 6));
  });

  it("already at line start stays", () => {
    expect(moveToLineStart(st("abc", 0))).toEqual(st("abc", 0));
  });
});

describe("moveToLineEnd", () => {
  it("moves to end of first line", () => {
    expect(moveToLineEnd(st("hello\nworld", 2))).toEqual(st("hello\nworld", 5));
  });

  it("moves to end of second line", () => {
    expect(moveToLineEnd(st("hello\nworld", 7))).toEqual(st("hello\nworld", 11));
  });

  it("already at end stays", () => {
    expect(moveToLineEnd(st("abc", 3))).toEqual(st("abc", 3));
  });
});

describe("moveLineUp", () => {
  it("moves up preserving column", () => {
    expect(moveLineUp(st("aaaa\nbbbb", 7))).toEqual(st("aaaa\nbbbb", 2));
  });

  it("clamps column to shorter line above", () => {
    expect(moveLineUp(st("ab\ndefgh", 8))).toEqual(st("ab\ndefgh", 2));
  });

  it("from first line goes to line start", () => {
    expect(moveLineUp(st("hello", 3))).toEqual(st("hello", 0));
  });
});

describe("moveLineDown", () => {
  it("moves down preserving column", () => {
    expect(moveLineDown(st("aaaa\nbbbb", 1))).toEqual(st("aaaa\nbbbb", 6));
  });

  it("clamps column to shorter line below", () => {
    expect(moveLineDown(st("ab\ncd", 1))).toEqual(st("ab\ncd", 4));
  });

  it("from last line goes to line end", () => {
    expect(moveLineDown(st("hello", 2))).toEqual(st("hello", 5));
  });
});

describe("deleteWordBackward", () => {
  it("deletes the word before cursor", () => {
    expect(deleteWordBackward(st("hello world", 11))).toEqual(st("hello ", 6));
  });

  it("from middle of word deletes to word start", () => {
    expect(deleteWordBackward(st("hello", 3))).toEqual(st("lo", 0));
  });

  it("skips whitespace then deletes word", () => {
    expect(deleteWordBackward(st("abc   ", 6))).toEqual(st("", 0));
  });

  it("at cursor 0 is no-op", () => {
    expect(deleteWordBackward(st("abc", 0))).toEqual(st("abc", 0));
  });
});

describe("deleteWordForward", () => {
  it("deletes the word after cursor", () => {
    expect(deleteWordForward(st("hello world", 0))).toEqual(st(" world", 0));
  });

  it("from middle of word deletes to word end", () => {
    expect(deleteWordForward(st("hello", 2))).toEqual(st("he", 2));
  });

  it("at end is no-op", () => {
    expect(deleteWordForward(st("abc", 3))).toEqual(st("abc", 3));
  });

  it("skips whitespace then deletes word", () => {
    expect(deleteWordForward(st("   abc", 0))).toEqual(st("", 0));
  });
});

describe("deleteToLineStart", () => {
  it("deletes to start of current line", () => {
    expect(deleteToLineStart(st("hello world", 5))).toEqual(st(" world", 0));
  });

  it("preserves previous lines", () => {
    expect(deleteToLineStart(st("line1\nline2", 8))).toEqual(st("line1\nne2", 6));
  });

  it("at line start is no-op", () => {
    expect(deleteToLineStart(st("abc", 0))).toEqual(st("abc", 0));
  });
});

describe("deleteToLineEnd", () => {
  it("deletes to end of current line", () => {
    expect(deleteToLineEnd(st("hello world", 0))).toEqual(st("", 0));
  });

  it("preserves next lines", () => {
    expect(deleteToLineEnd(st("line1\nline2", 7))).toEqual(st("line1\nl", 7));
  });

  it("at line end is no-op", () => {
    expect(deleteToLineEnd(st("abc", 3))).toEqual(st("abc", 3));
  });
});
