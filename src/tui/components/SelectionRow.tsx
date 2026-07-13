import { Text } from "ink";
import { icons, theme } from "../theme.js";

interface SelectionRowProps {
  selected: boolean;
  children: React.ReactNode;
  description?: React.ReactNode;
  shortcut?: string;
}

/** Consistent list row used by pickers, prompts, and setup screens. */
export function SelectionRow({
  selected,
  children,
  description,
  shortcut,
}: SelectionRowProps): React.ReactElement {
  return (
    <Text color={selected ? theme.accent : undefined}>
      {selected ? icons.selection : " "} {shortcut ? `[${shortcut}] ` : ""}
      {children}
      {description ? <Text color={theme.text.muted}> — {description}</Text> : null}
    </Text>
  );
}
