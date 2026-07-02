import { useEffect, useState } from "react";
import { Text } from "ink";
import { icons, theme } from "../theme.js";

interface SpinnerProps {
  /** Ink color name; defaults to `theme.accent`. */
  color?: string;
}

/**
 * Pure React dingbat spinner — no external dependency.
 *
 * Cycles through `icons.spinner` every 80ms via `setInterval`.
 */
export function Spinner({ color }: SpinnerProps): React.ReactElement {
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI((v) => (v + 1) % icons.spinner.length), 80);
    return () => clearInterval(t);
  }, []);
  return <Text color={color ?? theme.accent}>{icons.spinner[i]}</Text>;
}
