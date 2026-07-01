# Implement Plan: Bootstrap pi-agent TUI skeleton (parent)

parent 任务不直接实现，只编排 4 个 child 任务的执行顺序、review gate 与交叉验收。每个 child 在自己的 task 目录里有独立的 prd/design/implement。

## Child 编排顺序

严格依序启动 child 1 → 2 → 3 → 4。child 3 可与 child 2 半并行（都只依赖 child 1），但建议串行执行避免 TUI/tools 同时改动收敛困难。child 4 依赖 child 1（harness）+ child 2（命令体系），必须最后。

### Step 0 — 建子 task（一次性，在 parent 规划完成后）

```bash
PARENT=.trellis/tasks/07-01-bootstrap-agent-skeleton
python3 ./.trellis/scripts/task.py create "Scaffold harness + minimal TUI" --slug scaffold-harness --parent "$PARENT"
python3 ./.trellis/scripts/task.py create "TUI shell: multi-turn, markdown, commands" --slug tui-shell --parent "$PARENT"
python3 ./.trellis/scripts/task.py create "Built-in tools set" --slug builtin-tools --parent "$PARENT"
python3 ./.trellis/scripts/task.py create "Skills loading, compaction, tree nav" --slug skills-compaction-nav --parent "$PARENT"
```

各 child 的 `prd.md` 必须在开头写明依赖（"依赖 child N 的产出 X"）。

### Step 1 — child 1: scaffold-harness

**依赖**：无。
**范围**：package.json/tsconfig/入口/bin + `NodeExecutionEnv` + `JsonlSessionStorage` + `createModels` + `AgentHarness` 实例化 + 最小 Ink App（单轮 prompt + 流式 + Ctrl-C abort）。
**review gate**: `tsx src/cli.ts` 能跑通一轮真实 LLM 流式对话；Ctrl-C 触发 `harness.abort()` 并干净退出；session 文件落盘并可被 `JsonlSessionStorage.open` 重开。
**验证命令**: `tsc --noEmit`、`eslint .`、`tsx src/cli.ts`（手动冒烟）。

### Step 2 — child 2: tui-shell

**依赖**：child 1 的 harness 接线。
**范围**：多轮历史渲染、assistant 流式 Markdown（marked + 手写 token→Ink 渲染器）、用户输入框、steering/followUp UI、abort、命令体系最小集+体验增强、StatusBar。
**review gate**: 多轮对话 Markdown 正确；`/compact /tree /goto /new /resume /help /quit /abort /model /thinking /tools /history` 解析且各调对应 harness API；`queue_update` 在 StatusBar 体现。
**验证命令**: `tsc --noEmit`、`eslint .`、手动冒烟各命令。

### Step 3 — child 3: builtin-tools

**依赖**：child 1 的 harness（能 setTools）。
**范围**：实现 8 个工具（read_file/write_file/edit_file/bash/ls/glob/grep/todo）+ typebox schema + `setTools`/`setActiveTools` 接线 + `/tools`。
**review gate**: agent 能调工具完成混合任务（读→改→跑命令→报告）；`/tools` 正确列出 active tools；参数校验与错误按 harness throw-error 约定。
**验证命令**: `tsc --noEmit`、`eslint .`、`vitest run`（纯逻辑单测）、手动冒烟。

### Step 4 — child 4: skills-compaction-nav

**依赖**：child 1（harness、resources API）+ child 2（命令体系入口）。
**范围**：skills/prompts 加载（`loadSkills`/`loadPromptTemplates`/`loadSourcedSkills`，~/.novi + .novi 两层，去重）+ `setResources` + `formatSkillsForSystemPrompt` 注入；compaction auto（`settled` 后 `shouldCompact()`）+ `/compact`；tree nav `/tree`/`/goto <id>` 调 `navigateTree`。
**review gate**: 放 `SKILL.md` 能在 system prompt 出现；长会话触发自动 compaction 且继续对话连续；`/tree` 列树、`/goto` 切分支后在 UI 生效。
**验证命令**: `tsc --noEmit`、`eslint .`、`vitest run`（加载器/compaction 判断单测）、手动冒烟。

### Step 5 — Parent 交叉验收

全部 child 完成后按 prd 的 Acceptance Criteria（Parent 交叉验收）逐条核验：启动、多轮+Markdown、混合工具任务、session resume、auto compact、tree nav、skills 加载、tsc+eslint+vitest 全绿。

## Review Gate（parent 级）

- 每个 child 完成后，确认它的 prd 验收 + parent 对应行的交叉准则都过，再进下一个 child。
- 若某 child 暴露 parent 设计缺陷（如 harness API 与预期不符），回 parent Phase 1 修 prd/design，再回 child 继续。

## 风险点

- **Ink + harness 命令式事件流的 React 渲染时序**：`message_update` 高频，需避免每次 setState 触发全量 Markdown 重渲染；design.md 已记，child 2 设计时细化（流式期间用纯文本累积，`message_end` 再 Markdown 渲染）。
- **harness phase 与 TUI 命令竞态**：用户在 turn 中点 `/compact` 会被 harness busy 拒；TUI 需禁用 + 提示。
- **`@earendil-works/pi-agent-core` 当前是 0.80.x，API 可能变**：锁 `^0.80.3`，child 1 实施时核对实际导出与设计文档一致。

## 验证命令汇总（parent 最终）

```bash
npm run typecheck   # tsc --noEmit
npm run lint        # eslint .
npm test            # vitest run
tsx src/cli.ts      # 交互式冒烟
```
