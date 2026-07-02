# A: config & personalization (settings + AGENTS.md + SYSTEM.md + /settings form + /reload)

## Goal

引入 Novi 的配置与个性化基础层：settings 文件（全局/项目合并）、context files（AGENTS.md 自动加载）、system prompt 文件约定（SYSTEM.md 替换 / APPEND_SYSTEM.md 追加）、交互式 `/settings` 表单、`/reload` 命令。使 agent「可个性化」，并为后续 child（B harness 重建重放、F retry 配置）提供基础设施。

**依赖关系**：本 child 无前置依赖，是 parent 的第 1 个 child。产出 `src/settings.ts` + `HarnessHandle` + overlay 抽象，被 child 4（session-management）与 child 7（observability）复用。详见 parent `design.md`。

## Background — 已确认事实

### 当前 Novi 配置现状

- provider/model/thinking 全靠 CLI flag 或 `bootstrap.ts` 硬编码默认（`DEFAULT_PROVIDER`/`DEFAULT_MODEL_ID`）。
- system prompt provider 读 `.novi/system-prompt.md` → `~/.novi/system-prompt.md` → `DEFAULT_SYSTEM_PROMPT`，无 SYSTEM.md/APPEND 约定。
- 无 AGENTS.md 自动加载。
- 无 settings 文件。
- `<App>` 直接收 harness props 固化，无 harness holder / 替换机制。
- `/new` `/resume` 是 stub（不属于本 child，但 `/reload` 需要类似 harness 重建机制）。

### pi 参考（已研读 docs）

- `~/.pi/agent/settings.json` + `.pi/settings.json` 全局/项目合并，嵌套对象浅合并。
- AGENTS.md 从 `~/.pi/agent/AGENTS.md` + parent dirs → cwd 加载。
- `.pi/SYSTEM.md`（项目）/ `~/.pi/agent/SYSTEM.md`（全局）替换默认 prompt；`APPEND_SYSTEM.md` 追加。
- `/settings`：交互式 TUI 表单（编辑器区临时替换为表单，改 thinking/theme/compaction/retry 等，写入磁盘）。
- `/reload`：重载 keybindings/extensions/skills/prompts/context files。

### 技术约束

- `AgentHarness` 无 session 热切 API（见 `research/harness-session-swap.md`），`/reload` 需重建 harness + 重绑订阅 + 重放状态。
- pi-agent-core 已导出 `loadSourcedSkills` / `loadPromptTemplates`（Novi 已用）。
- `AgentHarness.setStreamOptions({ maxRetries, timeoutMs, maxRetryDelayMs })` 可用于 retry 配置（但 retry 字段在本 child 只定义 + 透传，实际消费由 child 7 完成）。
- `formatSkillsForSystemPrompt` 已用于 system prompt provider。

## Requirements

### R1 settings 文件加载与合并
- 加载 `~/.novi/settings.json`（全局）+ `<cwd>/.novi/settings.json`（项目），嵌套对象浅合并，项目覆盖全局。
- 强类型 `NoviSettings`：`defaultProvider` / `defaultModel` / `defaultThinkingLevel` / `compaction.{enabled,reserveTokens,keepRecentTokens}` / `retry.provider.{timeoutMs,maxRetries,maxRetryDelayMs}`。
- `ResolvedSettings` 附带 `_sources` 标注每个键来源层（global/project/cli/default），供 `/settings` 表单显示。
- CLI flag（`--provider`/`--model`/`--thinking`）覆盖 settings；settings 覆盖内置默认。
- 文件不存在/解析失败：降级到默认 + stderr warning（不阻塞启动）。

### R2 bootstrap 接线 settings
- `bootstrap.ts` 读 settings 作为 provider/model/thinking 默认来源；CLI flag 覆盖。
- compaction 配置注入 `AutoCompactor`（若 settings.compaction 存在）。
- retry.provider 配置在 harness 构造后调 `setStreamOptions`（child 7 消费，本 child 先打通透传）。

### R3 context files (AGENTS.md) 自动加载
- 启动从 `~/.novi/AGENTS.md`（全局）+ 从 cwd 向上遍历父目录找 `AGENTS.md` + `<cwd>/AGENTS.md` 加载。
- 去重（同一绝对路径不重复加载）。
- 内容拼接到 system prompt 输出末尾（在 skills block 之前）。
- 可被 `/reload` 重新扫描。

### R4 system prompt 文件约定 (SYSTEM.md / APPEND_SYSTEM.md)
- `.novi/SYSTEM.md`（项目）/ `~/.novi/SYSTEM.md`（全局）：**替换**默认 system prompt（保留 skills + contextFiles 拼接）。项目 > 全局 > 默认。
- `.novi/APPEND_SYSTEM.md` / `~/.novi/APPEND_SYSTEM.md`：**追加**到 base prompt 末尾（skills 之前）。两层都存在则都追加（项目在前）。
- 兼容：旧的 `.novi/system-prompt.md` / `~/.novi/system-prompt.md` 保留读取作为 fallback，但文档/`/help` 推荐 SYSTEM.md。

### R5 交互式 `/settings` 表单
- `/settings` 命令：编辑器区临时替换为可滚动表单。
- 表单字段：defaultProvider / defaultModel / defaultThinkingLevel / compaction.* / retry.provider.*。
- 表单交互：上下移动选中项、Enter 编辑、Esc 退出（不保存）；保存提示（保存到全局还是项目 settings.json）。
- 保存：写入对应 settings.json（不存在则创建），JSON 格式化；保存后提示「已写入，/reload 生效」或自动触发 reload。
- 引入 overlay 抽象（见 parent design.md §2）：`Overlay = null | { kind: "settings" }`，`<App>` 根据 overlay 决定渲染 `<SettingsForm>` 还是 `<InputBox>`。

### R6 `/reload` 命令
- `/reload`：重新加载 settings + skills + prompts + context files。
- 实现：重建 harness（reuse HarnessHandle.replace）→ 重放状态（tools/resources/model/thinking/streamOptions）→ 重绑订阅。
- 复用 `replayHarnessState(newHarness, oldHarness, env, cwd, settings)`——此函数是 child 1 产出，child 4 session 切换也复用。
- 完成后 TUI 反映新状态（messages 重新从 session branch 重载）。

### R7 HarnessHandle 抽象
- `<App>` 从直接收 harness props 改为收 `HarnessHandle`（含 `harness` / `session` / `sessionPath` / `replace()`）。
- `useHarnessState` 改为依赖 `handle.harness`（变化时重订阅）+ `handle.session`（变化时重载 branch）。
- `replace()` 流程：unsubscribe 旧 → `JsonlSessionRepo` 或 reuse session → `new AgentHarness` → `replayHarnessState` → setState。
- 这是 `/reload`（本 child）和 `/new` `/resume`（child 4）的共享基础。

## Acceptance Criteria

- [ ] `~/.novi/settings.json` 与 `.novi/settings.json` 都存在时，`/settings` 表单显示合并后的值 + 各字段来源标注。
- [ ] `--provider`/`--model` CLI flag 覆盖 settings 里的 `defaultProvider`/`defaultModel`。
- [ ] settings.json 解析失败时 stderr 输出 warning 且不阻塞启动。
- [ ] `<cwd>/AGENTS.md` 内容出现在 system prompt（可通过 `/help` 或 LLM 提问验证）；父目录的 AGENTS.md 也被加载。
- [ ] `.novi/SYSTEM.md` 存在时替换默认 prompt；`.novi/APPEND_SYSTEM.md` 追加到 base prompt 末尾。
- [ ] 旧的 `.novi/system-prompt.md` 仍可用（兼容）。
- [ ] `/settings` 打开表单，可上下移动、Enter 编辑字段、Esc 退出、保存写入 settings.json。
- [ ] `/reload` 重载 settings/skills/prompts/context files，TUI 反映新状态（message list 重载）。
- [ ] harness 重建后事件订阅不泄漏（发消息后事件只触发一次，见 parent implement.md R1）。
- [ ] overlay 非空时 InputBox 不处理输入（无重复按键）。
- [ ] `tsc --noEmit` + `eslint` + `vitest` 全绿。

## Out of Scope

- retry 配置的实际消费（child 7 observability 完成；本 child 只打通 settings 透传到 `setStreamOptions`）。
- session 切换 `/new` `/resume`（child 4；本 child 只产出 HarnessHandle + replayHarnessState 作为基础设施）。
- `@file` / `!`/`!!` 等编辑器能力（child 2；本 child 的 overlay 抽象会被 child 2 的 filePicker 复用，但 filePicker 本身不在本 child）。
- keybindings / themes / trust（I 主题，后置）。

## Technical Notes

- 详细设计见 parent `design.md` §1 Settings层、§2 Overlay抽象、§3 HarnessHandle、§4 ContextFiles、§5 SYSTEM.md。
- 本 child 的 `design.md` 细化 settings 类型 + overlay 状态机 + `/settings` 表单字段映射 + replayHarnessState 签名。
- 本 child 的 `implement.md` 给出文件改动清单 + 验证命令。
