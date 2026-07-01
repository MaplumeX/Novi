# Implement Plan: Skills, compaction, tree nav (child 4)

## Step 1 — resources 加载
- `src/resources.ts`：`loadResources(env, cwd)` 走 `loadSourcedSkills` + `loadPromptTemplates`，用户级 + 项目级，dedupe by name（project 赢）。`~` 自行展开（NodeExecutionEnv 不展开）。
- 用 `env.fileInfo` 过滤不存在目录。

## Step 2 — system prompt 拼 skills
- 改 `src/bootstrap.ts` 的 `makeSystemPromptProvider`：provider 回调收到 `resources`，base 后拼 `formatSkillsForSystemPrompt(resources.skills ?? [])`。
- 改 `bootstrap()`：加载 resources → `await harness.setResources({skills, promptTemplates})`。

## Step 3 — 自动 compaction
- `src/compaction.ts`：`maybeAutoCompact(harness, messages, model)`，`estimateContextTokens` + `shouldCompact` + `DEFAULT_COMPACT_SETTINGS`，防抖 `turnsSinceCompact`。
- `turnsSinceCompact++` 由调用方在 turn_end 钩子算（或移到 maybeAutoCompact 的 settled 入口）。

## Step 4 — useHarnessState 集成
- 订阅 `settled` → `maybeAutoCompact`。
- 订阅 `session_compact` / `session_tree` → `reloadMessages()`（`session.getBranch()` → MessageEntry → setMessages）。
- CommandContext 补 `session`。

## Step 5 — 命令实现
- `commands.ts`：`/compact [instructions]`、`/tree`、`/goto <id>` 真实实现（替换 child 2 占位）。
- `/tree` 用 `session.getEntries()` 列出 id+type+摘要。
- `/goto` 用 `harness.navigateTree(id, {summarize:true})`。

## Step 6 — 测试
- `resources.test.ts`：tmpdir 造 SKILL.md，测加载 + project-over-user dedupe。
- `compaction.test.ts`：`shouldCompact` 触发判断 + 防抖计数器。
- 命令解析（`/compact keep it short`、`/goto abc123`）。

## Step 7 — 验证
- `npm run typecheck`、`npm run lint`、`npm test`。
- 手动冒烟：`.novi/skills/` 放 SKILL.md 启动；长会话触发 auto compact；`/tree`+`/goto`；`/compact`。

## Review Gate
- AC 逐条核验；无 "not implemented" 残留；未越界（不做 hooks/durable/reloader）。

## 风险
- `Model.contextWindow` 字段核对；无则用 200k fallback。
- navigateTree summarize 需调 model，失败给提示。
- 自动 compact 与用户 prompt 竞态 → TUI compact 期间禁用输入。
