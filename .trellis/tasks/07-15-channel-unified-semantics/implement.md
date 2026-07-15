# Implement — Unify silent/thread/reply semantics across channels

> 复杂任务，执行顺序第一棒。契约层先行，下游 `telegram-media` / `feishu-adapter` 依赖本任务产出。

## 前置条件

- [ ] prd.md / design.md 已 review
- [ ] 当前 active task = `07-15-channel-unified-semantics`，status = planning

## 执行清单（按顺序）

### A. 类型契约（`src/gateway/core/types.ts`）
1. [ ] 新增 `ChannelAttachmentKind` / `ChannelAttachment` 类型。
2. [ ] `ChannelMessage` 增 `attachments?: ChannelAttachment[]` + `images?: ImageContent[]`（import `ImageContent` from `@earendil-works/pi-ai`）。
3. [ ] `ChannelSendTarget` 增 `replyToMessageId?: string`。
4. [ ] `GatewaySessionLocator` 增 `replyTo?: string`。
5. [ ] `AgentProtocolTurnInput` 增 `images?: ImageContent[]`。
6. [ ] `ChannelCapabilities.threads` 注释补语义（文档级，无类型改）。

### B. 透传链路 — 出站 reply
7. [ ] `core/routing.ts` `channelTargetForLocator`：locator.`replyTo` → target.`replyToMessageId`。
8. [ ] `core/routing.ts` `channelTargetForMessage`：`message.replyToMessageId` → target.`replyToMessageId`（用于回复触发消息场景；当前默认调用点不变，仅提供能力）。
9. [ ] `messages/sink.ts` `enqueueInbox`：`target.replyToMessageId` → `locator.replyTo`。
10. [ ] `messages/types.ts` `decodeOutboxRecord`：兼容 `replyTo` 缺失（undefined）。
11. [ ] 确认 `messages/delivery.ts` `channelTargetForLocator` 调用自动透传（无改动，验证）。

### C. 透传链路 — 入站 attachments
12. [ ] `messages/types.ts` `PersistedInboundMessage` 增 `attachments?: ChannelAttachment[]`；`decodeInboxRecord` / `clone` 兼容。
13. [ ] `messages/service.ts` `accept`：`message.attachments` → inbox record（`...：{} : { attachments }` 模式，与现有可选字段一致）。
14. [ ] `messages/service.ts` `retry`：透传 `original.message.attachments`。
15. [ ] `messages/dispatcher.ts` `restoreMessage`：`record.message.attachments` → `ChannelMessage.attachments`。

### D. 透传链路 — images → agent
16. [ ] `core/session-lane.ts` `runTurn`：`msg.images`（若有）→ `AgentProtocolTurnInput.images`。
17. [ ] `agent/novi-agent-adapter.ts` `runTurn`：`harness.prompt(text, input.images)`（`input.images` 为 undefined 时等价于 `prompt(text)`）。

### E. 文档
18. [ ] 新增 `docs/gateway-messaging-semantics.md`：silent / thread / reply / edit-stream / attachments-vs-images 契约（内容见 design §7）。
19. [ ] `docs/gateway-design.md` 交叉引用（如适用，补一行链接）。

## 验证命令

```bash
npm run typecheck
npm test
```

## 风险点 / 回滚

- 风险：`ChannelMessage.images` 误入持久化 → 确保 `service.ts accept` 只写 `attachments`，不写 `images`。
- 风险：`decodeOutboxRecord` / `decodeInboxRecord` 对新 optional 字段处理 → 用现有 `...：{} : { field }` 模式，加单测验证缺失字段返回 undefined。
- 回滚：revert commit；新字段全 optional，无数据迁移。

## 审查门

- [ ] typecheck + 全量 test 绿
- [ ] 新增单测覆盖：routing replyTo 透传、sink locator.replyTo、attachments accept/restore、adapter images 透传
- [ ] 现有 Telegram 文本路径回归无破坏
- [ ] 文档段写入

## 后续

完成后 archive 或保持 in_progress 等待 parent 集成。下游 `07-15-telegram-media` 可在本任务 `task.py start` 实现并 review 后启动。