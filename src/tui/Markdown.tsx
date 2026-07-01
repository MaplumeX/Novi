import { Box } from "ink";
import { lexer } from "marked";
import { renderBlockTokens } from "./markdown/render-token.js";

interface MarkdownProps {
  text: string;
}

/**
 * Render a complete assistant message body as Markdown, once, on `message_end`.
 *
 * Performance: `marked.lexer` runs over the full text per call. Callers must
 * NOT feed streaming deltas here — during streaming, render `<Text>` directly
 * (see MessageList). Unknown tokens degrade to plain text (render-token.tsx).
 */
export function Markdown({ text }: MarkdownProps): React.ReactElement {
  const tokens = lexer(text);
  return <Box flexDirection="column">{renderBlockTokens(tokens)}</Box>;
}
