/**
 * Shared theme module: all TUI components consume these semantic colors,
 * glyphs, and layout limits instead of hardcoding visual values.
 *
 * A single source of truth keeps transcript, input, and temporary panels
 * visually coherent.
 */

/** Color literals accepted by Ink `<Text color>`. */
export const theme = {
  text: {
    muted: "dim",
    subtle: "gray",
  },
  role: {
    user: "cyan",
    assistant: "magenta",
  },
  status: {
    error: "red",
    running: "yellow",
    success: "green",
  },
  accent: "cyan",
  borderTone: {
    subtle: "gray",
    focus: "cyan",
    warning: "yellow",
  },
  surface: {
    user: "#262626",
    focus: "#1f2933",
    code: "#333333",
  },
  link: "blue",
  diff: {
    del: "red",
    add: "green",
  },
} as const;

/** Centralized icon/glyph registry — no component hardcodes emoji or ad-hoc unicode. */
export const icons = {
  /** Dingbat spinner frames (U+2736, U+273B, U+2733, U+2722). */
  spinner: ["✶", "✻", "✳", "✢"],
  /** Stable transcript anchors. Keep every glyph single-column in common terminals. */
  assistant: "◆",
  thinking: "✻",
  tool: "●",
  success: "✓",
  error: "×",
  selection: "›",
  edit: "✎",
  listBullet: "·",
  /** Left guide line for assistant content / tool args. */
  guide: "│",
  /** Result-tree indent prefix for tool-call expanded/collapsed output. */
  bracket: "⎿",
  /** Content separator used by Markdown horizontal rules. */
  separatorSolid: "─",
  /** InputBox prompt prefix + user label prefix. */
  prompt: "›",
  /** StatusBar inline separator. */
  mode: "·",
} as const;

/** Shared content limits for compact transcript presentation. */
export const layout = {
  previewWidth: 88,
  toolResultLines: 20,
  panelPaddingX: 1,
  ruleWidth: 40,
} as const;
