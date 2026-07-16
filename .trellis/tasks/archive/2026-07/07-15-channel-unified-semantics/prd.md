# Unify silent/thread/reply semantics across channels

> Parent: `07-15-channel-media-feishu-semantics`. 执行顺序第一棒（P3 抽象层）。
> 下游依赖：`07-15-telegram-media` 与 `07-15-feishu-adapter` 依赖本任务的契约改动。

## Goal

在 `ChannelMessage` / `ChannelSendTarget` / `ChannelCapabilities` / `AgentProtocolTurnInput` 上落地 silent / thread / reply 的统一语义，并把 bot 流式 edit 契约写清，使 Telegram 与飞书能以同一抽象表达这三类交互。

## Background / Confirmed Facts

- `ChannelMessage` 已有 `threadId?` / `replyToMessageId?`；`ChannelSendTarget` 已有 `threadId?`，无 reply-to（`src/gateway/core/types.ts`）。
- silent 已有 `isSilentReply` + stream 前缀缓冲 + `cancelStream`（`session-lane.ts`、`routing.ts`），行为已基本统一，缺契约文档。
- bot edit-stream：`capabilities.edit` + `sendEvent(text-delta)` + `send` 最终 flush（`telegram.ts`），契约未文档化。
- `ChannelCapabilities.media` 预留但未定义附件模型。
- 出站 `send` / durable delivery / outbox schema 目前只携带 text + target（`messages/types.ts`、`sink.ts`、`delivery.ts`）。
- 决策来源 parent：D3（P3=silent+thread+reply，edit 仅文档化，quote 合并 reply，reaction/edit-inbound 不做）、D9（出站不默认 reply，`ChannelSendTarget.replyToMessageId?` 可选）。

## Requirements

### R-U1 silent
- R-U1.1：silent markers 集合与 `cancelStream` 行为统一到 `core` 层（已基本到位），补契约文档：silent 触发条件、stream placeholder 取消时机、跨渠道一致要求。
- R-U1.2：不在本任务新增新 marker；保持现有 `SILENT/[SILENT]/NO_REPLY/NO REPLY`。

### R-U2 thread
- R-U2.1：文档化 `ChannelMessage.threadId` / `ChannelSendTarget.threadId` 的渠道无关语义（topic/thread 标识，无则 undefined）。
- R-U2.2：`ChannelCapabilities.threads` 用于声明渠道是否支持 thread；不支持的渠道收到 threadId 时应安全忽略（不崩溃）。

### R-U3 reply
- R-U3.1：入站 `ChannelMessage.replyToMessageId?` 保持；quote 不另建模。
- R-U3.2：出站新增可选 `ChannelSendTarget.replyToMessageId?: string`（D9）；`send`/`sendFinalChunk`/durable sink/delivery 透传该字段；渠道有能力且字段存在时才真正 reply-to，否则忽略。
- R-U3.3：不改变默认行为（默认不 reply）；edit-stream placeholder 路径不 reply。
- R-U3.4：outbox/inbox schema 若需携带 replyTo 则做向后兼容的字段扩展（optional）。

### R-U4 edit（bot stream only）
- R-U4.1：文档化 bot 流式编辑契约：`capabilities.edit=true` 的渠道用 `sendEvent(text-delta)` 累积 + `send` flush；`sendEvent` 可选、`cancelStream` 可选。
- R-U4.2：明确不实现用户消息 edited 入站。

### R-U5 附件模型占位
- R-U5.1：为 P0 media 预留，定义 `ChannelMessage.attachments?` 字段形状（类型/mime/size/filename/本地引用），但本任务只在 `types.ts` 落型定义 + 文档；Telegram 实际填充由 `07-15-telegram-media` 负责。
- R-U5.2：`AgentProtocolTurnInput` 扩展 `images?: ImageContent[]`（对齐 TUI 既有 `ImageContent`），供下游 child 使用；本任务只改类型与 adapter 透传契约，不实现 Telegram 下载。

### R-U6 不做
- reaction、独立 quote 模型、用户消息 edited 入站、出站媒体、出站强制 reply。

## Acceptance Criteria

- [ ] AC-U1：`ChannelSendTarget.replyToMessageId?` 落地；`send`/`sendFinalChunk`/durable sink/delivery 透传不破现有测试。
- [ ] AC-U2：`ChannelCapabilities.threads` 语义文档化；不支持 thread 的渠道收到 threadId 不崩溃。
- [ ] AC-U3：silent 行为跨渠道一致并有契约文档（markers + cancelStream 时机）。
- [ ] AC-U4：bot 流式 edit 契约文档化（capabilities.edit + sendEvent + send flush）。
- [ ] AC-U5：`ChannelMessage.attachments?` 与 `AgentProtocolTurnInput.images?` 类型定义落地，类型可编译。
- [ ] AC-U6：`npm run typecheck && npm test` 全绿；现有 Telegram 文本路径回归无破坏。
- [ ] AC-U7：不出现 reaction / quote 独立模型 / 用户消息 edit 入站 / 出站媒体 / 出站强制 reply。

## Out of Scope

- Telegram 实际下载/落盘/填充 attachments（属 `07-15-telegram-media`）
- 飞书 Adapter 实现（属 `07-15-feishu-adapter`）
- reaction / quote 独立模型 / 用户消息 edit 入站 / 出站媒体 / 出站强制 reply

## Notes

- 本任务是契约/抽象层先行，不交付端到端新功能；下游两 child 在此契约上实现。
- 复杂任务：需 `design.md`（字段/契约/兼容性）+ `implement.md`（按文件改动清单）后 `task.py start`。