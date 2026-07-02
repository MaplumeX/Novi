import { useEffect, useState } from "react";
import { Box } from "ink";
import { lexer } from "marked";
import { renderBlockTokens } from "./markdown/render-token.js";

interface MarkdownProps {
  text: string;
}

/**
 * Render Markdown text as Ink elements via `marked.lexer`.
 *
 * A 50ms debounce avoids re-running the lexer on every streaming delta while
 * still rendering progressively. When streaming finishes, the last debounce
 * flush renders the complete text.
 */
export function Markdown({ text }: MarkdownProps): React.ReactElement {
  const [debounced, setDebounced] = useState(text);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(text), 50);
    return () => clearTimeout(t);
  }, [text]);
  const tokens = lexer(debounced);
  return <Box flexDirection="column">{renderBlockTokens(tokens)}</Box>;
}
