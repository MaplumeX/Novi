# Channel media, Feishu adapter, unified messaging semantics

## Goal

在不破坏现有 Telegram 文本网关与 durable delivery 的前提下：

1. 补齐 Telegram 入站图片 / 文件 / 语音能力（P0）
2. 新增飞书 Channel Adapter，验证 `ChannelAdapter` 抽象可扩展（P1）
3. 统一跨渠道的 **silent / thread / reply** 语义，并写清 bot 流式 edit 契约（P3 MVP）

用户价值：用户可在 Telegram / 飞书用自然语言与多媒体与 Novi 交互；Agent 与 durable 层看到的是稳定、渠道无关的消息语义，而不是各平台私有字段。

## Background / Confirmed Facts

- 已有 `ChannelAdapter` / `ChannelCapabilities` / `ChannelMessage` / `ChannelEvent` 抽象（`src/gateway/core/types.ts`）。
- `ChannelCapabilities.media` 仍是预留字段（Phase 3 reserved）；当前仅 Telegram 工厂实现（`src/gateway/channels/index.ts`）。
- `ChannelConfig` 联合类型目前只有 `TelegramChannelConfig`（`src/gateway/config.ts`）。
- Telegram 入站只注册 `message("text")`；`normalizeMessage` 只映射文本 + `replyToMessageId` + `threadId` + bot mention 元数据（`src/gateway/channels/telegram.ts`）。
- `ChannelMessage` 无 attachments/media 字段；`AgentProtocolTurnInput` 仅有 `text`（`src/gateway/core/types.ts`）。
- TUI 已有图片管线：`PendingImage` → base64 `ImageContent` → `harness.prompt/steer/followUp(..., { images })`（`src/images/encode.ts`、`src/tui/image-submit.ts`、`src/tui/App.tsx`）；Gateway `NoviAgentAdapter` 目前只 `harness.prompt(text)`。
- 静默回复已有最小实现：`isSilentReply` / stream 前缀缓冲 / `cancelStream`（`session-lane.ts`、`routing.ts`）。
- 入站 `replyToMessageId` 会进入 inbox 持久化；出站 `send` 不强制 reply-to 原始消息。
- durable inbox/outbox 当前持久化文本主路径；media blob 不在 store schema 中（`src/gateway/messages/types.ts`）。
- Telegram config 预留 `connectionMode?: "long-poll" | "webhook"`，但实现只有 long-poll（`config.ts` / `telegram.ts`）。
- Gateway 是常驻本机 Node 进程（systemd user service / control socket），不是公网 HTTP 服务。
- 本任务明确不包含跨渠道用户身份绑定（P2）与按渠道工具权限/记忆可见范围（P4）。

## Decisions

| ID | 决策 |
|----|------|
| D1 | 范围 = P0 Telegram media + P1 飞书 + P3 统一语义；不含 P2/P4 |
| D2 | 第二渠道 = 飞书（Lark） |
| D3 | P3 MVP = **silent + thread + reply**；bot 流式 **edit** 仅保留并文档化现有契约；**quote 合并进 reply**；**reaction 本轮不做**；不做用户消息 edited 入站 |
| D4 | 入站媒体混合策略：**图片** 下载后经 `ImageContent` 多模态直通 harness；**文件/语音** 落盘并以路径+元数据注入 turn text；inbox 只存附件元数据/本地引用，不存 blob；无 vision 时对齐 TUI warning + 降级说明 |
| D5 | **不做出站媒体**（Agent 主动发图/文件） |
| D6 | 飞书接入 = **长连接 WebSocket**（官方 Node SDK `@larksuiteoapi/node-sdk`）；企业自建应用，App ID + App Secret 鉴权 |
| D7 | 拆 **parent + 3 children**；执行顺序 `P3 抽象层 → P0 media → P1 feishu` |
| D8 | 飞书本轮**只做文本 + P3 语义**，不做飞书入站媒体 |
| D9 | 出站 reply **不默认**；`ChannelSendTarget.replyToMessageId?` 为可选能力字段，渠道有能力时才真正 reply；不破坏现有 edit-stream placeholder 语义 |

## Task Structure（D7）

Parent 任务（本 prd）只持有源需求、子任务映射、跨 child 验收标准与最终集成评审，不作为实现目标。三个 child 各自独立 prd/design/implement：

| Child | 职责 | 依赖（写在其 prd/implement） |
|-------|------|------|
| `semantics` (P3) | 改 `ChannelMessage` 附件模型占位、`ChannelSendTarget.replyToMessageId?`、统一 silent/thread/reply 契约文档、bot edit-stream 契约文档 | 无（最先执行） |
| `telegram-media` (P0) | Telegram 图片/文件/语音入站、附件下载落盘、图片→harness images、文件/语音→text 注入、inbox 元数据持久化 | 依赖 `semantics` 的 `ChannelMessage` 附件模型与 `AgentProtocolTurnInput` 扩展 |
| `feishu-adapter` (P1) | 飞书长连接 Adapter（文本入站/出站 + P3 语义），验证抽象可扩展 | 依赖 `semantics` 的 `ChannelSendTarget.replyToMessageId?` 与 thread/reply 契约；不做媒体 |

## Requirements

### R-scope

- R-S1：交付范围 = P0 + P1 + P3（按 D3）。
- R-S2：不实现 Discord / Slack / WhatsApp 等其他渠道。
- R-S3：不实现跨渠道 identity binding、不实现 per-channel tool/memory policy。
- R-S4：不做出站媒体（D5）。
- R-S5：不做出站强制 reply（D9）。

### R-P0 Telegram media

- R-M1：Telegram 可接收图片、普通文件、语音消息（含 caption / 无 caption）。
- R-M2：媒体进入统一 `ChannelMessage` 附件模型（类型、mime、size、filename、本地路径/引用等），不藏在自由 `metadata`。
- R-M3：Agent 消费（D4）：图片 → `AgentProtocolTurnInput` 扩展 images，经 `NoviAgentAdapter` 调 `harness.prompt(text, { images })`；文件/语音 → 落盘并以路径+元数据注入 turn text。
- R-M4：不支持的消息类型（sticker/动画/视频等）可诊断、不崩溃；不伪造成成功媒体。
- R-M5：durable inbox 仅持久化附件元数据 + 本地引用，不把 base64/blob 写入 JSON store。

### R-P1 Feishu adapter

- R-F1：配置、工厂、启动/停止、probe、入站文本、出站文本完整闭环。
- R-F2：实现足以验证抽象的能力声明与差异（是否 edit-stream、thread 语义）。
- R-F3：与现有 allowlist/pairing、session route、durable delivery 兼容。
- R-F4：支持入站文本 + 已批准 P3 语义（silent/thread/reply）；不做飞书入站媒体（D8）。
- R-F5：传输 = 长连接 WebSocket（D6）；鉴权 = 企业自建应用 App ID + App Secret。
- R-F6：飞书长连接 3 秒处理时限 → `emitMessage` 必须 fire-and-forget，依赖 durable inbox 兜底重投（与 Telegram 同构）。

### R-P3 Unified messaging semantics

- R-U1 **silent**：统一 silent markers 与 `cancelStream` 行为；Telegram/飞书一致。
- R-U2 **thread**：`ChannelMessage.threadId` / `ChannelSendTarget.threadId` 语义文档化；飞书映射到其 thread/topic 模型（或明确不支持时 `capabilities.threads=false`）。
- R-U3 **reply**：入站保留/统一 `replyToMessageId`（quote 不另建模）；出站 `ChannelSendTarget.replyToMessageId?` 可选（D9），渠道有能力时才真正 reply。
- R-U4 **edit（bot stream only）**：现有 `capabilities.edit` + `sendEvent` 流式编辑契约写清；不实现用户消息 edited 入站。
- R-U5 **out of P3**：reaction、独立 quote 模型、用户消息 edit 入站。

## Acceptance Criteria

### 跨 child（parent 集成）

- [x] AC-S1：P0 + P1 + P3 均有 child 实现与测试覆盖；parent 做最终集成评审。
- [x] AC-S2：reaction / quote 独立模型 / 用户消息 edit 入站 / 出站媒体 / 出站强制 reply / P2 / P4 不出现在交付中。
- [x] AC-I1：三 child 合并后 `npm run typecheck && npm test` 全绿（1101 tests, 121 files）。
- [x] AC-I2：Telegram 文本网关与 durable delivery 现有行为回归无破坏。

### P0 Telegram media

- [x] AC-M1：图片/文件/语音消息入站并归一化为统一附件模型（类型/mime/size/filename/路径）。
- [x] AC-M2：图片进入 harness 多模态路径（`harness.prompt(text, { images })`）；无 vision 模型时给出 warning + 降级说明。
- [x] AC-M3：文件/语音落盘，turn text 携带可操作路径与元数据。
- [x] AC-M4：inbox 持久化记录不含媒体 blob（仅元数据/本地引用）。
- [x] AC-M5：不支持的消息类型可诊断、不崩溃。

### P1 Feishu adapter

- [x] AC-F1：飞书配置入 `gateway.json`，工厂可创建；`start/stop/probe` 闭环。
- [x] AC-F2：入站文本 → `ChannelMessage` → session lane → 出站文本闭环。
- [x] AC-F3：`ChannelCapabilities` 声明与 Telegram 有差异（edit-stream / threads），并真实反映飞书能力。
- [x] AC-F4：与 allowlist/pairing/session route/durable delivery 兼容（既有测试套件不破）。
- [x] AC-F5：P3 silent/thread/reply 在飞书侧行为与 Telegram 一致（按能力声明）。

### P3 Unified semantics

- [x] AC-U1：silent markers + `cancelStream` 行为在 Telegram/飞书一致，有契约文档。
- [x] AC-U2：thread 语义文档化；飞书 thread/topic 映射明确（支持或 `threads=false`）。
- [x] AC-U3：`ChannelSendTarget.replyToMessageId?` 可选字段落地；不默认 reply；不破坏 edit-stream。
- [x] AC-U4：bot 流式 edit 契约文档化（`capabilities.edit` + `sendEvent`）。

## Out of Scope

- 跨渠道用户身份绑定（P2）
- 按渠道配置工具权限与记忆可见范围（P4）
- 除飞书外的新渠道
- 出站媒体（Agent 发图/文件）
- 出站强制 reply / 独立 quote 模型 / 用户消息 edited 入站
- Reaction 统一语义
- 飞书入站媒体
- 多租户 / 商业级合规媒体归档
- 改变 Telegram 至少一次投递语义

## Notes

- 复杂度判定：**复杂任务** — parent + 3 children（D7），每个 child 各需 prd/design/implement。
- 执行顺序：P3 抽象层（`semantics`）→ P0 media（`telegram-media`）→ P1 feishu（`feishu-adapter`）。
- 参考：OpenClaw Channels、Hermes Messaging Gateway（外部设计对照，不直接复制实现）。