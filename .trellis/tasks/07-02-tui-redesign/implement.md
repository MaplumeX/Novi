# Implement: TUI Visual Redesign

## Execution Checklist

Ordered by dependency — each step is independently verifiable.

### Step 1: theme.ts — icon registry + color roles
- [ ] Add `icons` constant object with all named glyphs (see design.md § theme.ts additions).
- [ ] Verify `icons` is exported and importable.
- [ ] **Validate**: `npx tsc --noEmit` passes.

### Step 2: Spinner.tsx — dingbat frames
- [ ] Replace `FRAMES` array with `icons.spinner`.
- [ ] Import `icons` from `../theme.js`.
- [ ] Remove the local `FRAMES` const (now lives in theme).
- [ ] **Validate**: `npx tsc --noEmit` + `npm test`.

### Step 3: StatusBar.tsx — remove emoji
- [ ] Replace `⚙{activeToolNames.length}` with `tools:{n}` plain text.
- [ ] Replace `⏵{queueLen}` with `queue:{n}` plain text.
- [ ] Use `·` (icons.mode) as inline separator between segments.
- [ ] Import `icons` from `./theme.js`.
- [ ] **Validate**: `npx tsc --noEmit` + visual grep `grep -n "⚙\|⏵" src/tui/StatusBar.tsx` returns nothing.

### Step 4: ToolCallBlock.tsx — collapsed + expanded redesign
- [ ] Collapsed: remove `⚙ ` prefix from the name `<Text>`. Keep `●` status dot + color logic.
- [ ] Expanded: remove `<Box borderStyle="single">`, replace with plain `<Text>` header.
- [ ] Expanded content: wrap in `<Box paddingLeft={1}>` with dim `│` guide column via row layout.
- [ ] Add `╌` separator lines between content sections in `renderExpanded` (path → diff → output).
- [ ] Import `icons` from `./theme.js`.
- [ ] **Validate**: `npx tsc --noEmit` + `grep -n "⚙" src/tui/ToolCallBlock.tsx` returns nothing.

### Step 5: MessageList.tsx — role rendering + thinking blocks
- [ ] Remove `✻ Assistant` header `<Text>`.
- [ ] Wrap completed assistant message content in a row-layout `<Box>` with dim `│` guide column + content `<Box>`.
- [ ] Streaming: add status line `<Spinner /> <Text dim>{verb}…</Text>` when streaming, replacing the `💭 thinking` block.
- [ ] Thinking folded: replace `💭 {firstLine}…` with `│ {firstLine}…` (dim, using icons.guide).
- [ ] Thinking expanded: replace `💭 thinking` label with `╌╌╌` separator + dim `│` guided content.
- [ ] Streaming tool calls: replace `⚙ {tc.name}…` with `● {tc.name}…` (dim, no gear).
- [ ] User message: replace `<Text bold color={theme.role.user}>You ›</Text>` with `<Text color={theme.dim}>{icons.prompt} user</Text>`.
- [ ] Import `icons` and `Spinner` (if not already imported).
- [ ] **Validate**: `npx tsc --noEmit` + `grep -n "💭\|✻\|⚙" src/tui/MessageList.tsx` returns nothing.

### Step 6: InputBox.tsx — consume icons.prompt
- [ ] Replace hardcoded `› ` with `{icons.prompt} `.
- [ ] Import `icons` from `./theme.js`.
- [ ] **Validate**: `npx tsc --noEmit`.

### Step 7: Full verification
- [ ] `grep -rn "💭\|⚙\|⏵" src/tui` returns zero matches.
- [ ] `npm run build` passes.
- [ ] `npm test` passes.
- [ ] Visual smoke test: run Novi interactively, verify:
  - Spinner shows dingbat frames
  - Assistant messages have no header, content under `│` guide
  - User messages show `› user` dim
  - Tool calls show `● name — summary` collapsed, `│`-guided expanded
  - StatusBar shows `tools:N queue:N` without emoji

## Validation Commands

```bash
# Type check
npx tsc --noEmit

# Build
npm run build

# Tests
npm test

# Emoji audit (must return nothing)
grep -rn "💭\|⚙\|⏵" src/tui

# Full icon hardcode audit (should only show theme.ts definitions)
grep -rn "✻\|✶\|✳\|✢" src/tui | grep -v "theme.ts"
```

## Risky Files / Rollback Points

| File | Risk | Mitigation |
|------|------|------------|
| `MessageList.tsx` | Row-layout guide line may misalign with Markdown output | Test with long markdown content (code blocks, lists) to verify wrapping. If misaligned, fall back to paddingLeft-only indentation without `│` column. |
| `ToolCallBlock.tsx` | `╌` separator width is fixed; may look odd in very wide terminals | Acceptable — matches existing `divider()` approach. |
| `theme.ts` | Adding `icons` object is additive, no existing export changed | Low risk. |

Each step is a natural commit boundary. If a step breaks, revert that
step's file changes only — steps are ordered so earlier steps don't
depend on later ones.
