# Design — Feishu (Lark) channel adapter

> Child of `07-15-channel-media-feishu-semantics`. P1，执行顺序第三棒。
> 依赖 `07-15-channel-unified-semantics`（已 archive）的 `ChannelSendTarget.replyToMessageId?` / thread/reply 契约。
> 目标：验证 `ChannelAdapter` 抽象可扩展到第二个真实渠道。

## 1. 架构与边界

本任务新增 `src/gateway/channels/feishu.ts` + `FeishuChannelConfig`，不改 core 契约（已由 semantics child 落地）。使用飞书官方 SDK `@larksuiteoapi/node-sdk` 的 `Channel` 模块（WS 长连接 + 消息归一化 + 发送/reply）。

**设计选择：用 SDK `Channel` 模块还是底层 `WSClient`+`Client`？**

| 方案 | 优点 | 代价 |
|------|------|------|
| **A. SDK `Channel` 模块（推荐）** | 归一化 `NormalizedMessage`（text/markdown/mentions/reply）、WS 管理、send/reply 内置；`on('message')` 直接拿结构化消息 | 自带 policy 层（requireMention/dmMode/allowlist）需禁用或对齐，避免与 GatewayApp auth 冲突 |
| B. 底层 `WSClient`+`Client` | 最小依赖，自己控制全部逻辑 | 需自己解析飞书消息格式、管理 WS 重连、调 send API |

**决定：A（SDK Channel 模块）**，但禁用其 policy 层（`policy: { requireMention: false, dmMode: 'open' }`，不用 groupAllowlist/dmAllowlist），让 GatewayApp 统一做 auth/dedup。SDK 的 dedup/safety 保留（减少重复消息）。

## 2. 数据流与契约改动

### 2.1 配置（`config.ts`）

```ts
export interface FeishuChannelConfig {
  type: "feishu";
  id: string;
  appId: string;
  appSecret: string;
  /** 飞书域名，默认 Feishu（国内）；Lark 海外用 "lark" */
  domain?: "feishu" | "lark";
}
```

`ChannelConfig` 联合扩展：`TelegramChannelConfig | FeishuChannelConfig`。`validateChannels` 识别 `type: "feishu"`，缺 `appId`/`appSecret` 时跳过并告警（与 Telegram 缺 botToken 同策略）。

### 2.2 工厂（`channels/index.ts`）

```ts
if (config.type === "feishu") {
  return createFeishuChannel(config, options);
}
```

### 2.3 FeishuChannel（`channels/feishu.ts`）

```ts
export class FeishuChannel extends AbstractChannel {
  readonly capabilities: ChannelCapabilities = {
    chatTypes: ["direct", "group"],
    edit: false,        // 飞书文本消息不支持 edit-stream（卡片可 edit，但本轮不做）
    threads: false,     // 本轮不做 thread/topic 映射
    markdown: true,
    media: false,       // D8: 不做飞书媒体
    blockStreaming: false,
  };
  readonly textChunkLimit = 4000; // 飞书文本消息限制（保守值）
  // ...
}
```

**能力声明差异（验证抽象的关键）：**
- `edit: false` —— 飞书文本消息不支持 edit（卡片可 edit 但本轮不做）。`sendEvent` 不实现，session-lane 不调用（`?.` 链）。
- `threads: false` —— 本轮不做 thread/topic 映射。收到 `threadId` 时安全忽略。
- `media: false` —— D8 不做飞书媒体。
- 这与 Telegram（`edit: true, threads: true`）形成真实差异，验证抽象可承载不同渠道。

### 2.4 生命周期

```ts
async start(): Promise<void> {
  this.channel = createLarkChannel({
    appId: this.appId,
    appSecret: this.appSecret,
    domain: this.domain,
    policy: { requireMention: false, dmMode: 'open' },
    loggerLevel: LoggerLevel.warn,
  });
  this.channel.on('message', (msg) => this.handleMessage(msg));
  await this.channel.connect();
  this.botIdentity = this.channel.botIdentity;
}

async stop(): Promise<void> {
  await this.channel?.disconnect();
  this.channel = undefined;
}

async probe(): Promise<{ ok: boolean; detail?: string }> {
  // connect 成功即 probe 通过；botIdentity.name 为详情
  return this.botIdentity
    ? { ok: true, detail: this.botIdentity.name }
    : { ok: false, detail: 'not connected' };
}

getFailure(): Error | undefined {
  return this.failure;
}
```

**`emitMessage` fire-and-forget（3 秒时限）：** `handleMessage` 内调 `emitMessage(this.normalizeMessage(msg))`，不 await 下载/处理（飞书长连接 3 秒内处理否则重推）。与 Telegram 同构，durable inbox 兜底。

### 2.5 入站归一化

```ts
private normalizeMessage(msg: NormalizedMessage): ChannelMessage {
  return {
    id: msg.messageId,
    remoteChatId: msg.chatId,
    chatType: msg.chatType === 'p2p' ? 'direct' : 'group',
    senderId: msg.senderId,
    ...(msg.senderName ? { senderName: msg.senderName } : {}),
    text: msg.content,  // SDK 已归一化为 markdown
    timestamp: new Date(msg.createTime),
    ...(msg.replyToMessageId ? { replyToMessageId: msg.replyToMessageId } : {}),
    ...(msg.threadId ? { threadId: msg.threadId } : {}),
    metadata: {
      feishuChatType: msg.chatType,
      feishuMessageId: msg.messageId,
      feishuRawContentType: msg.rawContentType,
      mentionedBot: msg.mentionedBot,
      updateId: msg.messageId,  // 飞书用 messageId 做去重 key
    },
  };
}
```

**非文本消息（D8）：** `msg.rawContentType !== 'text'` 时，仍 emitMessage（让 Agent 看到说明），但 `metadata.unsupported` 标注类型。不崩溃、不伪造媒体。

### 2.6 出站发送

```ts
async send(target: ChannelSendTarget, text: string): Promise<ChannelDeliveryReceipt> {
  const messageIds: string[] = [];
  for (const chunk of chunkText(text, this.textChunkLimit)) {
    const opts = target.replyToMessageId
      ? { replyTo: target.replyToMessageId }
      : {};
    await this.channel!.send(target.chatId, { markdown: chunk }, opts);
    // 飞书 send 不直接返回 messageId；需从 API 响应提取或用 sendFinalChunk
    messageIds.push(/* extracted id */);
  }
  return { messageIds };
}
```

**reply（D9）：** `target.replyToMessageId` 存在时用 SDK `send` 的 `replyTo` 选项；不存在时普通发送。不强制 reply。

**`sendFinalChunk`：** 为支持 durable 分 chunk 进度，实现 `sendFinalChunk`。飞书 send API 返回 `message_id`，可作为 receipt。

**chunk limit：** 飞书文本消息无明确硬限制，但保守取 4000（与 Telegram 4096 量级一致，避免超长消息问题）。

### 2.7 edit-stream

`capabilities.edit = false` → `sendEvent` 不实现。session-lane 的 `?.` 链保证不调用。最终只 `send` 一次完整文本。这是与 Telegram 的关键差异，验证抽象。

## 3. 兼容性与迁移

- `ChannelConfig` 联合扩展，`validateChannels` 向后兼容。
- `ChannelType` 已是 `"telegram" | (string & {})`，`"feishu"` 自动属于联合。
- 现有 allowlist/pairing/session route/durable delivery 不改——飞书走同一 `ChannelAdapter` 接口。
- 新增依赖 `@larksuiteoapi/node-sdk`。

## 4. Trade-offs

| 选择 | 理由 | 代价 |
|------|------|------|
| SDK Channel 模块 vs 底层 API | 归一化 + WS 管理 + send/reply 内置，大幅减少代码 | 自带 policy 层需禁用，避免与 GatewayApp auth 冲突 |
| `edit: false` | 飞书文本不支持 edit；卡片 edit 本轮不做 | 无流式编辑体验（最终一次 send） |
| `threads: false` | thread/topic 映射复杂，本轮验证抽象不依赖它 | thread 消息降级为普通发送 |
| 不做飞书媒体（D8） | 验证抽象不依赖媒体 | 飞书用户只能发文本 |

## 5. 回滚

新增文件 + config 扩展。revert commit 即可；core 契约与 Telegram 不受影响。

## 6. 验证

- `npm run typecheck` / `npm test` / `npm run lint` / `npm run build` 全绿。
- 新增单测 `feishu.test.ts`：
  - 配置校验（缺 appId/appSecret 跳过）。
  - 归一化（text/p2p/group/reply/mention）。
  - 非文本消息诊断。
  - send + reply（mock SDK channel）。
  - 生命周期（start/stop/probe mock）。
  - 能力声明差异（edit=false, threads=false）。
- 现有 Telegram/gateway 测试回归无破坏。

## 7. 测试策略

飞书 SDK 的 `Channel` 模块依赖真实 WS 连接，无法在单测中直接用。策略：
- **注入 `createLarkChannel` 工厂**（类似 Telegram 的 `pollingApi`），测试用 mock。
- Mock `LarkChannel` 接口：`on('message')` / `connect()` / `disconnect()` / `send()` / `botIdentity`。
- 测试归一化逻辑时直接调 `normalizeMessage`（pure function），不依赖 SDK。