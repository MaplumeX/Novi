import { Fragment, type ReactNode } from "react";
import { Box, Text } from "ink";
import type { Token, Tokens } from "marked";
import { theme } from "../theme.js";

/**
 * Pure `marked` token → Ink element mapping. No harness access, no state —
 * Markdown rendering is decoupled from the event boundary (see
 * cross-layer-thinking-guide.md).
 *
 * Decorative keys: token arrays are short-lived render output, so a
 * monotonically increasing index is a stable-enough React key.
 */

function renderInlineTokens(tokens: Token[] | undefined): ReactNode {
  if (!tokens || tokens.length === 0) return null;
  return tokens.map((tok, i) => (
    <Fragment key={i}>{renderInline(tok)}</Fragment>
  ));
}

function renderInline(token: Token): ReactNode {
  switch (token.type) {
    case "strong":
      return <Text bold>{renderInlineTokens((token as Tokens.Strong).tokens)}</Text>;
    case "em":
      return <Text italic>{renderInlineTokens((token as Tokens.Em).tokens)}</Text>;
    case "codespan":
      return <Text backgroundColor="#333" color={theme.accent}>{(token as Tokens.Codespan).text}</Text>;
    case "del":
      return <Text strikethrough>{renderInlineTokens((token as Tokens.Del).tokens)}</Text>;
    case "link":
      // Show the link text; href omitted to keep lines tidy in a terminal.
      return <Text color={theme.link}>{renderInlineTokens((token as Tokens.Link).tokens)}</Text>;
    case "image":
      return <Text color={theme.link}>{(token as Tokens.Image).text}</Text>;
    case "br":
      return "\n";
    case "escape":
    case "text":
      return (token as Tokens.Text).tokens
        ? renderInlineTokens((token as Tokens.Text).tokens)
        : (token as Tokens.Text).text;
    case "html":
    case "tag":
      return (token as Tokens.HTML | Tokens.Tag).text;
    default:
      // Unknown / generic inline token: degrade to raw text if available, else
      // the typed `raw` field. Keeps rendering resilient to marked additions.
      return "raw" in token ? (token as { raw: string }).raw : "";
  }
}

function renderListItem(item: Tokens.ListItem, index: number, ordered: boolean, start: number): ReactNode {
  const marker = ordered ? `${start + index}.` : "·";
  return (
    <Text key={index}>
      <Text color={theme.dim}>{marker} </Text>
      {item.tokens ? renderBlockTokens(item.tokens) : item.text}
    </Text>
  );
}

function renderBlock(token: Token): ReactNode {
  switch (token.type) {
    case "heading": {
      const h = token as Tokens.Heading;
      const indent = "  ".repeat(Math.max(0, h.depth - 1));
      return (
        <Text bold>
          {indent}
          {renderInlineTokens(h.tokens)}
        </Text>
      );
    }
    case "paragraph": {
      const p = token as Tokens.Paragraph;
      return <Text>{renderInlineTokens(p.tokens)}</Text>;
    }
    case "code": {
      const c = token as Tokens.Code;
      const lang = c.lang || "";
      return (
        <Box flexDirection="column">
          {lang ? <Text color={theme.dim}>{lang}</Text> : null}
          <Box borderStyle="single" borderColor={theme.border} paddingX={1}>
            <Text>{c.text}</Text>
          </Box>
        </Box>
      );
    }
    case "list": {
      const l = token as Tokens.List;
      const startNum = typeof l.start === "number" ? l.start : 0;
      return (
        <Box flexDirection="column">
          {l.items.map((item, i) => renderListItem(item, i, l.ordered, startNum))}
        </Box>
      );
    }
    case "blockquote": {
      const b = token as Tokens.Blockquote;
      return (
        <Box marginLeft={2}>
          <Text color={theme.dim}>│ </Text>
          <Box flexDirection="column">{renderBlockTokens(b.tokens)}</Box>
        </Box>
      );
    }
    case "hr":
      return <Text color={theme.dim}>{"─".repeat(40)}</Text>;
    case "space":
      return null;
    case "html":
    case "tag":
      return <Text>{(token as Tokens.HTML | Tokens.Tag).text}</Text>;
    case "table": {
      // Simple multiline degradation; rich table layout is out of scope.
      const t = token as Tokens.Table;
      const lines = [
        t.header.map((c) => c.text).join(" | "),
        ...t.rows.map((r) => r.map((c) => c.text).join(" | ")),
      ];
      return <Text>{lines.join("\n")}</Text>;
    }
    case "text":
      // A block-level `text` token (e.g. inside a list item or loose text
      // block) carries *inline* sub-tokens in marked, so route them through
      // `renderInlineTokens` — otherwise inline codespan/strong/em tokens hit
      // the block default and bleed raw markdown (backticks/asterisks).
      return (token as Tokens.Text).tokens
        ? renderInlineTokens((token as Tokens.Text).tokens)
        : <Text>{(token as Tokens.Text).text}</Text>;
    default: {
      const raw = "raw" in token ? (token as { raw: string }).raw : "";
      return raw ? <Text>{raw}</Text> : null;
    }
  }
}

/** Render a sequence of block-level tokens into Ink elements. */
export function renderBlockTokens(tokens: Token[] | undefined): ReactNode {
  if (!tokens || tokens.length === 0) return null;
  return tokens.map((tok, i) => <Fragment key={i}>{renderBlock(tok)}</Fragment>);
}
