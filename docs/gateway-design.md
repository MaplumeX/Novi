# Novi Agent Gateway 设计讲解

## 整体概览

Gateway 是 Novi 的第三种运行表面，入口为 `novi --gateway`。与默认的交互式 TUI、一次性的 headless 不同，它是一个**常驻进程**：挂着一个或多个 IM channel，把外部消息变成 agent 会话，再把 agent 的回复送回原对话。

它在系统中的位置很明确：CLI 在 `--gateway` 分支调用 `runGateway`，先做与 headless 类似的 provider 探测与 project trust 解析，再调用共享的 `prepareGatewayEnv({ toolMode: "gateway" })` 装配模型、工具与权限环境；真正的会话 harness 并不在启动时全部创建，而是按对话路由懒创建。Gateway 可以依赖公开 harness 接线与 channel SDK，但**不得** import `src/tui/**`。

最重要的设计思想是分层解耦：

1. **Channel 只负责平台 I/O**，把 Telegram、飞书等协议差异——包括文本、流式呈现与媒体附件——收敛成统一的 `ChannelMessage` / `ChannelEvent`。当前有两个 channel 实现：`TelegramChannel`（能力最全、long-poll）与 `FeishuChannel`（WebSocket、无 edit-stream / threads / media），后者作为能力受限的第二实例验证了 channel 抽象的边界。
2. **`GatewayApp` 只做入站编排**：去重、授权/配对、slash command、再投递到 session lane。
3. **Session lane 保证同一对话串行**，并在运行中按 queue mode 决定 steer / followup / interrupt。
4. **`AgentProtocolAdapter` 屏蔽 agent 后端**：当前是进程内 `NoviAgentAdapter`；channel 与 orchestrator 都不直接订阅 `AgentHarness` 原始事件。
5. **`createEventBridge` 是 gateway 侧唯一 harness 事件边界**，把 turn 生命周期投影成 channel 回调。

此外，常驻进程还挂着 durable scheduled jobs、heartbeat 与主动投递能力；它们与入站消息共用 session 路由与部分 harness 生命周期，但**不是**本文的主线。

> **跨渠道语义契约**（silent / thread / reply / edit-stream / attachments）见 [gateway-messaging-semantics.md](./gateway-messaging-semantics.md)。

---

## 要解决的问题

IM 上的 agent 网关看起来像“收消息 → 调模型 → 回消息”，但至少有五类约束让简单循环不够用。

### 1. 多对话、长生命周期

TUI 是单会话常驻 UI；headless 是一次 prompt 后退出。Gateway 要同时服务多个私聊/群聊/论坛 topic，进程可能跑很久。若每个对话常驻完整 harness，内存会失控；若每次消息都新建会话，又会丢掉上下文。因此需要**按路由懒创建、按 idle 回收，但把“这个对话绑定哪个 JSONL 会话”做成 durable binding**。

### 2. 并发与串行的张力

同一对话上用户可能连续发多条消息，agent 还可能进入工具调用的多 turn run。同一 session key 上必须串行控制 harness；运行中到来的消息则需要可配置策略：注入当前 run（steer）、作为 follow-up、或打断后重新开 turn。

### 3. 平台差异与流式呈现

Telegram 有 4096 UTF-16 限制、FloodWait、edit-stream、forum topic；飞书有 WebSocket 长连接、3 秒回执约束、不支持 edit-stream 与 thread。Gateway 不能把 telegraf / Lark SDK 细节泄漏到 agent 层，也不能让 channel 理解 `AgentHarnessEvent` 的全部语义。平台差异还延伸到媒体：Telegram 的 photo / document / voice / sticker 是异构载荷，其中 image 要进入 agent 多模态输入，file / voice 只需一个可引用的本地路径——channel 必须把这些差异收敛成统一的附件模型，而不是让编排层各自处理。

### 4. 非交互权限与访问控制

Gateway 没有 TUI Approver。权限门是非交互 fail-closed（可用 `--yes` 放宽 ask）。另外还要在 DM pairing、allowlist、群 mention/reply gate 等策略下，防止未授权用户或群噪音直接进入 agent。

### 5. 协议可替换性

当前 agent 后端是进程内 harness，但编排层不应绑死实现。`AgentProtocolAdapter` 让未来远程适配成为可能，而不必重写 `GatewayApp` 与 session lane。

---

## 核心抽象

### ChannelAdapter：平台边界

`ChannelAdapter`（`src/gateway/core/types.ts`）定义 channel 必须具备的能力：

- 生命周期：`start` / `stop`
- 入站：由 orchestrator 注入 `onMessage`
- 出站：`send` 最终文本；可选 `sendEvent` / `sendTyping` / `cancelStream`
- 能力声明：`capabilities`（edit、threads、markdown 等）与 `textChunkLimit`

`AbstractChannel.emitMessage` 先可选 ack，再调用注入的 `onMessage`。具体实现如 `TelegramChannel` 负责 long-poll、消息归一化、edit-stream 缓冲与 chunk 切分。**Channel 不创建 harness，也不订阅 `AgentHarnessEvent`；它只消费 orchestrator/bridge 投影后的 `ChannelEvent` 回调。**

`ChannelCapabilities` 是 channel 向编排层声明自身能力的契约：`edit`（能否 edit-stream）、`threads`（能否收发 thread/topic）、`markdown`、`media`（能否收发媒体附件）等。`TelegramChannel` 声明 `edit: true` / `threads: true` / `media: true`；`FeishuChannel` 声明 `edit: false` / `threads: false` / `media: false`。编排层与 session lane 依据这些声明决定是否调用 `sendEvent`、是否传递 `threadId`，能力缺失时静默降级而不是报错。

入站媒体通过 `ChannelMessage` 的**双字段附件模型**承载：`attachments?: ChannelAttachment[]` 记录每个附件的元数据（`kind` 为 `image` / `file` / `voice`，以及 `mimeType` / `size` / `filename` / `remoteFileId` / `localPath`），持久化进 inbox；`images?: ImageContent[]` 携带运行时 base64 图像数据，**不**持久化。这个区分服务于两个不同目标：`attachments` 让崩溃恢复后仍知道对话中出现过哪些文件；`images` 只在当前 turn 把图像送进 `harness.prompt(text, { images })`，体积大且不属于文本记录，因此不落盘。附件模型与跨渠道语义契约的细节见 [gateway-messaging-semantics.md](./gateway-messaging-semantics.md)。

`FeishuChannel` 是 channel 抽象的能力受限锚点。它使用 `@larksuiteoapi/node-sdk` 的 WebSocket 长连接（而非 long-poll），SDK 的 policy 层被显式禁用（`requireMention: false`、`dmMode: "open"`），授权与去重统一交给 `GatewayApp`。这表明 channel 抽象允许入站路径的可靠性模型不同（Telegram 靠 offset 推进、飞书靠 durable inbox 兜底），只要最终到达 `emitMessage` 即可。

### GatewaySessionRoute：对话身份

一条路由包含：

- **locator**：`channel` 类型、`account`（配置实例 id）、`chat.{type,id}`、可选 `thread`
- **key**：由 locator 规范编码得到的 cache / store key

关键事实：forum topic 的 `thread` 会进入 key，因此 topic 与父 chat **不会**共享同一个 harness。`sessionRoute(channel, msg)` 是入站时构造路由的统一入口（`src/gateway/core/routing.ts`）。

### GatewayApp：入站编排器

`GatewayApp` 持有 channels、session manager、command registry 与安全策略。它不实现模型调用，只把“能不能进 agent、以什么身份进、是命令还是普通消息”这件事做完，再交给 session 层。

### SessionLane / GatewaySessionManager：运行时队列与容量

- **SessionLane**：每个 `sessionKey` 一条 lane，状态为 `idle | running`，本地队列只保留 interrupt / system-operation 类条目。
- **GatewaySessionManager**：懒创建 lane、idle timeout 扫描、max concurrent 时驱逐最久未活动且非 running 的 lane、`/new` 的 reset barrier。

Manager 管的是**运行时容量**；它**不**删除 durable binding。

### AgentProtocolAdapter / NoviAgentAdapter：agent 后端门面

协议操作包括 `runTurn` / `steer` / `followUp` / `abort` / `resetSession` / `closeSession` 等。`NoviAgentAdapter` 在其内部：

- 懒创建或 resume harness（`createHarnessForSession`）
- 用 `GatewaySessionStore` 持久化 route → JSONL metadata
- 用 generation 守卫屏蔽已被 `/new` 作废的迟到事件
- 用 `createEventBridge` 订阅 harness 事件并回调 lane

### createEventBridge：唯一 harness 订阅点

这是 gateway 侧 N2 边界：channel 只收回调，不直接读 `AgentHarnessEvent`。工具 payload 仍交给共享的 `ToolEventDecoder`（`src/tools/events.ts`），与 TUI / headless 共用解释权。

### PairingStore 与 GatewaySessionStore：两类持久化

| Store                 | 文件（默认）                    | 语义                          | 失败策略                          |
| --------------------- | ------------------------------- | ----------------------------- | --------------------------------- |
| `PairingStore`        | `~/.novi/gateway-pairing.json`  | DM 授权名单与 pending code    | 损坏/缺失 → fail-closed（未授权） |
| `GatewaySessionStore` | `~/.novi/gateway-sessions.json` | route → JSONL session binding | 损坏 → **阻止启动**（strict）     |

两者都是文件持久化、mutation 串行；session store 额外用 temp + rename 做原子提交。

---

## 运行机制（主路径）

下面沿一条代表性主路径说明：已授权用户在 Telegram 私聊发了一句普通文本，agent 跑完后把最终回复编辑/发送回该 chat。

### 0. 进程装配（启动一次）

`runGateway`（`src/gateway/run.ts`）在 `action=run` 时大致做：

1. provider probe：未配置则 fail + guidance（与 headless 一致，无 onboarding wizard）。
2. trust：存在 gated 项目资源时按 headless 规则把 `ask` 当作 `never`。
3. `prepareGatewayEnv({ toolMode: "gateway" })`：进程级共享环境（credentials、settings、models、权限策略、preflight 工具装配等）。
4. `loadGatewayConfig`：用户层 +（受 trust 门控的）项目层 `gateway.json`，`${ENV}` 展开，默认值填充。
5. `createChannels`，打开 `GatewaySessionStore` / `JobStore`，构造 `NoviAgentAdapter`、`GatewaySessionManager`、command registry，并接线 `AutomationAgentRunner` / `DeliveryService` / `HeartbeatService` / `GatewayScheduler`。
6. `scheduler.prepare()` → `app.start()`（给每个 channel 注入 `onMessage` 并 `start`；session manager 开启 idle 清理定时器）→ `scheduler.start()`。
7. 进程靠 channel 轮询保持存活；`SIGINT`/`SIGTERM` 先 `scheduler.stop()`，再 `app.stop()`。

`status` / `probe` 分支故意**不**构造 harness，只加载配置与 channel，用于运维诊断。

### 1. Channel 入站归一化

以 `TelegramChannel` 为例：long-poll 收到 text message 后，`normalizeMessage` 产出统一 `ChannelMessage`：

- `remoteChatId` / `senderId` / `text` / `chatType`
- 可选 `threadId`（forum topic）
- `metadata.updateId`（用于去重）
- `metadata.replyToBot` / `mentionedBot`（供群策略使用）

然后 `emitMessage` → `GatewayApp.onInbound`。

**媒体消息走另一条归一化路径。** `TelegramChannel` 注册了 `photo` / `document` / `voice` / `sticker` 四类 handler，统一进入 `handleMediaMessage`。该方法先排除 animation / sticker（它们带 `document` 字段但不是普通文件，只发诊断占位），再调用 `normalizeMediaMessage`：`extractAttachment` 从 Telegram 消息抽出 `ChannelAttachment` 元数据后，按 `kind` 分叉——`image` 走 download → base64 → `ChannelMessage.images`（多模态路径，不落盘）；`file` / `voice` 走 download → `saveAttachmentFile` → `attachment.localPath`（落盘到 `$NOVI_HOME/gateway-media/` 下）。caption 作为 `text` 传给 agent，附件元数据随 `attachments` 持久化。这样 orchestrator 和 agent adapter 看到的始终是统一的 `ChannelMessage`，不需要知道 Telegram 的 photo size 数组或 voice ogg 编码。

### 2. 去重与授权

`onInbound` 的顺序本身就是设计：

1. **先 dedupe**：`InboundDeduper` 用 `channelId:updateId` 做 TTL 去重，避免平台重投导致双跑。
2. **再处理 pairing 特例**：群内 `/pair approve …` 直接丢弃，永不进 agent；DM 中仅 `adminAllowlist` 可批准，且批准动作本身不授予普通 agent 回合。
3. **再 `isAuthorized`**：
   - DM：`disabled` / `open` / `allowlist` / `pairing`；pairing 未授权时发 code，返回 false。
   - 群：`groupPolicy`、群 allowlist、sender allowlist、ignored threads、`requireMention`（slash command / reply-to-bot / @bot / 配置的 mention pattern 可放行）。
4. **再构造 `sessionRoute`**。
5. **slash command 内联处理**（`/status` 在 app 内直接回复；`/new` `/stop` `/help` `/jobs` 等经 command registry），成功则 return，**不进** session queue。
6. 普通消息按 `queue.mode`（可被 `queue.byChannel` 覆盖）`sessionManager.enqueue`。

从测试与实现可以确认：pairing 审批与普通 allowlist 是不同边界；群里出现的 approve 文本即使群策略 open 也不会变成 agent 输入。

### 3. Session lane 调度

`GatewaySessionManager.enqueue`：

- 若该 route 正在 `/new` reset，先等待 barrier。
- `getOrCreate(route)` 懒建 lane；超过 `maxConcurrent` 时驱逐最老 idle lane，并 `agent.closeSession`（只关运行时，不动 binding）。
- `enqueueMessage(lane, agent, { channel, msg, mode })`：

| lane 状态 | mode        | 行为                                                                  |
| --------- | ----------- | --------------------------------------------------------------------- |
| idle      | 任意        | 立即 `runTurn`                                                        |
| running   | `steer`     | `agent.steer`；失败则尝试 `followUp`；再失败则当 interrupt 入本地队列 |
| running   | `followup`  | `agent.followUp`；失败则入本地队列                                    |
| running   | `interrupt` | `agent.abort`，消息入本地队列，待当前 turn 结束后新开 turn            |

默认配置是 `steer`：用户在 agent 思考/工具调用时继续说话，优先注入当前 run，而不是默认打断。

### 4. 跑 turn：adapter + event bridge

`runTurn`（lane）把 channel 能力包装成 `AgentProtocolTurnCallbacks`，再调用 `agent.runTurn`：

1. `NoviAgentAdapter.getOrCreateHarness(route)`
   - 有 binding → resume 既有 JSONL session
   - 无 binding → 新建 harness，**先** `store.bind` 成功，**再**把 entry 放进内存 cache
   - 并发首条消息共享同一个 pending promise
2. `createEventBridge(harness, guardedCallbacks, toolCatalog)` 订阅一次。
3. `harness.prompt(text)`。
4. finally 里 unsubscribe。

Bridge 投影规则（源码事实）：

- `turn_start` → `onTyping`
- `message_update` 的 `text_delta` / `thinking_delta` → 对应 delta 回调
- 工具生命周期 → 共享 `ToolEventDecoder` → `onToolEvent`
- assistant 的 `message_end` **只缓冲**最新文本
- **`agent_end` 才 `onTurnEnd(finalText)`**

这保证多 turn 工具调用只会在 channel 上落一条“最终回复”，而不是每轮 assistant narration 各发一条。

### 5. 出站：流式编辑与静默

Lane 在 `onTextDelta` 中会先缓冲可能的静默标记前缀（`SILENT` / `[SILENT]` / `NO_REPLY` / `NO REPLY`）。只有确认不可能是静默标记后，才按序放行到 `channel.sendEvent({ type: "text-delta" })`。

Telegram 侧：

- 首个 delta 发 placeholder message，记下 message id
- 后续 delta 按 `editIntervalMs` 节流 `editMessageText`
- `onTurnEnd`：若最终文本是静默标记 → `cancelStream`（删除 placeholder），否则 `send` 把 placeholder 编辑成最终文本并处理 4096 溢出 chunk

若 `runTurn` 抛错，lane 会 best-effort 发送 `Error: …` 到原 target，避免用户只看到沉默。

### 6. 主路径时序（概念图）

```text
Telegram update
  → TelegramChannel.normalizeMessage + emitMessage
  → GatewayApp: dedupe → authorize/pair → (commands?) → sessionRoute
  → SessionManager.getOrCreate lane → enqueueMessage
  → NoviAgentAdapter.getOrCreateHarness (bind/resume)
  → createEventBridge + harness.prompt
  → deltas/tool events → channel.sendEvent / sendTyping
  → agent_end → onTurnEnd → channel.send | cancelStream
```

---

## 关键设计

### 1. 授权在队列之前，命令绕过队列

简单实现容易“先入队再鉴权”，结果是未授权流量占用 lane，或 pairing 文本被模型读到。Gateway 把 **normalize/dedupe → authorize → command → enqueue** 固定在 `GatewayApp`：

- 未授权消息在 orchestrator 边界结束。
- `/new`、`/stop` 等控制面命令不与用户自然语言抢同一套 queue mode。
- pairing approve 有独立 admin 边界：能批准不等于能聊天；群内 approve 永不进 agent。

这把安全策略收敛在一个组件里，channel 与 agent adapter 无需各自实现半套 ACL。`FeishuChannel` 作为第二个 channel 实例验证了这一设计：它显式禁用 SDK 的 policy 层（`requireMention: false`、`dmMode: "open"`），把授权完全交给 `GatewayApp`，而不是在 channel 内复制一份 mention/DM 判断。

### 2. Route key 结构化，而不是 `chatId` 字符串凑合

`sessionKeyForLocator` 编码 `gateway / channel / account / chatType / chatId [/ thread]`。这解决三类混淆：

- 多 bot 账号（account id）
- 私聊与群聊同数字 id 的潜在碰撞
- forum topic 与父会话隔离

Session store 还校验 key 必须等于 locator 的规范编码，防止“内存 key 与持久化 locator 漂移”。

### 3. 运行时 cache 与 durable binding 分离

这是理解 gateway 会话语义的关键点：

- **Lane / harness cache** 可被 idle timeout 或 max concurrent 回收；`closeSession` 等待 idle 并关闭 MCP，**保留** binding。
- **Binding** 记录 route → JSONL metadata；进程重启后 cold resume。
- **`/new`** 才会 `resetSession`：abort 旧 harness、generation++、新建 session、`store.rotate`（旧 binding 进 archive）。

若 resume 失败或 metadata 不匹配，adapter **保留原 binding**，要求用户显式 `/new`，避免静默换会话导致“历史丢了却不知道”。绑定写入失败时不会把半成品 entry 放进 cache。这些不变量在 `novi-agent-adapter.test.ts` / `session-store.test.ts` 中有直接覆盖。

### 4. Event bridge 在 `agent_end` 才交付最终文本

若每个 assistant `message_end` 都 `channel.send`，工具调用链会刷屏。Bridge 选择：

- 流式 delta 可以边生成边 edit-stream
- 最终落库/落 chat 的“完成态文本”以 `agent_end` 为准，且只保留最新 assistant 文本

同时 adapter 用 generation 守卫：`/new` 作废旧 generation 后，旧 run 的迟到 delta / `onTurnEnd` / abort 错误不会污染新会话。测试明确断言旧 generation 的 `onTurnEnd` 不会触发。

### 5. 静默回复是一等公民，而不是事后过滤

主动能力与某些 agent 策略需要“处理了但不要在 IM 上说话”。因为最终文本晚于 delta，lane 不能先把 `S`、`SI`、`SIL`… 流出去再撤回。它维护 `silentPending` 前缀缓冲：

- 仍可能是静默标记前缀 → 先不转发 delta
- 已不可能 → 按序一次性放行已缓冲文本
- 最终若是静默标记 → `cancelStream`，不 `send`

这是对“流式 UX”与“可静默”两个目标的显式折中，而不是 channel 各自特判。

### 6. image 走多模态、file/voice 落盘：两条附件路径

入站媒体在 `normalizeMediaMessage` 里按 `kind` 分叉，不是因为 Telegram 的 API 结构如此，而是因为 agent 对两类附件的**消费方式**不同：

- **image** 要进入当前 turn 的多模态输入——`session-lane` 把 `ChannelMessage.images` 传给 `AgentProtocolTurnInput.images`，最终 `harness.prompt(text, { images })`。图像是 agent “现在就要看”的上下文，走 download → base64 → 内存，不落盘。
- **file / voice** 不进入模型输入，而是作为对话中存在的文件被引用（如工具可能读取 `localPath`）。它们走 download → `saveAttachmentFile` → `attachment.localPath`，落盘到 `$NOVI_HOME/gateway-media/<hash-prefix-2>/`。

双字段模型对应这个分叉：`attachments` 持久化元数据（含 `localPath`），让 inbox 记录“这个对话出现过哪些文件”并在崩溃恢复后可查；`images` 只存活于当前 turn，base64 体积大且不属于文本记录，持久化它会让 inbox 膨胀却没有检索价值。代价是 image 不落盘意味着崩溃恢复后多模态上下文丢失——重建 `images` 从 `attachments[].localPath` 是 media 子任务的责任，而非这一层契约的职责（见 [gateway-messaging-semantics.md](./gateway-messaging-semantics.md)）。

`ChannelCapabilities.media` 是这一能力的声明位：`TelegramChannel` 声明 `media: true` 并实现完整入站媒体；`FeishuChannel` 声明 `media: false`，非 text 内容降级为 `[unsupported message type: ...]`。这表明媒体是 channel 可选能力，而不是编排层的假设。

---

## 异常与边界

### 单 channel 启动失败可降级

`GatewayApp.start` 对每个 channel 的 `start()` 单独 try/catch：失败写 warning 并跳过，不拖垮整个进程。这与“多 channel 中一个坏 token 不应让全部停摆”的运维预期一致。

### 入站处理的错误不抛出进程

`onInbound` 顶层 catch 只写 stderr warning。单条消息的异常路径不应打崩 long-poll 循环。

### 权限与信任：非交互默认

Gateway 的 `toolMode` 为 `"gateway"`；与 headless 一样，无交互 Approver 时 ask 类权限 fail-closed，除非 CLI `--yes`。Project trust 也按 headless 规则处理。Gateway **不**替代 MCP approval：项目 MCP 仍走独立批准文件（系统级约定，见架构地图）。

### Pairing 与 session store 的不同严格度

- Pairing 文件缺失：从空的 v1 授权状态开始；文件损坏或仍是旧 schema：启动前置检查失败，要求显式迁移或修复，绝不静默清空授权。
- Session store 坏了：启动失败。原因是 binding 错误会导致错误 resume 或静默丢上下文，属于更危险的一致性问题。

### systemd 用户服务边界

Linux 上可以用 `novi --gateway service install` 安装单实例 user unit。安装器固定当前 Node、编译后的 `dist/cli.js`、工作目录、`NOVI_HOME` 与可选配置路径，先做只读 config/schema preflight，再原子发布 unit 与私有 manifest。它不会使用 sudo、写 `/etc`、下载 Node/Novi，或把 token 写进 unit。

默认安装会 `enable --now`，但这只保证登录后的 user manager 自动拉起。只有显式 `--linger` 才调用 `loginctl enable-linger`，从而支持未登录时开机运行；卸载永远不关闭 linger。unit 使用 `Type=exec`、失败重启、60 秒 SIGTERM 停止窗口和 systemd `RuntimeDirectory=novi` 的私有控制套接字目录。

常用运维入口：

```bash
novi --gateway service status
novi --gateway service logs --lines 200
novi --gateway service restart
novi --gateway service uninstall
```

升级 Novi 后再次 install 会比较 deterministic unit。内容变化必须显式 `--replace`；卸载时 unit hash 与 manifest 不一致也会保留用户修改，除非对预期位置的 regular file 使用 `--force`。

### 热更新边界

`SIGHUP` 只允许安全策略与 group routing 热更（`reloadPolicy`）。channels、queue、session、stream、automation、heartbeat 变更要求重启；源码把这些字段视为不能热替换的运行时快照。从 Telegram long-poll 的接入方式看，同 token 也难以在不中断监听的前提下平滑 handoff。热更候选若带 validation warning，会拒绝应用，保留内存中 known-good 配置。

### 驱逐与 reset 的边界

- 驱逐 running lane：idle 扫描会跳过 `status === "running"`；max concurrent 也只驱 idle。
- reset barrier：`/new` 先清空本地 queue并发布 promise，后到的消息会等 reset 完成再进入**新**会话；reset 失败后后续消息仍可继续（测试覆盖）。
- 关闭：`closeSession` 串行化，避免 double-close；stop 时排空 pending 初始化再逐 route 关闭。

### Channel 渲染边界

Telegram 对 tool 事件目前只做最小展示（如 tool.start 发一行标签）；reasoning delta 默认不投递到 chat。FloodWait / 5xx / 网络类错误有限次重试；`message is not modified` 被吞掉以免噪声。这些是 channel 本地策略，不回流到 agent 协议。

`FeishuChannel` 声明 `edit: false`，因此不实现 `sendEvent`。`session-lane` 通过 `channel.sendEvent?.()` 可选链调用，能力缺失时静默跳过——用户只在 turn 结束时收到一条完整回复，没有中间编辑流。这是“能力声明 + 可选调用”设计在运行时的直接效果：channel 不需要模拟 edit-stream，编排层也不需要为每个 channel 分支判断。

### 媒体处理失败边界

Telegram 媒体下载或编码可能失败（网络、文件过大、mime 不受支持）。`handleMediaMessage` 用 try/catch 包裹下载与编码，失败时降级为带诊断文本的普通 `ChannelMessage`：image 失败发 `[image download failed: …]`，file/voice 失败发 `[file download failed: …]`，caption 仍保留。这保证一条坏媒体不会阻塞 `emitMessage`，也不会打崩 long-poll 循环。

animation / sticker 虽然带 `document` 字段但不是普通文件，`handleMediaMessage` 在进入下载前就识别它们，发 `[unsupported media type: animation]` / `[unsupported media type: sticker]` 占位，避免无意义的下载尝试。

`saveAttachmentFile` 把文件写入 `$NOVI_HOME/gateway-media/<hash-prefix-2>/`，目录 `0o700`、文件 `0o600`，与 message-store 的安全姿态一致。`sanitizeFilename` 剥离目录组件与路径分隔符，防止平台提供的文件名造成路径穿越。

### 本文未展开但存在的主动面

Gateway 进程还装配了 `JobStore` / `JobService` / `GatewayScheduler` / `AutomationAgentRunner` / `DeliveryService` / `HeartbeatService`：在长生命周期进程上提供 durable 定时任务、心跳检查与至少一次投递等**主动**能力，并可通过 `/jobs` 与 jobs 工具与对话路由交互。它们复用 session route、session manager 的 system operation 队列以及 adapter 的部分接口，但状态机、调度锁与预算账本不在本文范围。

---

## 设计权衡

### 收益

- **主线清晰**：IM 协议、访问控制、会话串行、agent 后端、事件投影分层，各自可测。
- **资源可控**：懒创建 + idle/maxConcurrent 回收，同时用 strict binding 保住跨重启上下文。
- **流式体验与最终一致性兼顾**：edit-stream 提供中间反馈，`agent_end` 决定最终文本，静默标记避免空吵。
- **可替换后端**：`AgentProtocolAdapter` 把 orchestrator 从 `AgentHarness` 细节中隔开。
- **安全默认**：未授权 fail-closed；群 approve 不进模型；非交互权限默认收紧。

### 成本

- 组件数量多于“一个 bot handler 调一次 LLM”：route / lane / store / adapter / bridge 都有学习成本。
- silent prefix 缓冲会给极短前缀带来轻微流式延迟（为正确性付费）。
- session store 严格失败会让配置损坏直接阻止启动，运维上需要备份/修复，而不是 silent repair。
- queue mode 的 steer/followup 语义依赖 harness 是否接受注入；失败路径回落到 interrupt 队列，行为对用户不完全透明。
- 媒体附件的 `media` 是 channel 能力声明位，但目前只有 `TelegramChannel` 实现，`FeishuChannel` 声明 `media: false`，非 text 内容降级为占位文本。跨渠道的媒体能力并不对等。
- image 走 base64 内存路径不落盘，崩溃恢复后多模态上下文丢失；重建 `images` 从 `attachments[].localPath` 是 media 子任务的责任，编排层不自动恢复。
- `FeishuChannel` 证明了“少能力 channel”路径可行，但也意味着 edit-stream 的中间反馈体验不是所有渠道都有——飞书用户只在 turn 结束时看到完整回复。

### 适用范围

适合：需要把 Novi agent 接到 IM、多对话并行、要保留会话上下文、并接受常驻 Node 进程的场景。

不太适合：期望完整交互式审批 UI 的场景（应使用 TUI）；或只想一次性脚本调用（应使用 headless）。若需要强 OS 级隔离，Gateway 本身也不提供沙箱——它沿用 Novi 工具与权限模型。

### 实现选择 vs 业务必然

下列更像当前实现选择，而非 IM agent 的唯一解：

- 默认 queue mode = `steer`
- Telegram 作为首个 channel、long-poll 而非 webhook；飞书作为第二个 channel、WebSocket 长连接
- 最终回复以 `agent_end` 而非最后一个 `message_end` 为界
- pairing 文件 fail-closed 但可启动，session store 则 strict
- image 走 base64 多模态、file/voice 走落盘，而非统一落盘或统一内存

若替换这些选择，主线分层（channel / app / lane / adapter / bridge）仍可保持稳定。

---

## 小结：应建立的心智模型

把 Gateway 记成一条管道，而不是一堆文件：

> **Channel 把外部世界收成 `ChannelMessage` → `GatewayApp` 决定谁能进、是否命令 → 每个 `GatewaySessionRoute` 一条串行 lane → `NoviAgentAdapter` 懒装/resume harness → `event-bridge` 把一次 run 投影回 channel → 最终 `send` 或静默取消。**

围绕这条主线，durable binding 解释“为什么重启后还认识你”，queue mode 解释“你插话时会发生什么”，pairing/group policy 解释“为什么有的消息石沉大海”，generation/reset 解释“`/new` 如何切开新旧世界”。`jobs/` 则是这条常驻管道上额外长出的主动触角，而不是入站主路径的一部分。

---

_证据范围：当前工作树 `src/gateway/**` 与相关测试；系统位置参照 `ARCHITECTURE.md`。未使用任何已删除的旧 gateway 运维/设计文稿。_
