# Scaffold harness + minimal TUI (child 1)

**依赖**：无（首个 child）。
**父任务**：`07-01-bootstrap-agent-skeleton`。

## Goal

搭出 `novi` 项目脚手架并实例化 `AgentHarness`，附一个最小 Ink TUI：能跑通单轮真实 LLM 流式对话 + Ctrl-C 中断，session 落盘并可重启加载。为后续 child（tui-shell / builtin-tools / skills-compaction-nav）提供 harness 接线基座。

## Requirements

### R1 项目脚手架
- `package.json`：name `novi`、`bin: novi -> dist/cli.js`、`type: module`、`engines.node ">=22.19.0"`；scripts `build`(tsc)、`dev`(tsx)、`typecheck`(tsc --noEmit)、`lint`(eslint .)、`test`(vitest run)、`format`(prettier)。
- 依赖：`@earendil-works/pi-agent-core` `^0.80.3`、`@earendil-works/pi-ai` `^0.80.3`、`ink ^7`、`react ^19`、`typebox`、`yaml`、`ignore`。
- devDependencies：`typescript`、`tsx`、`eslint`、`prettier`、`vitest`、`@types/react`、`@types/node`。
- `tsconfig.json`：ESM、`moduleResolution: bundler|node16`、`strict`、`jsx: react-jsx`、outDir `dist`。
- 入口：`src/cli.ts`（shebang `#!/usr/bin/env node`），为后续 bin。

### R2 AgentHarness 实例化
- `NodeExecutionEnv({ cwd, shellEnv: process.env })` 构造 env（从 `@earendil-works/pi-agent-core/node` 导入）。
- session：`~/.novi/sessions/<uuidv7>.jsonl`；新建用 `JsonlSessionStorage.create(fs=env, filePath, { cwd, sessionId })` + `toSession(storage)`。`fs` 直接传 env（env 实现 `FileSystem`）。
- models：`createModels()`（pi-ai）；provider key 从环境变量经 pi-ai env-api-keys 自动读取。
- model：CLI flag `--provider` `--model` 选；默认 anthropic + 一个合理默认 model id。
- `systemPrompt`：provider 回调，先读 `.novi/system-prompt.md` → `~/.novi/system-prompt.md` → 内置简短默认。
- 构造 `new AgentHarness({ env, session, models, model, systemPrompt, streamOptions? })`。
- `harness.subscribe()` 接到 TUI 事件处理器。

### R3 最小 Ink TUI
- `src/tui/App.tsx`：Ink `<App>`，单个 `<Text>` 流式显示 assistant 文本 + 一个简单输入（可用 Ink `<TextInput>` 或 stdin readline 兜底）。
- `useEffect` 里 `harness.subscribe(event => setState(...))`；监听 `message_start/update/end`，累积 assistant text_delta 到 state。
- 用户回车提交 → `harness.prompt(text)`（注意 harness 需 idle；非 idle 时先排队或提示）。
- Ctrl-C → `harness.abort()` + 干净退出（监听 raw mode 按键或 SIGINT）。
- 不做多轮历史、不做 Markdown、不做命令解析（留给 child 2）。

### R4 session 持久化
- turn 结束后 session 写入 JSONL（harness 自动 `appendMessage`）。
- 重启后 `JsonlSessionStorage.open(env, filePath)` 能加载历史（本 child 只验证"加载不报错"，不做历史渲染）。

## Acceptance Criteria

- `npm install` 后 `tsc --noEmit` 与 `eslint .` 全绿。
- `tsx src/cli.ts` 能启动；配置有效 provider key 后输入一句话，能看到 assistant 流式输出到终端。
- Ctrl-C 触发 `harness.abort()`，进程干净退出（无悬挂 promise / 无残留 raw mode）。
- `~/.novi/sessions/<id>.jsonl` 文件生成，含 user/assistant 消息条目。
- 重启进程，用 `JsonlSessionStorage.open()` 打开该文件不报错（可在 cli 加 `--resume <path>` 调试 flag 验证，正式 `/resume` 命令在 child 2）。

## Out of Scope

- 多轮历史渲染、Markdown 渲染、命令体系、steering/followUp UI（child 2）。
- 工具集实现（child 3）。
- skills/prompts 加载、compaction、tree nav（child 4）。
- 自动 resume 最近会话。
- 配置文件解析（除 system-prompt.md 外，不做 settings 文件）。

## Open Questions

无。
