import { Box, Text } from "ink";
import { Spinner } from "./components/Spinner.js";
import { compactLine, lastMeaningfulLine } from "./tool-presentation.js";
import { icons, theme } from "./theme.js";

interface ThinkingBlockProps {
  text: string;
  running: boolean;
  detailed: boolean;
}

/** Derive a compact live preview without discarding the complete thinking text. */
export function thinkingPreview(text: string): string {
  return compactLine(lastMeaningfulLine(text));
}

/** Compact by default; detailed mode reveals the complete reasoning block. */
export function ThinkingBlock({ text, running, detailed }: ThinkingBlockProps): React.ReactElement {
  const preview = thinkingPreview(text);
  return (
    <Box flexDirection="column">
      <Text color={theme.text.muted}>
        {running ? <Spinner color={theme.status.running} /> : icons.thinking}{" "}
        {running ? "Thinking" : "Thought"}
        {preview ? ` — ${preview}` : running ? "…" : ""}
      </Text>
      {detailed && text ? (
        <Box flexDirection="column" paddingLeft={2}>
          {text.split("\n").map((line, index) => (
            <Text key={index} color={theme.text.muted}>
              {icons.guide} {line || " "}
            </Text>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}
