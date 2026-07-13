import { Box, Text } from "ink";
import type { AgentMessage } from "@earendil-works/pi-agent-core/node";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { HarnessState, Phase, ToolCallView } from "./useHarnessState.js";
import type { ToolCatalogSnapshot } from "../tools/contracts.js";
import { persistedToolCallView } from "../tools/events.js";
import { Markdown } from "./Markdown.js";
import { ThinkingBlock } from "./ThinkingBlock.js";
import { ToolCallBlock } from "./ToolCallBlock.js";
import { Spinner } from "./components/Spinner.js";
import { icons, theme } from "./theme.js";

interface MessageListProps {
  messages: AgentMessage[];
  phase: Phase;
  /** Active assistant streaming text (rendered as Markdown during streaming). */
  streamingText: string;
  /** Active assistant thinking text. Complete content is kept for detail mode. */
  streamingThinking: string;
  streamingThinkingActive: boolean;
  streamingToolCalls: HarnessState["streamingToolCalls"];
  toolCatalog: ToolCatalogSnapshot;
  detailed: boolean;
}

/** Concatenate all text content parts of a message into a single string. */
function collectText(parts: ReadonlyArray<{ type: string; text?: string }>): string {
  return parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("");
}

/** Count image content parts on a user message (string content → 0). */
export function countImages(content: string | ReadonlyArray<{ type: string }>): number {
  if (typeof content === "string" || !Array.isArray(content)) return 0;
  return content.filter((part) => part.type === "image").length;
}

/** Find the persisted result paired to a tool call. */
function findToolResult(
  messages: AgentMessage[],
  toolCallId: string,
): ToolResultMessage | undefined {
  return messages.find(
    (message): message is ToolResultMessage =>
      message.role === "toolResult" && message.toolCallId === toolCallId,
  );
}

/** Live calls normally attach to a frozen assistant toolCall; retain unmatched calls safely. */
export function unmatchedLiveToolCalls(
  messages: AgentMessage[],
  liveCalls: ToolCallView[],
): ToolCallView[] {
  const persistedIds = new Set<string>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.content) {
      if (part.type === "toolCall") persistedIds.add(part.id);
    }
  }
  return liveCalls.filter((call) => !persistedIds.has(call.id));
}

interface AssistantSurfaceProps {
  children: React.ReactNode;
  showMarker?: boolean;
}

function AssistantSurface({
  children,
  showMarker = false,
}: AssistantSurfaceProps): React.ReactElement {
  return (
    <Box flexDirection="row">
      <Box width={2} flexShrink={0}>
        {showMarker ? <Text color={theme.role.assistant}>{icons.assistant} </Text> : null}
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        {children}
      </Box>
    </Box>
  );
}

function renderAssistantMessage(
  message: Extract<AgentMessage, { role: "assistant" }>,
  messages: AgentMessage[],
  liveById: ReadonlyMap<string, ToolCallView>,
  toolCatalog: ToolCatalogSnapshot,
  detailed: boolean,
  index: number,
): React.ReactElement {
  const parts: React.ReactElement[] = [];
  let textBuffer = "";
  let answerMarked = false;

  const flushText = (key: string): void => {
    if (!textBuffer) return;
    const showMarker = !answerMarked && textBuffer.trim().length > 0;
    parts.push(
      <AssistantSurface key={key} showMarker={showMarker}>
        <Markdown text={textBuffer} />
      </AssistantSurface>,
    );
    answerMarked ||= showMarker;
    textBuffer = "";
  };

  message.content.forEach((part, partIndex) => {
    switch (part.type) {
      case "text":
        textBuffer += part.text;
        break;
      case "thinking":
        flushText(`text-${partIndex}`);
        if (part.thinking) {
          parts.push(
            <AssistantSurface key={`thinking-${partIndex}`}>
              <ThinkingBlock text={part.thinking} running={false} detailed={detailed} />
            </AssistantSurface>,
          );
        }
        break;
      case "toolCall":
        flushText(`text-${partIndex}`);
        {
          const result = findToolResult(messages, part.id);
          const persisted = persistedToolCallView(part, result, toolCatalog);
          const view = result ? persisted : (liveById.get(part.id) ?? persisted);
          parts.push(
            <AssistantSurface key={part.id}>
              <ToolCallBlock view={view} detailed={detailed} />
            </AssistantSurface>,
          );
        }
        break;
    }
  });
  flushText("text-end");

  return (
    <Box key={index} flexDirection="column" marginTop={1}>
      {parts}
    </Box>
  );
}

function renderMessage(
  message: AgentMessage,
  messages: AgentMessage[],
  liveById: ReadonlyMap<string, ToolCallView>,
  toolCatalog: ToolCatalogSnapshot,
  detailed: boolean,
  index: number,
): React.ReactNode {
  switch (message.role) {
    case "user": {
      const text =
        typeof message.content === "string" ? message.content : collectText(message.content);
      const imageCount = countImages(message.content);
      return (
        <Box key={index} flexDirection="column" marginTop={1}>
          <Text backgroundColor={theme.surface.user}>
            <Text bold color={theme.role.user}>
              {icons.prompt}{" "}
            </Text>
            {text || (imageCount > 0 ? "Attached images" : " ")}
          </Text>
          {imageCount > 0 ? (
            <Text color={theme.text.muted}>
              {" "}
              {imageCount} {imageCount === 1 ? "image" : "images"}
            </Text>
          ) : null}
        </Box>
      );
    }
    case "assistant":
      return renderAssistantMessage(message, messages, liveById, toolCatalog, detailed, index);
    case "toolResult":
      return null;
    default:
      return null;
  }
}

/** Render one coherent transcript for persisted history and the active turn. */
export function MessageList({
  messages,
  phase,
  streamingText,
  streamingThinking,
  streamingThinkingActive,
  streamingToolCalls,
  toolCatalog,
  detailed,
}: MessageListProps): React.ReactElement {
  const liveById = new Map(streamingToolCalls.map((call) => [call.id, call]));
  const unmatched = unmatchedLiveToolCalls(messages, streamingToolCalls);
  const waiting =
    phase === "turn" &&
    !streamingText &&
    !streamingThinking &&
    !streamingThinkingActive &&
    !streamingToolCalls.some((call) => call.status === "running");

  return (
    <Box flexDirection="column">
      {messages.map((message, index) =>
        renderMessage(message, messages, liveById, toolCatalog, detailed, index),
      )}
      {unmatched.length > 0 ? (
        <Box flexDirection="column" marginTop={1} paddingLeft={2}>
          {unmatched.map((live) => {
            return <ToolCallBlock key={live.id} view={live} detailed={detailed} />;
          })}
        </Box>
      ) : null}
      {streamingThinkingActive || streamingThinking || streamingText ? (
        <Box flexDirection="column" marginTop={1}>
          {streamingThinkingActive || streamingThinking ? (
            <AssistantSurface>
              <ThinkingBlock
                text={streamingThinking}
                running={streamingThinkingActive}
                detailed={detailed}
              />
            </AssistantSurface>
          ) : null}
          {streamingText ? (
            <AssistantSurface showMarker={streamingText.trim().length > 0}>
              <Markdown text={streamingText} />
            </AssistantSurface>
          ) : null}
        </Box>
      ) : null}
      {waiting ? (
        <Box marginTop={1} paddingLeft={2}>
          <Text color={theme.text.muted}>
            <Spinner color={theme.status.running} /> Working…
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}
