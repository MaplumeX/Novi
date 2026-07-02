import type { AgentMessage } from "@earendil-works/pi-agent-core/node";
import type { TextContent } from "@earendil-works/pi-ai";

/**
 * Extract a plain-text preview from any agent message shape.
 *
 * Single owner of the `AgentMessage` → string projection so that the queue
 * restore path, Alt+Up preview, and `/queue` command all agree (see
 * cross-layer-thinking-guide.md, "Every Consumer Parses The Same Payload").
 *
 * Display-only: never throws across the message-content union.
 */
export function messageText(message: AgentMessage): string {
  switch (message.role) {
    case "user":
    case "assistant":
    case "toolResult": {
      const content = message.content;
      if (typeof content === "string") return content;
      if (!Array.isArray(content)) return "";
      return content
        .filter((c): c is TextContent => c.type === "text")
        .map((c) => c.text)
        .join(" ");
    }
    case "bashExecution":
      return message.command;
    case "custom": {
      const content = message.content;
      if (typeof content === "string") return content;
      return content
        .filter((c): c is TextContent => c.type === "text")
        .map((c) => c.text)
        .join(" ");
    }
    case "branchSummary":
    case "compactionSummary":
      return message.summary;
    default:
      return "";
  }
}

/**
 * Combine restored queued message texts with any text already in the editor.
 *
 * Restored queued texts come first (in queue order), followed by the editor's
 * existing unsent text, separated by a newline. Empty queued texts are
 * skipped. If there is nothing to restore, the current text is returned
 * unchanged.
 */
export function restoreText(queuedTexts: string[], currentText: string): string {
  const restored = queuedTexts.filter((t) => t.length > 0).join("\n");
  if (!restored) return currentText;
  if (!currentText) return restored;
  return `${restored}\n${currentText}`;
}
