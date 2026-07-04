# Novi multi-channel gateway

## Goal

让 Novi agent 能够接入 Telegram 等多个 IM 渠道，用户可以在 IM 里与 Novi agent 对话，复用现有的 agent 能力（工具调用、流式回复、steer/follow-up/abort）。MVP 阶段接入 Telegram，飞书不在此次范围。

## Background

Novi 当前是进程内 harness（`AgentHarness`），三种运行模式（TUI / print / json）。本任务新增第四种模式 `--gateway`：一个长驻进程，通过渠道适配器接入 IM 平台，复用现有 bootstrap 装配与 harness 公共 API。

研究过五个开源多渠道 agent 网关（pi-gateway / tia-gateway / imtoagent / OpenClaw / Hermes）后确定的设计方向：
- 渠道抽象：`ChannelAdapter` 接口 + `ChannelCapabilities` 能力声明（学 OpenClaw）
- 4 种队列模式：steer / followup / collect / interrupt（学 OpenClaw，Novi harness 天然支持 steer/followUp/abort）
- 两级消息 guard + 命令 bypass（学 Hermes）
- 多层授权：allowlist（MVP）+ pairing（预留）（学 Hermes）
- 媒体安全：入站 MIME 嗅探 + 大小限制（学 OpenClaw），出站路径 denylist（学 Hermes）
- 进程内网关（MVP）→ 预留向进程外演进

## Confirmed Facts

- Novi `AgentHarness` 的 `steer` / `followUp` / `nextTurn` / `abort` 可在 turn 中调用；`prompt` / `compact` 需 `phase==="idle"`（见 `.trellis/spec/backend/pi-agent-core-api.md`）
- `bootstrap.ts` 步骤 4-12 可拆分：env/models/tools/resources 准备（一次）与 harness+session 创建（多次）分离，TUI 路径仍调一次
- `headless/events.ts` 的 `projectEvent` / `extractText` 是事件投影逻辑，网关侧可复用作为"唯一事件边界"
- `JsonlSessionRepo` 支持 per-session 创建/打开
- `makeSystemPromptProvider(cwd)` 可扩展接受渠道上下文
- `fetch_content` 已有 SSRF guard（`web-search/ssrf.ts`）可复用

## Requirements

### 功能需求

- **R1 运行模式**：新增 `novi --gateway` 模式，加载 `gateway.json` 配置，启动渠道适配器与网关编排
- **R2 渠道抽象**：定义 `ChannelAdapter` 接口 + `ChannelCapabilities` 能力声明，渠道实现该接口
- **R3 Telegram 渠道**：实现 Telegram 渠道适配器（长轮询，文本收发，edit-message 流式）
- **R4 会话路由**：per-sessionKey（`channelId:chatId`）懒创建 harness，复用 bootstrap 装配
- **R5 队列模式**：实现 steer / followup / interrupt 三种模式（collect 留后续），复用 harness 公共 API
- **R6 流式回传**：harness 事件经 event-bridge 投影为 `ChannelEvent`，按渠道能力选择 edit-stream 或攒批 send
- **R7 斜杠命令**：`/new` `/stop` `/help` 等，bypass 队列 inline 派发
- **R8 授权**：sender allowlist（MVP），未授权用户拒绝
- **R9 配置**：`~/.novi/gateway.json` + `<cwd>/.novi/gateway.json`（项目层受 trust 门控），`${ENV}` 展开

### 非功能需求

- **N1 依赖方向单向**：`gateway/` 只依赖 `AgentHarness` 公共 API + 渠道 SDK，不碰 TUI 内部
- **N2 事件边界单一化**：`event-bridge.ts` 是网关侧唯一 harness 事件投影点
- **N3 失败降级不阻断**：单渠道启动失败 → diagnostic + skip，不崩网关
- **N4 无数据库**：会话路由 in-memory `Map`，session 走现有 `JsonlSessionRepo`
- **N5 配置分层 + trust 门控**：与 `settings.json` 同模式

## Out of Scope

- 飞书（Lark）渠道
- Discord / WeChat / WhatsApp 等其他渠道
- 媒体收发（图片/文件/语音）—— 后续 Phase
- DM pairing 授权流程 —— 预留接口，MVP 只做 allowlist
- collect 模式的 debounce 合并 —— MVP 先做 steer/followup/interrupt，collect 后续
- 跨平台投递 / cron home channel —— 后续 Phase
- 进程外网关（ACP server）—— 后续演进，接口预留
- 渠道插件化注册（register(ctx)）—— MVP 用编译期 switch 工厂

## Acceptance Criteria

- [ ] `novi --gateway --config ~/.novi/gateway.json` 能启动网关进程，连接 Telegram bot
- [ ] 在 Telegram 私聊发消息，能收到 Novi agent 的回复
- [ ] agent 回复以流式 edit-message 呈现（Telegram `edit:true` 能力）
- [ ] agent 运行中发新消息：默认 steer 模式注入当前 turn
- [ ] `/stop` 命令能 abort 当前 run
- [ ] `/new` 命令能重置 session
- [ ] 未在 allowlist 的用户被拒绝
- [ ] 单渠道启动失败不崩网关（diagnostic + skip）
- [ ] `gateway.json` 支持 `${TELEGRAM_BOT_TOKEN}` 环境变量展开
- [ ] 网关进程 Ctrl+C 优雅退出（关闭渠道 + 释放 harness）
- [ ] typecheck + lint + test 通过

## Decisions

- **D1 harness 实例管理**：per-sessionKey（`channelId:chatId`）懒创建独立 `AgentHarness` + `JsonlSession`，复用 bootstrap 步骤 1-3 的一次性准备（env/credentials/settings/models/tools/resources），步骤 5-9 的 session+harness 创建做成 per-key。空闲超时（默认 24h）关闭 harness + close session。上限并发 session 数（默认 10），超限淘汰最老空闲 session。

- **D2 Telegram SDK**：`telegraf` 长轮询模式。成熟稳定、TS 类型完善、长轮询开箱即用、`editMessageText` 原生支持流式。webhook 模式后续可加 `connectionMode` 配置项。

- **D3 默认队列模式**：默认 `steer`。MVP 实现 steer / followup / interrupt 三模式（复用 harness `steer()`/`followUp()`/`abort()`），collect 模式（debounce 合并）留后续。配置 `queue.mode` + `queue.byChannel.telegram` 覆盖，与 OpenClaw 对齐。

- **D4 流式 edit 呈现**：1s 节流 edit-stream。agent 回复开始时 `sendMessage` 占位拿到 messageId，后续 text-delta 累积到缓冲区按 1s 节流 `editMessageText`，`message_end` 做最后一次写入完整文本。超 4096 UTF-16 分多条续发（`textChunkLimit`）。节流间隔配置项 `stream.editIntervalMs`（默认 1000）。不支持 edit 能力的渠道降级为攒批 send。

- **D5 agent 配置来源**：复用现有 `settings.json` + `credentials.json` + `models.json` 信任门体系。网关模式按 headless 规则解析 trust（`ask`→`never`），未配置凭证直接 fail 并打印指引（同 `--print`/`--mode json` 路径，不弹 onboarding wizard）。`gateway.json` 与 `settings.json` 并列独立加载，只管渠道和网关编排，agent model/credentials 完全来自现有配置层。`--gateway` 接受 `--provider`/`--model`/`--approve`/`--no-approve` 等现有 CLI flag。