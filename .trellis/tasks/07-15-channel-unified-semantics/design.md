# Design — Unify silent/thread/reply semantics across channels

> Child of `07-15-channel-media-feishu-semantics`. P3 抽象层先行。
> 本设计只改契约/类型/透传链路与文档，不交付端到端新功能（Telegram 填充由 `07-15-telegram-media`，飞书由 `07-15-feishu-adapter`）。

## 1. 架构与边界

本任务作用在 `src/gateway/core/types.ts` 契约层 + 其透传链路 + 契约文档。不触碰渠道实现细节、不实现媒体下载。改动分四块：

1. 出站 reply 可选字段 `ChannelSendTarget.replyToMessageId?`，透传 durable 链路。
2. 入站附件模型 `ChannelMessage.attachments?` 与 `AgentProtocolTurnInput.images?`，透传 inbox/dispatcher/adapter。
3. silent / thread / bot-edit 契约文档化（无行为变更，补文档）。
4. `ChannelCapabilities.threads` 语义明确化（字段已存在，补文档 + 不支持渠道安全忽略规则）。

## 2. 数据流与契约改动

### 2.1 `ChannelSendTarget.replyToMessageId?`（D9，可选出站 reply）

**类型（`core/types.ts`）：**
```ts
export interface ChannelSendTarget {
  chatId: string;
  threadId?: string;
  replyToMessageId?: string; // 新增：可选出站 reply
}
```

**透传链路（出站 durable）：**

| 文件 | 改动 |
|------|------|
| `core/routing.ts` `channelTargetForLocator` | locator 若带 `replyTo` 则透传到 target（新 locator 字段，见下） |
| `core/routing.ts` `channelTargetForMessage` | 从入站 `ChannelMessage.replyToMessageId` 透传到出站 target（用于「回复触发消息」场景） |
| `core/types.ts` `GatewaySessionLocator` | 新增 `replyTo?: string`（可选，持久化到 outbox target） |
| `messages/types.ts` `OutboxRecord.target` | 即 `GatewaySessionLocator`，自动获得 `replyTo?`；`decodeOutboxRecord` 兼容缺失 |
| `messages/sink.ts` `enqueueInbox` | locator 构造时透传 `target.replyToMessageId` → `locator.replyTo` |
| `messages/delivery.ts` `execute` | `channelTargetForLocator(input.target)` 已会透传；`send`/`sendFinalChunk` 收到带 replyTo 的 target |
| `messages/dispatcher.ts` `restoreMessage` | 出站 target 不经此处；无改动 |

**默认行为不变（D9）：** `replyToMessageId` 默认 undefined → 不 reply。edit-stream placeholder 路径（session-lane `sendEvent`）不携带 replyTo。只有当上层显式构造带 `replyToMessageId` 的 target 时渠道才 reply。本任务不改 session-lane / gateway-app 的默认 target 构造（仍不带 replyTo），保证现有行为零回归。

**兼容性：** `GatewaySessionLocator.replyTo?` optional + outbox schema version 不变（`decodeOutboxRecord` 对缺失字段返回 undefined）。旧记录无 `replyTo`，行为不变。

### 2.2 `ChannelMessage.attachments?` 与 `AgentProtocolTurnInput.images?`

**附件模型（`core/types.ts`）：**
```ts
export type ChannelAttachmentKind = "image" | "file" | "voice";

export interface ChannelAttachment {
  kind: ChannelAttachmentKind;
  mimeType: string;
  size: number;
  filename?: string;
  /** 本地相对引用（相对 gateway 工作区），由渠道下载后填充。 */
  localPath?: string;
  /** 渠道原生文件 id/引用（下载前可用）。 */
  remoteFileId?: string;
}

export interface ChannelMessage {
  // ...existing
  attachments?: ChannelAttachment[];
}
```

**Agent 输入（`core/types.ts`）：**
```ts
import type { ImageContent } from "@earendil-works/pi-ai";

export interface AgentProtocolTurnInput {
  route: GatewaySessionRoute;
  text: string;
  images?: ImageContent[]; // 新增
  callbacks?: AgentProtocolTurnCallbacks;
}
```

`ImageContent` 形状（来自 `@earendil-works/pi-ai`）：`{ type: "image"; data: string; mimeType: string }`（base64）。与 TUI `src/images/encode.ts` 已用同一类型。

**透传链路（入站 → agent）：**

| 文件 | 改动 |
|------|------|
| `core/types.ts` | `ChannelAttachment` / `ChannelMessage.attachments?` / `AgentProtocolTurnInput.images?` |
| `messages/types.ts` `PersistedInboundMessage` | 新增 `attachments?: ChannelAttachment[]`（只元数据，无 blob） |
| `messages/service.ts` `accept` | 透传 `message.attachments` 到 inbox record |
| `messages/service.ts` `retry` | 透传 `original.message.attachments` |
| `messages/dispatcher.ts` `restoreMessage` | 透传 `record.message.attachments` → `ChannelMessage.attachments` |
| `agent/novi-agent-adapter.ts` `runTurn` | `harness.prompt(text, input.images)` —— 当 `images` 存在时传入 |

**inbox 不存 blob（D4/R-M5）：** `ChannelAttachment` 只含元数据 + `localPath` 引用，`ImageContent`（base64）不进 inbox。`telegram-media` child 负责下载 → 落盘 → 填 `localPath`，并在构造 `AgentProtocolTurnInput` 时把图片的 base64 放入 `images`（运行时内存，不持久化）。

**`restoreMessage` 的 images 还原问题：** inbox 持久化的是 `attachments`（含 `localPath`），不是 `ImageContent`。durable 恢复（crash 后 retry）时若需重新跑 turn，`telegram-media` child 需从 `localPath` 重新读 base64 构造 `images`。本 `semantics` child 只定义契约与透传，不实现该重读逻辑（属 `telegram-media`）。但本 child 要确保 `restoreMessage` 输出的 `ChannelMessage` 带 `attachments`，使下游 child 能在 dispatcher 层拿到 `localPath`。

> 注：当前 dispatcher `restoreMessage` 返回的 `ChannelMessage` 不直接进 `AgentProtocolTurnInput`；`GatewayApp.processAccepted` 用的是原始 `ChannelMessage`。需在 design 中确认 images 进入 turn 的具体注入点（见 §2.3）。

### 2.3 images 进入 agent turn 的注入点

当前路径（`gateway-app.ts` → `session-lane.ts` `runTurn`）：
```
onInbound(channel, msg) → processAccepted(channel, msg, route)
  → sessionLane.enqueue(msg) → runTurn(lane, agent, entry)
  → agent.runTurn({ route, text: msg.text, callbacks })
```

`runTurn` 签名（`AgentProtocolAdapter.runTurn`）接收 `AgentProtocolTurnInput`。注入 images 的最小改法：

- `session-lane.ts` `QueuedMessage.msg` 已是 `ChannelMessage`（带 `attachments?`）。
- `runTurn` 内构造 `AgentProtocolTurnInput` 时，若 `msg.attachments` 含 image 且已下载为 base64，则填 `images`。
- **但 base64 的来源**：`semantics` child 不做下载。`semantics` 只定义 `AgentProtocolTurnInput.images?`，并让 `NoviAgentAdapter.runTurn` 透传 `input.images` 到 `harness.prompt(text, images)`。
- **谁构造 `images`？** `telegram-media` child 在 channel 层（入站 normalize 时下载图片 → base64）或在 `processAccepted` 注入。设计上最干净是：channel 在 `emitMessage` 前把图片下载为 base64 放入 `ChannelMessage.metadata`（或新增 `images?` 字段），session-lane/runTurn 透传。

**本 `semantics` child 的决定：**
- `ChannelMessage` 新增 `images?: ImageContent[]`（运行时字段，**不持久化**到 inbox；inbox 只存 `attachments` 元数据）。
- `AgentProtocolTurnInput.images?` 透传。
- `session-lane.ts` `runTurn`：从 `msg.images`（若有）填入 `AgentProtocolTurnInput.images`。
- `NoviAgentAdapter.runTurn`：`harness.prompt(text, input.images)`。

这样 `telegram-media` child 只需在 `normalizeMessage` 时下载图片 → 填 `ChannelMessage.images`，其余链路自动透传。`semantics` child 负责 `ChannelMessage.images?` 类型 + session-lane/adapter 透传。

```ts
export interface ChannelMessage {
  // ...existing
  attachments?: ChannelAttachment[]; // 持久化元数据
  images?: ImageContent[];            // 运行时 base64，不持久化
}
```

**inbox 持久化排除 `images`：** `service.ts` `accept` 只写 `attachments`，不写 `images`（base64）。`PersistedInboundMessage` 无 `images` 字段。

### 2.4 silent（R-U1）— 仅文档化

行为已统一（`isSilentReply` in `routing.ts` + `session-lane.ts` 前缀缓冲 + `cancelStream`）。本任务不改代码，只在 `docs/gateway-design.md`（或新增 `docs/gateway-messaging-semantics.md`）补契约段：

- silent markers：`SILENT / [SILENT] / NO_REPLY / NO REPLY`（大小写不敏感，trim 后全匹配）。
- 触发：`onTurnEnd` text 全匹配 → `channel.cancelStream?.(target)`；stream 前缀缓冲在 `session-lane` 释放前判断 `isSilentPrefix`。
- 跨渠道一致：所有渠道复用 `routing.ts` 的 `isSilentReply` / `isSilentPrefix`，不得各自实现。

### 2.5 thread（R-U2）— 文档化 + 安全忽略规则

`ChannelMessage.threadId?` / `ChannelSendTarget.threadId?` / `GatewaySessionLocator.thread?` 已存在。`ChannelCapabilities.threads?: boolean` 已存在。

补文档 + 规则：
- `threads=true` 渠道：`threadId` 表示 topic/thread 标识，outbound `send` 应发到该 thread。
- `threads=false` 渠道：收到 `threadId` 时安全忽略（不崩溃，降级为普通发送）。
- 飞书 mapping（`threads` 真值）由 `feishu-adapter` child 决定。

### 2.6 bot edit-stream（R-U4）— 仅文档化

补契约文档：
- `capabilities.edit=true` 的渠道用 `sendEvent({type:"text-delta"})` 累积 + throttled edit + `send` 最终 flush；`sendEvent` / `cancelStream` 可选但 `edit=true` 时应实现。
- `capabilities.edit=false` 的渠道：`sendEvent` 可不实现，session-lane 不调用（已有 `?.` 链），最终只 `send` 一次完整文本。
- 不实现用户消息 edited 入站。

## 3. 兼容性与迁移

- 所有新字段 optional，旧 JSON 记录无 `replyTo` / `attachments` → undefined → 行为不变。
- `outbox` schema version 不变（`decodeOutboxRecord` 容忍缺失 `replyTo`）。
- `inbox` schema version 不变（`PersistedInboundMessage` 新增 optional `attachments`，旧记录无此字段 → undefined）。
- `ChannelMessage.images` 不持久化，无 schema 影响。
- TypeScript：新字段 optional，调用点用 `?.` 透传，编译期兼容。

## 4. Trade-offs

| 选择 | 理由 | 代价 |
|------|------|------|
| `replyToMessageId?` 可选而非默认 | D9；不破坏 edit-stream；最小改动 | 不会自动 reply，需上层显式构造 |
| `images?` 放 `ChannelMessage` 运行时字段 | channel 层下载后直接挂，链路最短 | 不持久化，crash 恢复需从 `attachments.localPath` 重读（由 `telegram-media` 实现） |
| `attachments` 与 `images` 分离 | 元数据持久化 vs 运行时 base64 职责清晰 | 两个字段，但各自用途明确 |
| silent/thread/edit 只文档不改代码 | 行为已统一，避免无谓改动 | 文档需与代码同步维护 |

## 5. 回滚

纯契约层 + optional 字段 + 文档。回滚 = revert 本次 commit；旧记录与代码不受影响（新字段全 optional）。

## 6. 验证

- `npm run typecheck`：新类型编译通过。
- `npm test`：现有 gateway 测试全绿（新字段 optional，透传用 `?.`）。
- 新增单测：
  - `routing.ts`：`channelTargetForLocator` / `channelTargetForMessage` 透传 `replyToMessageId`。
  - `sink.ts`：`enqueueInbox` 透传 `replyTo` 到 locator。
  - `service.ts` / `dispatcher.ts`：`attachments` 透传 accept → inbox → restoreMessage。
  - `novi-agent-adapter.ts`：`runTurn` 透传 `images` 到 `harness.prompt`。

## 7. 文档产出

新增 `docs/gateway-messaging-semantics.md`（或并入 `docs/gateway-design.md` 新增段），覆盖：
- silent markers + cancelStream 契约
- thread 语义 + threads 能力声明 + 安全忽略
- reply 入站/出站 + `replyToMessageId?` 可选
- bot edit-stream 契约（capabilities.edit + sendEvent + send flush）
- attachments / images 模型说明（持久化 vs 运行时）