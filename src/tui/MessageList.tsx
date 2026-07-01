import { Box, Text } from "ink";
import type { AgentMessage } from "@earendil-works/pi-agent-core/node";
import type { HarnessState } from "./useHarnessState.js";
import { Markdown } from "./Markdown.js";

interface MessageListProps {
  messages: AgentMessage[];
  /** Active assistant streaming text (rendered plain, no Markdown). */
  streamingText: string;
  streamingToolCalls: HarnessState["streamingToolCalls"];
}

/** Concatenate all `text` content parts of a message into a single string. */
function collectText(parts: ReadonlyArray<{ type: string; text?: string }>): string {
  return parts
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("");
}

function renderMessage(message: AgentMessage, index: number) {
  switch (message.role) {
    case "user": {
      const text =
        typeof message.content === "string"
          ? message.content
          : collectText(message.content);
      return (
        <Box key={index} flexDirection="column">
          <Text>
            <Text color="cyan">›</Text> {text}
          </Text>
        </Box>
      );
    }
    case "assistant": {
      const text = collectText(message.content);
      return <Markdown key={index} text={text} />;
    }
    case "toolResult": {
      // Collapsed to a single summary line; full details belong to later children.
      const summary = collectText(message.content).split("\n")[0]?.slice(0, 60) ?? "";
      const tag = message.isError ? "error" : "done";
      return (
        <Text key={index} dimColor>
          ⚙ {message.toolName} → {tag}: {summary}
        </Text>
      );
    }
    default:
      // Custom message roles are not part of this child's scope.
      return null;
  }
}

/** Render conversation history as role-specific bubbles + the live stream. */
export function MessageList({
  messages,
  streamingText,
  streamingToolCalls,
}: MessageListProps): React.ReactElement {
  return (
    <Box flexDirection="column">
      {messages.map((m, i) => renderMessage(m, i))}
      {streamingToolCalls.map((tc) => (
        <Text key={`tc-${tc.id}`} dimColor>
          ⚙ {tc.name}… {tc.status === "running" ? "" : `(${tc.status})`}
        </Text>
      ))}
      {streamingText.length > 0 ? (
        <Text>{streamingText}</Text>
      ) : null}
    </Box>
  );
}
