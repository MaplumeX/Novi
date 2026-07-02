# novi first-run provider onboarding

## Goal

让 Novi agent 在尚未配置模型供应商时，首次启动能进入引导式配置流程（选择供应商、配置凭证），配置完成后续续启动，而不是像现在这样因缺少 API key 直接报错退出。已经配置好的用户启动时不触发引导。

## Background（代码现状）

- `src/cli.ts`：`bootstrap()` 抛错时被 try/catch 捕获，调用 `fail()` 以退出码 1 结束进程。
- `src/bootstrap.ts` `resolveModel()`：在 `await models.getAuth(model)` 返回 falsy 时抛 `provider "X" is not configured (no API key found)`，这是当前阻断启动的点。
- `src/settings.ts`：`NoviSettings` 只持久化 `defaultProvider` / `defaultModel` / `defaultThinkingLevel` 等，**不存储 API key**。提供 `loadSettings` / `resolveSettings` / `writeSettings`（点路径 patch）。
- `src/tui/SettingsForm.tsx`：已存在的配置表单，编辑 settings.json 的 9 个字段，provider/model 是自由文本输入，不涉及 API key 录入。
- `src/tui/App.tsx`：用 overlay 机制切换不同全屏视图（settings / filePicker / sessionPicker）。
- 凭证来源：pi-ai 通过环境变量读取 API key。`@earendil-works/pi-ai` 暴露 `findEnvKeys(provider, env)` / `getEnvApiKey(provider, env)`，能查询某 provider 对应的环境变量名与已设值。pi-ai 内置约 35 个 provider。

## Requirements

- R1 启动时检测：若当前 provider（settings 或默认 anthropic）无可用凭证（`getAuth` 失败），则进入首次配置引导，而非退出。
- R2 引导是独立的 wizard 组件（不复用 SettingsForm 全量表单），引导用户：选择供应商 → 配置该供应商所需的凭证 → 选择模型（必选，高亮推荐默认项） → 完成。
- R3 已配置可用的用户启动时不触发引导，直接进入正常流程。
- R4 引导完成后，agent 用新配置继续启动（进入 TUI / headless），无需重启。
- R5 headless 模式（--print / --mode json）下发现无凭证时，不触发向导，而是输出友好指引后退出（提示用户运行 TUI 模式的 `novi` 进行配置，或设置相应环境变量）。

## Acceptance Criteria

- [ ] AC1 全新环境（无 settings.json、无相关环境变量）下运行 `novi`，进入引导向导而非退出报错。
- [ ] AC2 在引导中选完供应商并填入可用凭证后，无需重启即进入正常 TUI 且能发起对话。
- [ ] AC3 已有可用凭证的环境下运行 `novi`，不出现引导，直接进入正常流程。
- [ ] AC4 引导中可中断退出（Esc/Ctrl-C），不卡死。
- [ ] AC5 引导写入的内容可通过 `/settings` 复查与修改。

## Out of Scope

- 不重写 SettingsForm 现有字段编辑能力。
- 不改变已配置用户的启动路径。
- 不新增 `/setup` 手动触发命令（后续 follow-up）。

## Technical Notes

- Q1 决议：选方案 B —— 引导直接持久化 API key。新增凭证存储机制（位置/格式见 design.md），启动时把存储值注入 `process.env` 供 pi-ai 读取。文件权限 0600。
- Q3 决议：引导向导展示全部内置 provider，按字母排序。
- Q4 决议：选方案 A —— 独立文件 `~/.novi/credentials.json`（类 .env 风格），与 settings.json 物理分离。启动时注入 `process.env`，`/settings` 增加只读脱敏展示。
- Q5 决议：选方案 A —— headless 无凭证时输出友好指引后退出码 1，不启动交互向导。

## Open Questions

（暂无阻塞问题）
