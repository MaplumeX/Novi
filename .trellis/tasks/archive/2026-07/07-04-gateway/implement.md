# Novi multi-channel gateway — 执行计划

## 实现顺序

按依赖关系自底向上：接口 → bootstrap 拆分 → agent 适配器 → 队列/会话管理 → 渠道实现 → 编排层 → CLI 集成 → 测试。

### Phase 1: 核心接口与类型（无依赖）

- [ ] **1.1** `src/gateway/core/types.ts`：`ChannelType` / `ChannelCapabilities` / `ChannelAdapter` / `ChannelMessage` / `ChannelEvent` / `AgentProtocolAdapter` / `AgentProtocolTurnCallbacks`
- [ ] **1.2** `src/gateway/core/abstract-channel.ts`：`AbstractChannel` 基类（抄 tia-gateway，`emitMessage` helper + 抽象 `start/stop/send`）
- [ ] **1.3** `src/gateway/config.ts`：`gateway.json` schema + `${ENV}` 展开 + 两层加载（用户/项目，项目层 trust 门控）+ 失败降级 diagnostic
- [ ] **validation**：`npm run typecheck`

### Phase 2: bootstrap 拆分（唯一对现有代码的改动）

- [ ] **2.1** 从 `bootstrap()` 抽出 `prepareGatewayEnv(options) → GatewayEnv`：env / credentials / settings / models+custom / systemPrompt / resources / hookConfig（不含 session/harness）
- [ ] **2.2** 新增 `createHarnessForSession(gatewayEnv, sessionKey) → { harness, session }`：repo.create session → new AgentHarness → setTools → setResources → registerHooks → setStreamOptions → setSteeringMode/setFollowUpMode
- [ ] **2.3** 保持 `bootstrap()` 原签名与 `BootstrapResult` 契约不变，内部委托给上述两个函数；TUI 路径回归测试
- [ ] **validation**：`npm run typecheck && npm test`（确保现有 bootstrap 测试全绿）

### Phase 3: Agent 适配层

- [ ] **3.1** `src/gateway/agent/event-bridge.ts`：`createEventBridge(harness, callbacks)` — harness.subscribe → callbacks。复用 `headless/events.ts` 的 `extractText`。投影规则：
  - `message_update` `text_delta` → `onTextDelta(delta)`
  - `message_update` `thinking_delta` → `onReasoningDelta(delta)`
  - `tool_execution_start/end` → `onToolCall(toolName, status)`
  - `turn_start` → `onTyping()`
  - `message_end`(assistant) → `onTurnEnd(extractText(content))`
- [ ] **3.2** `src/gateway/agent/novi-agent-adapter.ts`：`NoviAgentAdapter` 实现 `AgentProtocolAdapter`
  - `getOrCreateHarness(sessionKey)`：懒创建 + 缓存
  - `runTurn`：idle → prompt + EventBridge；返回 final text
  - `steer`/`followUp`/`abort`：转发 harness API
  - `resetSession`/`closeSession`：waitForIdle + close + 移除缓存
- [ ] **validation**：`npm run typecheck`

### Phase 4: 会话队列与管理

- [ ] **4.1** `src/gateway/core/session-manager.ts`：`GatewaySessionManager`
  - per-sessionKey `SessionLane`（status / queue / lastActivity / harness）
  - `getOrCreate(sessionKey)`、`enqueue(sessionKey, channel, msg, mode)`
  - 空闲超时淘汰（setInterval 2min unref）+ maxConcurrent 淘汰最老空闲
  - `stop()`：关闭所有 session
- [ ] **4.2** `src/gateway/core/session-lane.ts`：单 lane 的队列分发逻辑
  - idle 时：直接 prompt
  - running 时按 mode：steer → harness.steer；followup → 排队；interrupt → abort + 排队
  - slash 命令 bypass 通道（`isCommand` 标记，不进队列）
- [ ] **validation**：`npm run typecheck`

### Phase 5: Telegram 渠道

- [ ] **5.1** `package.json` 添加 `telegraf` 依赖（`npm install telegraf`）
- [ ] **5.2** `src/gateway/channels/telegram.ts`：`TelegramChannel extends AbstractChannel`
  - capabilities: `{ chatTypes:["direct","group","channel","thread"], edit:true, markdown:true, blockStreaming:true }`
  - `textChunkLimit = 4096`
  - `start()`：`bot.launch()`，`bot.on(message("text"))` 过滤 `chat.type === "private"` → `emitMessage`
  - `sendEvent`：text-delta → 节流 edit-stream（首条 sendMessage 占位 + 1s 节流 editMessageText）；typing → sendChatAction
  - `send`：最终文本，超 4096 分条续发（UTF-16 长度计算）
  - FloodWait 错误处理：读 `retry_after` 等待
- [ ] **5.3** `src/gateway/channels/index.ts`：`createChannel(config)` 工厂 switch（MVP 只有 telegram case）
- [ ] **validation**：`npm run typecheck`

### Phase 6: 编排层与命令

- [ ] **6.1** `src/gateway/core/commands.ts`：`CommandRegistry` + `runCommand`
  - `/new` → `agent.resetSession(sessionKey)` + 回复确认
  - `/stop` → `agent.abort(sessionKey)` + 回复确认
  - `/help` → 列出命令
  - `/status` → session/model 信息
- [ ] **6.2** `src/gateway/core/gateway-app.ts`：`GatewayApp`
  - `start()`：遍历 channels，`channel.onMessage = onInbound`，try/catch 启动（失败 diagnostic + skip，N3）
  - `onInbound`：allowlist 检查 → slash 命令 bypass → sessionManager.enqueue
  - `stop()`：sessionManager.stop + channels.stop + agent.stop

### Phase 7: CLI 集成与入口

- [ ] **7.1** `src/cli.ts`：`parseArgs` 新增 `gateway`（boolean）+ `config`（string）
  - help 文本补充 `--gateway` / `--config`
  - `--gateway` 分支 → `runGateway(bootstrapOptions)`
- [ ] **7.2** `src/gateway/run.ts`：`runGateway(options)`
  - `probeProviderConfigured`（复用现有）→ 失败打印指引 + exit
  - trust 解析（headless 规则 ask→never）
  - `prepareGatewayEnv` → 加载 `gateway.json` → `createChannels` → `new GatewayApp` → `start()`
  - Ctrl+C / SIGINT → `gatewayApp.stop()` 优雅退出

### Phase 8: 测试

- [ ] **8.1** `src/gateway/config.test.ts`：`${ENV}` 展开、两层加载、项目层 trust 门控、失败降级
- [ ] **8.2** `src/gateway/core/session-lane.test.ts`：4 模式分发（steer/followup/interrupt）、slash bypass、idle/running 状态
- [ ] **8.3** `src/gateway/core/session-manager.test.ts`：懒创建、空闲淘汰、maxConcurrent 淘汰
- [ ] **8.4** `src/gateway/agent/event-bridge.test.ts`：harness 事件 → callbacks 投影
- [ ] **8.5** `src/gateway/channels/telegram.test.ts`：mock telegraf，验证 emitMessage / send / sendEvent 节流逻辑
- [ ] **8.6** `src/bootstrap.test.ts`（或现有测试补充）：验证拆分后 TUI 路径回归

### Phase 9: 质量门

- [ ] `npm run typecheck`
- [ ] `npm run lint`
- [ ] `npm test`

## 验证命令

```bash
npm run typecheck   # tsc --noEmit
npm run lint        # eslint .
npm test            # vitest run
```

## 风险点与回滚

| 风险 | 缓解 | 回滚点 |
|---|---|---|
| bootstrap 拆分破坏 TUI | Phase 2 完成后立即跑 `npm test`，全绿才继续 | revert bootstrap.ts，types/interfaces 不受影响可保留 |
| telegraf 版本/API 不兼容 | Phase 5 开始前先 `npm install telegraf` 验证 import | 移除依赖 + telegram.ts |
| Telegram FloodWait | 1s 节流 + retry_after 处理 | 降级为攒批 send（去掉 sendEvent） |
| harness steer 失败 | session-lane 降级为 followup 排队 | 单元测试覆盖降级路径 |

## 后续 Phase（不在本次范围）

- 飞书渠道
- 媒体收发（MIME 嗅探 + 出站路径 guard）
- collect 模式（debounce 合并）
- DM pairing 授权
- 跨平台投递 / cron
- 渠道插件化 `register(ctx)`
- 进程外网关（`novi --serve`）