import { Box, Text } from "ink";
import type { AgentMessage } from "@earendil-works/pi-agent-core/node";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { HarnessState } from "./useHarnessState.js";
import { Markdown } from "./Markdown.js";
import { ToolCallBlock } from "./ToolCallBlock.js";

interface MessageListProps {
  messages: AgentMessage[];
  /** Active assistant streaming text (rendered as Markdown during streaming). */
  streamingText: string;
  /** Active assistant thinking text (rendered dim during streaming). */
  streamingThinking: string;
  streamingToolCalls: HarnessState["streamingToolCalls"];
  toolExpanded: boolean;
}

/** Concatenate all `text` content parts of a message into a single string. */
function collectText(parts: ReadonlyArray<{ type: string; text?: string }>): string {
  return parts
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("");
}

/** Find a ToolResultMessage in the messages array matching the given toolCallId. */
function findToolResult(messages: AgentMessage[], toolCallId: string): ToolResultMessage | undefined {
  return messages.find(
    (m): m is ToolResultMessage => m.role === "toolResult" && m.toolCallId === toolCallId,
  );
}

/** Render an assistant message, iterating its content array. */
function renderAssistantMessage(
  message: Extract<AgentMessage, { role: "assistant" }>,
  messages: AgentMessage[],
  toolExpanded: boolean,
  index: number,
): React.ReactElement {
  const parts: React.ReactElement[] = [];
  let textBuffer = "";

  const flushText = (key: string): void => {
    if (textBuffer.length > 0) {
      parts.push(<Markdown key={key} text={textBuffer} />);
      textBuffer = "";
    }
  };

  message.content.forEach((part, i) => {
    switch (part.type) {
      case "text":
        textBuffer += part.text;
        break;
      case "thinking": {
        flushText(`md-${i}`);
        if (toolExpanded && part.thinking.length > 0) {
          parts.push(
            <Box key={`think-${i}`} flexDirection="column">
              <Text dimColor>💭 thinking</Text>
              <Text dimColor>{part.thinking}</Text>
            </Box>,
          );
        } else {
          const firstLine = part.thinking.split("\n")[0]?.slice(0, 60) ?? "";
          parts.push(
            <Text key={`think-${i}`} dimColor>
              💭 {firstLine}
              {part.thinking.length > 60 ? "…" : ""}
            </Text>,
          );
        }
        break;
      }
      case "toolCall": {
        flushText(`md-${i}`);
        const result = findToolResult(messages, part.id);
        parts.push(
          <ToolCallBlock
            key={`tc-${i}`}
            call={part}
            result={result}
            expanded={toolExpanded}
          />,
        );
        break;
      }
      default:
        break;
    }
  });

  flushText("md-end");

  return (
    <Box key={index} flexDirection="column">
      <Text dimColor>✻</Text>
      {parts.length > 0 ? <Box flexDirection="column">{parts}</Box> : null}
    </Box>
  );
}

function renderMessage(
  message: AgentMessage,
  messages: AgentMessage[],
  toolExpanded: boolean,
  index: number,
): React.ReactNode {
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
    case "assistant":
      return renderAssistantMessage(message, messages, toolExpanded, index);
    case "toolResult":
      // Tool results are rendered inline by ToolCallBlock inside the matching
      // assistant message. Standalone rendering is skipped.
      return null;
    default:
      // Custom message roles (bashExecution, custom, etc.) are not part of
      // this child's scope.
      return null;
  }
}

/** Render conversation history as role-specific bubbles + the live stream. */
export function MessageList({
  messages,
  streamingText,
  streamingThinking,
  streamingToolCalls,
  toolExpanded,
}: MessageListProps): React.ReactElement {
  return (
    <Box flexDirection="column">
      {messages.map((m, i) => renderMessage(m, messages, toolExpanded, i))}
      {streamingToolCalls.map((tc) => (
        <Text key={`tc-${tc.id}`} dimColor>
          ⚙ {tc.name}… {tc.status === "running" ? "running" : `(${tc.status})`}
        </Text>
      ))}
      {streamingThinking.length > 0 ? (
        <Box flexDirection="column">
          <Text dimColor>💭 thinking</Text>
          <Text dimColor>{streamingThinking}</Text>
        </Box>
      ) : null}
      {streamingText.length > 0 ? <Markdown text={streamingText} /> : null}
    </Box>
  );
}
