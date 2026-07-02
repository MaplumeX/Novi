/**
 * Shared theme module: all TUI components consume these color mappings and
 * divider utilities instead of hardcoding Ink color strings or `dimColor`.
 *
 * Replacing scattered `dimColor` / `color="cyan"` calls with `theme.*`
 * gives a single source of truth for the visual palette.
 */

/** Color literals accepted by Ink `<Text color>`. */
export const theme = {
  role: {
    user: "cyan",
    assistant: "magenta",
  },
  status: {
    idle: "green",
    active: "yellow",
    error: "red",
  },
  accent: "cyan",
  border: "gray",
  dim: "dim",
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
  /** Tool status dot (color-coded by caller). */
  statusDot: "●",
  /** Left guide line for assistant content / tool args. */
  guide: "│",
  /** (Reserved; not used in MVP — guide line suffices.) */
  bracket: "⎿",
  /** Content-block separator within expanded tool/thinking views. */
  separatorDotted: "╌",
  /** (Already exists as DIVIDER_CHAR.) */
  separatorSolid: "─",
  /** InputBox prompt prefix + user label prefix. */
  prompt: "›",
  /** StatusBar inline separator. */
  mode: "·",
} as const;

/** Fixed divider width (no dynamic responsive sizing). */
export const DIVIDER_WIDTH = 40;

/** Character used for horizontal divider lines. */
export const DIVIDER_CHAR = "─";

/** Produce a horizontal divider string of the given width. */
export function divider(width: number = DIVIDER_WIDTH): string {
  return DIVIDER_CHAR.repeat(width);
}
