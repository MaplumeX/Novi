import { Box, Text } from "ink";
import { layout, theme } from "../theme.js";

interface PanelProps {
  title: string;
  description?: React.ReactNode;
  footer?: React.ReactNode;
  tone?: "default" | "warning";
  children: React.ReactNode;
}

/** Shared temporary surface: title, optional context, content, then key hints. */
export function Panel({
  title,
  description,
  footer,
  tone = "default",
  children,
}: PanelProps): React.ReactElement {
  const borderColor = tone === "warning" ? theme.borderTone.warning : theme.borderTone.focus;

  return (
    <Box
      flexDirection="column"
      marginTop={1}
      borderStyle="round"
      borderColor={borderColor}
      paddingX={layout.panelPaddingX}
    >
      <Text bold color={borderColor}>
        {title}
      </Text>
      {description ? <Text color={theme.text.muted}>{description}</Text> : null}
      {description ? <Text> </Text> : null}
      {children}
      {footer ? <Text color={theme.text.muted}>{footer}</Text> : null}
    </Box>
  );
}
