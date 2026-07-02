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

/** Fixed divider width (no dynamic responsive sizing). */
export const DIVIDER_WIDTH = 40;

/** Character used for horizontal divider lines. */
export const DIVIDER_CHAR = "─";

/** Produce a horizontal divider string of the given width. */
export function divider(width: number = DIVIDER_WIDTH): string {
  return DIVIDER_CHAR.repeat(width);
}
