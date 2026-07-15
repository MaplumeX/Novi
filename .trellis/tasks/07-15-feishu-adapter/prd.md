# Feishu (Lark) channel adapter

> Parent: `07-15-channel-media-feishu-semantics`. 执行顺序第三棒（P1）。
> 依赖：`07-15-channel-unified-semantics`（`ChannelSendTarget.replyToMessageId?` / thread/reply 契约）。
> 目标：验证 `ChannelAdapter` 抽象可扩展到第二个真实渠道。

## Goal

用飞书官方 Node SDK 长连接（WebSocket）实现一个 `ChannelAdapter`，完成文本入站/出站闭环与 P3 语义，证明现有抽象可承载新渠道。

## Background / Confirmed Facts

- 现有 `ChannelConfig` 联合只有 `TelegramChannelConfig`（`src/gateway/config.ts`）；工厂只识别 `"telegram"`（`src/gateway/channels/index.ts`）。
- `AbstractChannel.emitMessage` 先 ack（可选）再 `onMessage`（`src/gateway/core/abstract-channel.ts`）。
- Gateway 是常驻本机 Node 进程，非公网 HTTP 服务。
- 决策来源 parent：D6（长连接 WebSocket + App ID/Secret，企业自建应用），D8（飞书只做文本 + P3 语义，不做媒体），R-F1~R-F6。
- 飞书长连接：3 秒内处理否则重推；`emitMessage` 必须 fire-and-forget（与 Telegram 同构，durable inbox 兜底）。

## Requirements

### R-F1 配置与工厂
- R-F1.1：新增 `FeishuChannelConfig`（`appId` + `appSecret` + `id` + 可选 `encryptKey`/`verificationToken` 如长连接需要），并入 `ChannelConfig` 联合。
- R-F1.2：`config.ts` 校验 `type: "feishu"`，缺 `appId`/`appSecret` 时跳过并告警（与 Telegram 缺 botToken 同策略）。
- R-F1.3：`channels/index.ts` 工厂识别 `"feishu"` → `new FeishuChannel(...)`。

### R-F2 生命周期
- R-F2.1：`start()` 建 WS 长连接，订阅 `im.message.receive_v1`，probe `getMe`/等价（如获取 bot 身份）。
- R-F2.2：`stop()` 关闭 WS、释放资源。
- R-F2.3：`probe()` 轻量连通性检查，不发 agent turn。
- R-F2.4：`getFailure()` 在 WS 背景循环致命错误时暴露。

### R-F3 入站文本
- R-F3.1：`im.message.receive_v1` → `normalizeMessage` → `ChannelMessage`（remoteChatId/chatType/senderId/senderName/text/timestamp/replyToMessageId/threadId）。
- R-F3.2：`emitMessage` fire-and-forget（3 秒时限），依赖 durable inbox 重投。
- R-F3.3：仅处理文本消息（`msg_type: text`）；非文本不崩溃，按 D8 不做媒体入站（可诊断/忽略）。
- R-F3.4：鉴权/明文推送由 SDK 处理（长连接内置加密鉴权）。

### R-F4 出站文本
- R-F4.1：`send(target, text)` 调飞书 OpenAPI 发送文本消息；支持 chunk（飞书消息长度限制）。
- R-F4.2：`sendFinalChunk?` 支持以支持 durable 分 chunk 进度。
- R-F4.3：P3 reply：`ChannelSendTarget.replyToMessageId?` 存在时用 `reply` API（飞书支持），否则普通发送。
- R-F4.4：P3 thread：按 `capabilities.threads` 声明处理 `threadId`；若飞书 thread/topic 模型复杂，可声明 `threads=false` 并安全忽略（design 决定）。

### R-F5 能力声明
- R-F5.1：`capabilities` 真实反映飞书：`chatTypes`（direct/group…）、`edit`（飞书是否支持 edit-stream 决定）、`threads`（按 design）、`markdown`、`media=false`（D8）。
- R-F5.2：若飞书不支持 `edit`，则 `sendEvent` 不实现（与 Telegram 差异，正好验证抽象）。

### R-F6 兼容
- R-F6.1：与 allowlist/pairing、session route、durable delivery 兼容（既有测试套件不破）。
- R-F6.2：`ChannelType` 联合扩展 `"feishu"`（注释里已预留 lark）。

### R-F7 不做
- 飞书入站/出站媒体（D8/D5）。
- 飞书强制出站 reply（D9）。

## Acceptance Criteria

- [ ] AC-F1：`gateway.json` 可配置飞书 channel；工厂可创建；`start/stop/probe` 闭环。
- [ ] AC-F2：入站文本 → `ChannelMessage` → session lane → 出站文本闭环（可用 mock SDK 测试）。
- [ ] AC-F3：`capabilities` 与 Telegram 有真实差异（至少 edit/threads 不同），且真实反映飞书能力。
- [ ] AC-F4：`ChannelSendTarget.replyToMessageId?` 在飞书侧可用 `reply` API；不存在时普通发送。
- [ ] AC-F5：与 allowlist/pairing/session route/durable delivery 兼容（既有测试不破）。
- [ ] AC-F6：`npm run typecheck && npm test` 全绿。
- [ ] AC-F7：不出现飞书媒体 / 出站强制 reply / reaction / quote 独立模型。

## Out of Scope

- 飞书入站媒体（图片/文件/语音）
- 出站媒体（Agent 发图/文件）
- 出站强制 reply
- reaction / quote 独立模型 / 用户消息 edit 入站
- Discord/Slack 等其他渠道

## Notes

- 复杂任务：需 `design.md`（SDK 集成、WS 生命周期、消息归一化映射表、能力声明选择、reply/thread 映射、mock 测试策略）+ `implement.md`。
- 新增依赖 `@larksuiteoapi/node-sdk`（在 design 中确认版本与 API 形态）。
- 必须在 `channel-unified-semantics` 完成后执行（契约依赖）。