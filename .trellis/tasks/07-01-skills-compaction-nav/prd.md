# Skills loading, compaction, tree nav (child 4)

**依赖**：child 1 `scaffold-harness`（harness、resources API、env）+ child 2 `tui-shell`（命令体系入口、`useHarnessState` 的 `settled` 事件）。
**父任务**：`07-01-bootstrap-agent-skeleton`。最后一个 child。

## Goal

让 Novi agent 具备：从用户级 + 项目级目录加载 skills/prompts 并注入 system prompt；自动 + 手动 compaction；tree navigation（列历史分支、切换）。填充 child 2 留下的 `/compact` `/tree` `/goto` 占位。

## Requirements

### R1 skills / prompt-templates 加载
- 用 `loadSourcedSkills(env, [{path, source}])` 从 `~/.novi/skills/` + `.novi/skills/` 加载（两层），`loadPromptTemplates(env, paths)` 从 `~/.novi/prompts/` + `.novi/prompts/` 加载。
- 项目级优先：同名 skill 时项目级覆盖用户级（用 `loadSourcedSkills` 的 source 标记 + manually dedupe by name，后扫描的覆盖先扫描的）。
- `bootstrap.ts`：加载后 `await harness.setResources({ skills, promptTemplates })`。
- system prompt provider 回调（child 1 已建）里追加 `formatSkillsForSystemPrompt(resources.skills)`——改 child 1 的 `makeSystemPromptProvider`：读 system-prompt.md 文件内容后，把 skills 段拼到末尾。
- 加载失败/diagnostics：打 warning 到 stderr（不阻断启动）。

### R2 compaction
- **自动**：在 `useHarnessState` 的 `settled` 事件后检查——`estimateContextTokens(messages).tokens` + 一个 contextWindow 常量（按 model 的 contextWindow 或固定 200k）+ `shouldCompact(tokens, window, DEFAULT_COMPACTION_SETTINGS)`，命中且 phase==idle 时调 `await harness.compact()`。
- 防抖：最近一次 compact 后 N 轮内不再触发（避免抖动，N=3 起步）。
- compact 期间 phase=compaction，禁止提交 prompt。
- **手动**：`/compact [instructions]` → `harness.compact(args)`（仅 idle），显示结果摘要。
- compact 成功后历史视图刷新（`session.getBranch()` 重新灌入 `messages`）。

### R3 tree navigation
- `/tree`：调 `session.getEntries()` 或 `getBranch()` 列出历史条目（id + type + 摘要前 40 字符），从 root 到 leaf 树状/线性展示。
- `/goto <id>`：`await harness.navigateTree(id, { summarize: true })`（需 idle）；切换后重新灌入 `messages`；显示 editorText（若返回）。
- `/branch` 别名 `/goto` 当前 leaf 改从分叉（可选，本 child 不必，`/goto` 够验收）。

### R4 命令体系填充
- `commands.ts`：把 child 2 的 `/compact` `/tree` `/goto` 占位替换为真实实现。
- `/compact` 支持 optional `instructions` 参数。
- `/tree`/`/goto` 需 idle，非 idle 提示。

### R5 测试（vitest 纯逻辑）
- skills 加载 + dedupe 逻辑（用 tmpdir 造 SKILL.md，测 loadSourcedSkills 返回 + 项目级覆盖）。
- `shouldCompact` 触发判断（用 `estimateContextTokens` 对不同长度 messages）。
- `/tree`/`/goto`/`/compact` 命令解析参数。
- compaction 防抖计数器逻辑。

## Acceptance Criteria

- 在 `.novi/skills/` 放 `SKILL.md`（带 frontmatter name/description），启动后其在 system prompt 的 available_skills 段可见（可用一 debug 途径确认，或 `/skills` 若加则列）。同时在 `~/.novi/skills/` 放同名，项目级覆盖。
- 长会话（>contextWindow 阈值的 mock 或真实多轮）触发自动 compaction，`session_compact` 事件在 TUI 体现，compaction 后对话连续不丢当前线索。
- `/compact [instructions]` 手动触发并显示结果。
- `/tree` 列出历史条目；`/goto <id>` 切换分支后 `messages` 刷新到新 leaf，重启/resume 加载该 session 在正确 leaf。
- 全部 slash 命令真实可用（无 "not implemented"）。
- `tsc --noEmit` + `eslint .` + `vitest run` 全绿。

## Out of Scope

- 自定义消息类型、hooks 扩展点、durable recovery。
- 可扩展命令注册器。
- 交互式树选择器 overlay（仅斜杠命令）。
- skills 热重载（启动时加载即可，变更需重启）。
- 多 session 并发隔离。

## Open Questions

无。
