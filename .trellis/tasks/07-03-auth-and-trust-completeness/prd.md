# Harness Completeness: Model Auth + Project Trust

## Goal

补全 Novi 相对 pi agent 在「模型与认证」和「安全/信任机制」两块的基础 harness 能力缺口，使 Novi 在不依赖 OAuth 订阅登录的前提下，达到与 pi 对齐的可配置性与安全基线。

## Background

Novi 当前存在两类基础能力缺失：

1. **模型与认证（排除 OAuth）**：只支持 `builtinModels()`，无法添加自定义 provider/model（如 Ollama/vLLM 代理）；transport 选项未透传；steering/followUp 队列投递模式未作为 settings 暴露；无 scoped models 循环（Ctrl+P）；无 `--list-models`。
2. **项目信任机制**：项目级 `.novi/settings.json` 与 `.novi/skills`、`.novi/prompts` 在启动时被无条件加载，无信任 gate，存在第三方项目植入配置/指令的风险。

OAuth 订阅登录（pi 的 `/login` `/logout`，Claude Pro/Max、ChatGPT Plus/Pro Codex、Copilot）**明确排除在本任务之外**，待 pi-ai OAuth 能力边界调研后另立任务。

## Scope（两个子任务）

### Child 1: `07-03-model-auth-enhancements`
- B. 自定义 provider/model：`~/.novi/models.json`（+ project 层）→ `createProvider` + `mutableModels.setProvider`，pi 兼容 schema 子集
- C. Scoped models 循环：settings `scopedModels` 模式列表 + `--models <patterns>` + Ctrl+P 循环 + `/scoped-models` 命令
- D. Transport 选择：settings `transport: sse|websocket|websocket-cached|auto`，bootstrap 经 `setStreamOptions` 透传，`/settings` 可编辑
- E. 队列投递模式暴露：settings `steeringMode`/`followUpMode`（`one-at-a-time`|`all`），bootstrap 经 `setSteeringMode/setFollowUpMode` 应用
- 附带：`--list-models [search]` CLI flag

### Child 2: `07-03-project-trust-gate`
- `~/.novi/trust.json` 信任决策存储（cwd → ask|always|never）
- 启动期 gate：context files（AGENTS.md/SYSTEM.md/APPEND_SYSTEM.md）始终加载；project settings.json + project skills/prompts 在「未信任」时不加载
- `defaultProjectTrust: ask|always|never` settings（全局）
- `/trust` 命令：保存当前 cwd 信任决策（含父目录）
- `--approve`/`--no-approve` CLI flags（单次覆盖）
- headless 模式：无 prompt，按 `defaultProjectTrust` + flags 行为决定是否加载项目资源

## Cross-child Acceptance Criteria

- 两个子任务可分别 plan / implement / check / archive
- 二者共享 `bootstrap.ts`/`cli.ts`/`settings.ts`/`commands.ts`，但改动点不冲突：child 1 集中在 models/stream/options 路径，child 2 集中在 settings/resources 加载前的 trust gate
- 任一子任务独立交付后，Novi 在该维度达到「与 pi 对齐」基线
- 不引入对 pi-ai/pi-agent-core 内部非公开 API 的依赖

## Out of Scope

- OAuth 订阅登录（`/login` `/logout` 及各 provider OAuth 流程）
- Extensions 系统、Pi Packages、主题文件化、自定义键位（其它「补全」项，不在本轮）
- `models.json` 的 `compat.supportsDeveloperRole`/`supportsReasoningEffort` 等细粒度兼容标志（除 pi-ai 当前版本 createProvider/stream 原生支持的字段外，先不做自定义兼容层）

## Open Questions

（见各子任务 prd.md）
