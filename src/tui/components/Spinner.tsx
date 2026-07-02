import { useEffect, useState } from "react";
import { Text } from "ink";
import { theme } from "../theme.js";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

interface SpinnerProps {
  /** Ink color name; defaults to `theme.accent`. */
  color?: string;
}

/**
 * Pure React braille spinner — no external dependency.
 *
 * Cycles through `FRAMES` every 80ms via `setInterval`.
 */
export function Spinner({ color }: SpinnerProps): React.ReactElement {
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI((v) => (v + 1) % FRAMES.length), 80);
    return () => clearInterval(t);
  }, []);
  return <Text color={color ?? theme.accent}>{FRAMES[i]}</Text>;
}
