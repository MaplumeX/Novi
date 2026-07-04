# Novi multi-channel gateway — 技术设计

## 1. 架构总览

新增第四种运行模式 `novi --gateway`，与现有 TUI / print / json 并列。网关进程内按 sessionKey（`channelId:chatId`）懒创建独立 `AgentHarness` + `JsonlSession`，复用 bootstrap 的一次性准备。

```
IM 平台 (Telegram / ...)
  │ 长轮询 / webhook
  ▼
ChannelAdapter (渠道适配器，实现统一接口 + 能力声明)
  │ onMessage(ChannelMessage)
  ▼
GatewayApp (编排层)
  │  1. slash 命令检查（bypass 队列，inline 派发）
  │  2. 授权检查（allowlist）
  │  3. 队列分发（per-sessionKey lane，4 模式）
  ▼
NoviAgentAdapter (AgentHarness 包装)
  │  per-sessionKey: getOrCreateHarness(sessionKey)
  │    → harness.prompt / steer / followUp / abort
  │  subscribe → EventBridge → ChannelEvent
  ▼
AgentHarness (现有 pi-agent-core)
```

### 1.1 依赖方向

```
cli.ts
 ├─ bootstrap.ts (拆分出 prepareGatewayEnv)
 └─ gateway/run.ts
      └─ gateway/core/gateway-app.ts
           ├─ gateway/agent/novi-agent-adapter.ts → AgentHarness 公共 API
           ├─ gateway/agent/event-bridge.ts        → 复用 headless/events.ts
           ├─ gateway/core/session-lane.ts         → per-sessionKey 队列
           └─ gateway/channels/*                  → ChannelAdapter 实现
```

`gateway/` 只依赖 `AgentHarness` 公共 API + `telegraf`，不引用 TUI 内部。符合 N1。

## 2. 核心接口契约

### 2.1 ChannelCapabilities（学 OpenClaw）

```ts
// gateway/core/types.ts
export interface ChannelCapabilities {
  /** 支持的会话类型 */
  chatTypes: Array<"direct" | "group" | "channel" | "thread">;
  /** 能否 edit-message（流式呈现用） */
  edit?: boolean;
  /** 群聊 thread 支持 */
  threads?: boolean;
  /** 媒体收发（Phase 3） */
  media?: boolean;
  /** 分块流式回复 */
  blockStreaming?: boolean;
  /** markdown 渲染支持 */
  markdown?: boolean;
}
```

### 2.2 ChannelAdapter（骨架学 tia-gateway，能力声明学 OpenClaw）

```ts
export interface ChannelAdapter {
  readonly id: string;
  readonly type: ChannelType;
  readonly capabilities: ChannelCapabilities;
  /** 出站单条消息字符上限（Telegram 4096 UTF-16） */
  readonly textChunkLimit: number;
  /** GatewayApp 注入的入站回调 */
  onMessage?: (msg: ChannelMessage) => void;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** 最终完整文本回复 */
  send(chatId: string, text: string): Promise<void>;
  /** 流式增量（仅 edit 能力渠道实现） */
  sendEvent?(chatId: string, event: ChannelEvent): Promise<void>;
  sendTyping?(chatId: string): Promise<void>;
  acknowledgeMessage?(msgId: string): Promise<void>;
}
```

### 2.3 ChannelMessage

```ts
export interface ChannelMessage {
  id: string;
  remoteChatId: string;
  chatType: "direct" | "group" | "channel" | "thread";
  senderId: string;
  senderName?: string;
  senderUsername?: string;
  text: string;
  timestamp: Date;
  threadId?: string;
  replyToMessageId?: string;
  metadata?: Record<string, unknown>;
}
```

### 2.4 ChannelEvent（流式事件）

```ts
export type ChannelEvent =
  | { type: "typing" }
  | { type: "text-delta"; delta: string }
  | { type: "reasoning-delta"; delta: string }
  | { type: "tool-call"; toolName: string; status?: string }
  | { type: "error"; message: string };
```

## 3. 关键组件设计

### 3.1 bootstrap 拆分

现有 `bootstrap()` 一次性完成 env/credentials/settings/models/tools/resources 准备 + session+harness 创建。拆分为两层：

- **`prepareGatewayEnv(options) → GatewayEnv`**（一次）：步骤 1-4,6-8,11（env / credentials / settings / models+custom providers / systemPrompt provider / resources / hooks config）。不含 session/harness 创建。返回可复用的 `GatewayEnv`。
- **`createHarnessForSession(env, sessionKey) → AgentHarness`**（多次）：步骤 5,9-10,12-14（repo.create session → new AgentHarness → setTools → setResources → registerHooks → setStreamOptions → setSteeringMode/setFollowUpMode）。每个 sessionKey 调一次。

```
GatewayEnv {
  env, cwd, models, model, resolvedSettings, systemPrompt,
  trusted, toolsFactory, resources, hookConfig
}

createHarnessForSession(gatewayEnv, sessionKey):
  session = repo.create({ cwd, id: uuidv7() })
  harness = new AgentHarness({ env, session, models, model, systemPrompt, thinkingLevel })
  harness.setTools(tools, activeNames)
  harness.setResources(resources)
  registerHooks(harness, hookConfig, { env, cwd, sessionId })
  harness.setStreamOptions(streamOpts)
  harness.setSteeringMode / setFollowUpMode
  return { harness, session }
```

**TUI 路径不受影响**：`bootstrap()` 仍是一次性调用（内部可委托给上述两个函数，保持 `BootstrapResult` 契约不变）。这是对现有代码的唯一改动点，向后兼容。

### 3.2 NoviAgentAdapter（AgentHarness 包装）

```ts
// gateway/agent/novi-agent-adapter.ts
export interface AgentProtocolAdapter {
  runTurn(input: {
    sessionKey: string;
    text: string;
    callbacks?: {
      onTextDelta?(delta: string): Promise<void>;
      onReasoningDelta?(delta: string): Promise<void>;
      onToolCall?(toolName: string, status?: string): Promise<void>;
      onTyping?(): Promise<void>;
      onTurnEnd?(text: string): Promise<void>;
    };
  }): Promise<{ text: string }>;
  steer(sessionKey: string, text: string): Promise<void>;
  followUp(sessionKey: string, text: string): Promise<void>;
  abort(sessionKey: string): Promise<void>;
  resetSession(sessionKey: string): Promise<void>;
  closeSession(sessionKey: string): Promise<void>;
}
```

- `runTurn`：`getOrCreateHarness(sessionKey)` → 若 phase==="idle" 调 `harness.prompt(text)`，否则排队（由 session-lane 保证串行）。`harness.subscribe` 注册 EventBridge 回调，把 harness 事件转成 `callbacks.onTextDelta` 等。
- `steer`/`followUp`/`abort`：直接转发 `harness.steer/followUp/abort`（可在 turn 中调用）。
- `resetSession`：`closeSession` + 丢弃缓存，下次 `getOrCreate` 重建。
- `closeSession`：`harness.waitForIdle()` → close session → 从 sessionMap 移除。

**关键区分**：harness 的 `steeringMode`/`followUpMode`（`"one-at-a-time"|"all"`）是 harness 内部队列交付模式；网关层的 steer/followup/interrupt 是网关对"运行中收到新消息"的整体策略。两者正交，design 中明确分层。

### 3.3 EventBridge（事件边界单一化）

`gateway/agent/event-bridge.ts` 是网关侧唯一解析 raw `AgentHarnessEvent` 的地方（对应 TUI 的 `useHarnessState`、headless 的 `events.ts`）。复用 `headless/events.ts` 的 `extractText` 逻辑。

```ts
export function createEventBridge(
  harness: AgentHarness,
  channel: ChannelAdapter,
  chatId: string,
  callbacks: AgentProtocolTurnCallbacks,
): () => void {
  // subscribe harness events → 投影为 ChannelEvent / callbacks
  // message_update.text_delta → onTextDelta(delta)
  // message_update.thinking_delta → onReasoningDelta(delta)
  // tool_execution_start/end → onToolCall(name, status)
  // turn_start → onTyping()
  // message_end(assistant) → onTurnEnd(extractText(content))
  return harness.subscribe((event) => { ... });
}
```

### 3.4 SessionLane（per-sessionKey 队列 + 4 模式）

```ts
// gateway/core/session-lane.ts
type QueueMode = "steer" | "followup" | "interrupt";

interface SessionLane {
  sessionKey: string;
  status: "idle" | "running";
  currentTurn: AbortController | null;
  queue: QueuedMessage[];
  lastActivity: number;
  harness: AgentHarness | null;  // lazy
}
```

**运行中收到新消息的处理**（mode 决策）：
- `steer`：`harness.steer(text)`。失败（run 不可 steer）→ 排队等当前 run 结束后 followUp。
- `followup`：排队。当前 run 结束后 `harness.followUp(text)`。
- `interrupt`：`harness.abort()` → 等当前 run 结束 → `harness.prompt(newText)`。
- **slash 命令 bypass**：`/stop`/`/new` 等不进队列，inline 派发（学 Hermes 两级 guard）。

**idle 时收到消息**：直接 `harness.prompt(text)`，进入 running。

**串行保证**：per-sessionKey 单 lane，同一 session 同时只有一个 harness run（学 OpenClaw lane + tia-gateway SerializedSessionManager）。

### 3.5 SessionManager（懒创建 + 空闲淘汰）

```ts
// gateway/core/session-manager.ts
class GatewaySessionManager {
  private lanes = new Map<string, SessionLane>();
  // 空闲超时（默认 24h）+ 上限并发（默认 10）
  // 空闲淘汰：扫描 lastActivity，超时则 closeSession
  // 超限淘汰：淘汰最老空闲 session
  getOrCreate(sessionKey): SessionLane;
  close(sessionKey): Promise<void>;
  startCleanupTimer(): void;  // setInterval 2min, unref
  stop(): Promise<void>;      // 关闭所有 session
}
```

### 3.6 GatewayApp（编排层）

```ts
class GatewayApp {
  constructor(options: {
    channels: ChannelAdapter[];
    agent: AgentProtocolAdapter;
    sessionManager: GatewaySessionManager;
    queueMode: QueueMode;
    allowlist: Set<string>;
    commands: CommandRegistry;
  }) {}

  async start(): Promise<void> {
    for (const channel of this.options.channels) {
      channel.onMessage = (msg) => this.onInbound(channel, msg);
      try { await channel.start(); }
      catch (e) { log diagnostic; skip channel; }  // N3 失败降级
    }
    this.sessionManager.startCleanupTimer();
  }

  async onInbound(channel, msg): Promise<void> {
    // 1. 授权检查
    if (!this.options.allowlist.has(msg.senderId)) {
      await channel.send(msg.remoteChatId, "Unauthorized.");
      return;
    }
    // 2. slash 命令 bypass
    if (msg.text.startsWith("/")) {
      await this.handleCommand(channel, msg);
      return;
    }
    // 3. 队列分发
    const sessionKey = `${channel.id}:${msg.remoteChatId}`;
    await this.sessionManager.enqueue(sessionKey, channel, msg, this.options.queueMode);
  }
}
```

## 4. Telegram 渠道实现

```ts
// gateway/channels/telegram.ts
export class TelegramChannel implements ChannelAdapter {
  readonly capabilities: ChannelCapabilities = {
    chatTypes: ["direct", "group", "channel", "thread"],
    edit: true, markdown: true, blockStreaming: true,
  };
  readonly textChunkLimit = 4096;  // UTF-16 单位

  private bot: Telegraf;
  private streamBuffers = new Map<string, { messageId: string; text: string; lastEdit: number }>();

  async start(): Promise<void> {
    this.bot.on(message("text"), (ctx) => {
      if (ctx.chat.type !== "private") return;  // MVP 只处理私聊
      this.emitMessage({ ... });
    });
    await this.bot.launch();
  }

  async sendEvent(chatId, event): Promise<void> {
    // text-delta: 节流 edit-stream
    if (event.type === "text-delta") {
      await this.handleStreamDelta(chatId, event.delta);
    }
    // typing: bot.telegram.sendChatAction("typing")
  }

  private async handleStreamDelta(chatId, delta): Promise<void> {
    const buf = this.streamBuffers.get(chatId) ?? { messageId: "", text: "", lastEdit: 0 };
    buf.text += delta;
    const now = Date.now();
    if (!buf.messageId) {
      // 首次：sendMessage 占位
      const sent = await this.bot.telegram.sendMessage(chatId, buf.text.slice(0, 4096));
      buf.messageId = String(sent.message_id);
    } else if (now - buf.lastEdit >= this.editIntervalMs) {
      // 节流 edit
      await this.bot.telegram.editMessageText(chatId, Number(buf.messageId), undefined, buf.text.slice(0, 4096));
      buf.lastEdit = now;
    }
    this.streamBuffers.set(chatId, buf);
  }

  async send(chatId, text): Promise<void> {
    // 最终完整文本，超 4096 分条续发
    const buf = this.streamBuffers.get(chatId);
    if (buf?.messageId) {
      // edit 最后一条写完整文本
      await this.bot.telegram.editMessageText(chatId, Number(buf.messageId), undefined, text.slice(0, 4096));
      // 超长续发
      for (const chunk of chunkText(text.slice(4096), 4096)) {
        await this.bot.telegram.sendMessage(chatId, chunk);
      }
      this.streamBuffers.delete(chatId);
    } else {
      for (const chunk of chunkText(text, 4096)) {
        await this.bot.telegram.sendMessage(chatId, chunk);
      }
    }
  }
}
```

**UTF-16 长度计算**：Telegram 4096 限制是 UTF-16 码元数，emoji/CJK 扩展是代理对占 2 码元。用 `Buffer.from(s, "utf16le").length / 2` 计算（学 Hermes `utf16_len`）。

## 5. 配置设计

### 5.1 gateway.json

```json
{
  "queue": { "mode": "steer", "byChannel": { "telegram": "steer" } },
  "stream": { "editIntervalMs": 1000 },
  "session": { "idleTimeoutMs": 86400000, "maxConcurrent": 10 },
  "security": { "allowlist": ["123456789", "987654321"] },
  "channels": [
    { "type": "telegram", "id": "tg-main", "botToken": "${TELEGRAM_BOT_TOKEN}" }
  ]
}
```

### 5.2 加载分层

- `~/.novi/gateway.json`（用户全局）
- `<cwd>/.novi/gateway.json`（项目层，受 trust 门控）
- `${ENV}` 展开（复用 tia-gateway 的 `expandEnvValues` 递归替换）
- 项目层覆盖用户层（同 settings.json 模式）
- 失败降级：解析失败 → diagnostic + 空配置（不阻塞，但有 channels 为空则提示并退出）

## 6. 斜杠命令

| 命令 | 行为 | bypass |
|---|---|---|
| `/new` | resetSession（关闭当前 harness+session，下次重建） | ✅ |
| `/stop` | abort 当前 run | ✅ |
| `/help` | 列出可用命令 | ✅ |
| `/status` | 显示当前 session/model 信息 | ✅ |

命令注册表 `CommandRegistry`，`GatewayApp.onInbound` 检测 `/` 前缀 → bypass 队列 → inline 派发。

## 7. CLI 集成

`cli.ts` 新增 `--gateway` flag：

```
novi --gateway [--config <path>] [--provider <id>] [--model <id>] ...
```

- `--gateway` 触发 `runGateway(bootstrapOptions)` 而非 renderApp/runPrint/runJson
- `--config` 指定 gateway.json 路径（默认 `~/.novi/gateway.json` + 项目层）
- 复用现有 `probeProviderConfigured` + trust 解析（headless 规则 ask→never）
- 凭证未配置 → 打印指引 + exit（不弹 wizard）
- Ctrl+C → `gatewayApp.stop()`（关闭渠道 + 释放所有 harness + close sessions）

## 8. 向进程外演进（预留）

`AgentProtocolAdapter` 是抽象边界。MVP 的 `NoviAgentAdapter` 是进程内实现。未来：
1. 加 `novi --serve`（ACP/RPC server 模式）
2. 网关侧新增 `RemoteAgentAdapter`（通过协议驱动外部 novi 进程）
3. `GatewayApp` 上层零改动

接口设计时 `AgentProtocolAdapter.runTurn` 的签名保持协议无关。

## 9. 关键 trade-off

| 决策 | 选择 | 代价 |
|---|---|---|
| 进程内 vs 进程外 | 进程内（MVP） | 单进程扩缩受限；但复用 bootstrap、零协议层工作量 |
| 4 模式 vs 简单串行 | steer/followup/interrupt | 比 tia-gateway 串行队列多一层 mode 分发逻辑；但 harness API 天然支持，成本低 |
| edit-stream vs 攒批 | edit-stream（1s 节流） | 有 FloodWait 风险；但体验远好于攒批，节流规避 |
| bootstrap 拆分 | 拆成 prepare + per-session | 唯一对现有代码的改动；保持 TUI 路径不变是约束 |

## 10. 风险与缓解

- **Telegram FloodWait**：1s 节流 + edit 失败时退避重试。FloodWait 错误读 `retry_after` 字段等待。
- **harness turn 中 prompt 报 busy**：session-lane 保证 per-sessionKey 串行，idle 才 prompt。
- **session 泄漏**：空闲超时淘汰 + maxConcurrent 淘汰 + Ctrl+C 优雅关闭。
- **bootstrap 拆分破坏 TUI**：`bootstrap()` 保持原签名与返回值，内部委托拆分函数；TUI 路径调用不变，回归测试覆盖。