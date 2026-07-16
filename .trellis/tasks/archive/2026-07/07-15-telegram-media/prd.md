# Telegram inbound media (image/file/voice)

> Parent: `07-15-channel-media-feishu-semantics`. 执行顺序第二棒（P0）。
> 依赖：`07-15-channel-unified-semantics`（`ChannelMessage.attachments?` / `AgentProtocolTurnInput.images?` 契约）。

## Goal

让 Telegram Channel Adapter 可接收图片、普通文件、语音消息，归一化为统一附件模型，并按混合策略（D4）交给 Agent：图片走多模态，文件/语音落盘注入 turn text。

## Background / Confirmed Facts

- Telegram 入站只注册 `message("text")`（`src/gateway/channels/telegram.ts`）。
- TUI 图片管线：`PendingImage` → base64 `ImageContent` → `harness.prompt(text, { images })`（`src/images/encode.ts`、`src/tui/image-submit.ts`）。
- Gateway `NoviAgentAdapter.runTurn` 目前只 `harness.prompt(text)`（`src/gateway/agent/novi-agent-adapter.ts`）。
- durable inbox/outbox 只持久化文本；`media blob` 不在 store schema（`src/gateway/messages/types.ts`）。
- 决策来源 parent：D4（混合：图片多模态直通，文件/语音落盘注入 text），D5（不做出站媒体），R-M1~R-M5。

## Requirements

### R-M1 入站类型
- R-M1.1：Telegram 注册 `message("photo")`、`message("document")`、`message("voice")`；含 caption（作为 text）与无 caption（text 可为空或占位）。
- R-M1.2：caption 作为 `ChannelMessage.text`；无 caption 时 text 为空串或最小占位，不阻塞 agent turn。

### R-M2 统一附件模型
- R-M2.1：使用 `channel-unified-semantics` 定义的 `ChannelMessage.attachments?` 填充：type（`image`/`file`/`voice`）、mime、size、filename、本地路径/引用。
- R-M2.2：元数据同时可进 `metadata`，但主数据走 `attachments`，不藏在自由 metadata。

### R-M3 Agent 消费（D4 混合）
- R-M3.1 图片：下载 → base64 `ImageContent`（复用 `src/images/encode.ts` 的 encode 逻辑或等价）→ `AgentProtocolTurnInput.images` → `NoviAgentAdapter` 调 `harness.prompt(text, { images })`。
- R-M3.2 文件/语音：下载到 gateway/session 可访问路径（`$NOVI_HOME` 下，按 session/route 隔离），turn text 追加可操作说明（路径 + mime + size + filename）。
- R-M3.3 无 vision 模型时对齐 TUI `nonVisionWarning`：给 warning + 降级说明，不静默丢弃。
- R-M3.4 `AgentProtocolTurnInput.images?` 由 `channel-unified-semantics` 引入；本任务负责 Telegram 端填充与 adapter 透传。

### R-M4 不支持类型
- R-M4.1：sticker / animation / video 等本任务不作为成功媒体入站；可诊断（日志/`metadata.unsupported`）且不崩溃。
- R-M4.2：不伪造成成功媒体（不填 attachments）。

### R-M5 durable
- R-M5.1：inbox 持久化只存附件元数据 + 本地引用（路径/文件名/类型/mime/size），不存 base64/blob。
- R-M5.2：下载文件的生命周期与 session/会话相关；明确清理策略（至少不无限增长），可在 design 定。

### R-M6 不做
- 出站媒体（Agent 发图/文件，D5）。
- Telegram 出站 reply 强制（D9）。
- 飞书媒体。

## Acceptance Criteria

- [ ] AC-M1：图片/文件/语音消息入站并归一化为 `attachments`（type/mime/size/filename/路径）。
- [ ] AC-M2：图片进入 `harness.prompt(text, { images })` 多模态路径；无 vision 模型时 warning + 降级说明。
- [ ] AC-M3：文件/语音落盘，turn text 携带可操作路径与元数据。
- [ ] AC-M4：inbox 持久化记录不含媒体 blob（仅元数据/本地引用）。
- [ ] AC-M5：sticker/animation/video 等可诊断、不崩溃、不伪造成成功媒体。
- [ ] AC-M6：`npm run typecheck && npm test` 全绿；现有 Telegram 文本/durable 路径回归无破坏。
- [ ] AC-M7：不出现出站媒体 / 出站强制 reply。

## Out of Scope

- 出站媒体、出站强制 reply
- 飞书媒体、飞书 Adapter
- reaction / quote 独立模型 / 用户消息 edit 入站
- 多租户 / 商业级合规媒体归档

## Notes

- 复杂任务：需 `design.md`（附件模型字段、落盘路径布局、下载与清理、images 透传链路、inbox schema 兼容）+ `implement.md`。
- 必须在 `channel-unified-semantics` 完成后执行（契约依赖）。