# 更新网关设计讲解文档

## Goal

更新 `docs/gateway-design.md`，使其反映当前 `src/gateway/**` 的实际设计，遵循 `explain-code-design` 技能的写作规范（围绕问题组织、讲设计而非复述源码、真实流程连接组件、区分事实与推断）。

## Background

`docs/gateway-design.md` 最后更新于提交 `dc1c737`（unify channel messaging semantics）。此后有两个 commit 改动了网关源码，但文档未同步：

- `d69a6ea feat(gateway): add Telegram inbound media (image/file/voice)` — Telegram 入站媒体处理
- `f02e5dc feat(gateway): add Feishu (Lark) channel adapter` — 飞书 channel 适配器

同时 `src/gateway/migrations/`（状态迁移与回滚）与 `src/gateway/runtime/`（运行时控制与可观测性）两个子系统在现有文档结尾被明确标注为"不在本文范围"，但它们各有独立 spec（`.trellis/spec/backend/gateway-state-migrations.md`、`gateway-runtime-observability.md`）。

## 已确认的源码事实

### Telegram 入站媒体（d69a6ea）

- `src/gateway/channels/telegram-media.ts`：`saveAttachmentFile`（下载落盘到 `$NOVI_HOME/gateway-media/<hash-prefix-2>/`，目录 0o700、文件 0o600）、`sanitizeFilename`（防路径穿越）、`MediaDownloader` 接口（可注入测试）
- `src/gateway/channels/telegram.ts`：
  - 注册 `photo`/`document`/`voice`/`sticker` 四类 handler
  - `handleMediaMessage`：animation/sticker 诊断占位、下载/编码失败降级（`[image download failed: ...]`）
  - `normalizeMediaMessage`：image 走 download → base64 → `ImageContent`（多模态路径，不落盘）；file/voice 走 download → `saveAttachmentFile` → `localPath`
  - `extractAttachment`：从 Telegram 媒体消息抽 `ChannelAttachment`
- `src/gateway/core/types.ts`：`ChannelAttachmentKind = "image" | "file" | "voice"`、`ChannelAttachment`（kind/mimeType/size/filename/localPath/remoteFileId）、`ChannelMessage.attachments?`（持久化元数据）与 `ChannelMessage.images?`（运行时 base64，不持久化）双字段模型
- `ChannelCapabilities.media?: boolean`（Phase 3 预留声明位）

### Feishu channel 适配器（f02e5dc）

- `src/gateway/channels/feishu.ts`：`FeishuChannel extends AbstractChannel`
- 使用 `@larksuiteoapi/node-sdk` 的 `createLarkChannel`，WebSocket long-connection（非 long-poll）
- 能力声明：`edit:false`、`threads:false`、`markdown:true`、`media:false`、`blockStreaming:false`、`chatTypes:["direct","group"]`，`textChunkLimit=4000`
- SDK policy 层禁用（`requireMention:false`、`dmMode:"open"`），授权/去重统一交给 `GatewayApp`
- 入站：SDK `NormalizedMessage` → `ChannelMessage`；非 text 内容降级为 `[unsupported message type: ...]`
- 出站：`send` 用 markdown；支持 `replyTo`；无 `sendEvent`（无 edit-stream）
- 3 秒回执约束：`handleMessage` fire-and-forget 不 await，靠 durable inbox 兜底
- `LarkChannelFactory` 可注入，测试不依赖真实 WebSocket

### migrations / runtime 子系统

- `src/gateway/migrations/`：版本化状态、离线迁移、备份、恢复、回滚；启动只做只读 registry inspection；legacy/中断状态拒绝启动
- `src/gateway/runtime/`：Unix 域套接字控制协议（v1 NDJSON）、`status`/`health` CLI、`GatewayLogger`（单行 JSON stderr）、`GatewayMetrics`、operations alerts（经 durable outbox，anti-loop）
- 两者各有独立 spec 文档

## Requirements

- 文档须准确反映 `d69a6ea` 与 `f02e5dc` 引入的设计变化。
- 写作遵循 `explain-code-design` 技能：先整体后局部、围绕问题组织、讲"为什么"而非复述源码、用真实流程连接组件、区分源码事实与合理推断。
- 保持与 `gateway-messaging-semantics.md` 的职责分工：跨渠道语义契约细节不重复，只在需要时链接。
- 不逐行翻译源码；引用少量关键代码作为论据并说明其证明的结论。

## Acceptance Criteria

- [ ] `docs/gateway-design.md` 覆盖 Telegram 入站媒体处理的设计（双字段模型、image 多模态路径 vs file/voice 落盘、降级与失败边界）
- [ ] `docs/gateway-design.md` 覆盖 Feishu channel 适配器的设计（第二个 channel 实例如何验证/约束 channel 抽象边界）
- [ ] 文档不包含与当前源码矛盾的事实
- [ ] 文档通过 `explain-code-design` 技能的"输出前检查"清单
- [ ] 文档结构与现有版本风格一致（整体概览 → 要解决的问题 → 核心抽象 → 运行机制 → 关键设计 → 异常与边界 → 设计权衡）

## Out of Scope

- `src/gateway/migrations/`（状态迁移与回滚）— 继续保持现有文档结尾的"未展开"标注，不在本次扩写。已有独立 spec `gateway-state-migrations.md`。
- `src/gateway/runtime/`（运行时控制与可观测性）— 同上。已有独立 spec `gateway-runtime-observability.md`。
- `docs/gateway-messaging-semantics.md` 的内容重写（仅按需更新链接/引用）。
- 源码改动（本任务只改文档）。