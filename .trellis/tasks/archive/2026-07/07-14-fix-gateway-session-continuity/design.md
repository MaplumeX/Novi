# Gateway 会话连续性技术设计

## 1. 设计目标

为 Gateway 增加一个独立于进程内 harness/lane 缓存的持久路由层：稳定的外部会话定位符解析到当前 Novi JSONL 会话。进程重启和闲置淘汰只重建运行时资源，不改变持久路由；只有显式 `/new` 才轮换当前 `sessionId`。

本设计不引入数据库，不改变 JSONL 正文格式，不实现跨渠道身份认证或绑定命令。

## 2. 关键概念与边界

### 2.1 外部会话定位符

新增结构化 `GatewaySessionLocator`：

```ts
interface GatewaySessionLocator {
  channel: string; // ChannelAdapter.type，例如 "telegram"
  account: string; // ChannelAdapter.id，表示配置中的 bot/account 实例
  chat: {
    type: ChatType;
    id: string; // 渠道原生 chat id
  };
  thread?: string;
}
```

`channel` 与 `account` 分离，避免把“渠道种类”和“同一渠道下的账号实例”混为一个字段。群聊是否按 sender 隔离不在本任务改变：定位符保持现有 `chat/thread` 共享语义。

`sessionRoute(channel, message)` 一次性返回 `{ key, locator }`。`key` 采用带 URI 编码的可读格式，避免字段中的 `:` 造成碰撞：

```text
gateway:<channel>:<account>:<chatType>:<chatId>[:thread:<threadId>]
```

GatewayApp、SessionManager、命令上下文和 Agent adapter 传递同一个 route，不允许各层重新拼接或解析字符串。

### 2.2 Novi 会话引用

映射记录保存完整 `JsonlSessionMetadata`（`id/createdAt/cwd/path`），逻辑主键仍是 `sessionId`。保存 metadata 是因为 `JsonlSessionRepo.open()` 的公开契约以 metadata/path 恢复会话；恢复时不扫描目录、不猜测“最新会话”。

### 2.3 所有权

- `gateway/core/session-store.ts`：磁盘格式、校验、原子写、绑定与归档事务。
- `gateway/core/routing.ts`：定位符与规范 route key。
- `gateway/core/session-manager.ts`：lane、排队消息与 `/new` 生命周期串行化。
- `gateway/agent/novi-agent-adapter.ts`：绑定解析、harness 缓存、冷恢复、generation 防迟到事件。
- `bootstrap.ts`：只负责从“新建/恢复”目标得到 `Session` 并装配 harness，不持有 Gateway 映射状态。

数据流：

```text
ChannelMessage
  -> sessionRoute(channel, message)
  -> GatewaySessionManager(route)
  -> NoviAgentAdapter
  -> GatewaySessionStore.resolve(route)
  -> JsonlSessionRepo.create/open
  -> AgentHarness
```

## 3. 持久化格式

默认文件：`~/.novi/gateway-sessions.json`（受 `NOVI_HOME` 覆盖）。

```json
{
  "version": 1,
  "bindings": {
    "gateway:telegram:main:direct:123": {
      "locator": {
        "channel": "telegram",
        "account": "main",
        "chat": { "type": "direct", "id": "123" }
      },
      "session": {
        "id": "019...",
        "createdAt": "2026-07-14T00:00:00.000Z",
        "cwd": "/workspace",
        "path": "/home/user/.novi/sessions/...jsonl"
      },
      "boundAt": "2026-07-14T00:00:00.000Z",
      "updatedAt": "2026-07-14T00:00:00.000Z"
    }
  },
  "archives": [
    {
      "locator": {
        "channel": "telegram",
        "account": "main",
        "chat": { "type": "direct", "id": "123" }
      },
      "session": {
        "id": "018...",
        "createdAt": "2026-07-13T00:00:00.000Z",
        "cwd": "/workspace",
        "path": "/home/user/.novi/sessions/...jsonl"
      },
      "archivedAt": "2026-07-14T00:00:00.000Z",
      "reason": "new"
    }
  ]
}
```

约束：

- 缺失文件等价于合法空存储；第一次绑定时创建。
- 已存在文件必须完整通过版本、字段类型、chat type、route key 与 locator 一致性校验，否则抛错并阻止 Gateway 启动。
- 不支持未知版本的宽松读取；不得把损坏文件降级为空映射。
- 写入先生成不可变 next state，再写同目录临时文件（`0600`）并 `rename`，成功后才替换内存快照。
- 同进程内所有写事务通过 Promise 队列串行化。V1 不提供多进程共享 `NOVI_HOME` 的文件锁；Gateway 本身要求单写进程。
- `bindings` 的数据模型允许多个 locator 保存相同 session metadata，为未来显式跨渠道绑定保留能力。本任务不会创建这种关系，也不承诺多个 locator 同时驱动同一 harness；真正开放绑定入口前必须增加按 `sessionId` 的运行时串行化。

## 4. 正常创建与恢复

### 4.1 首次消息

1. Adapter 在该 route 的生命周期锁内查询 store。
2. 无绑定时通过 bootstrap helper 创建 JSONL + harness。
3. 取得真实 metadata 后持久化 binding。
4. binding 写入成功后才发布到 adapter 的内存缓存并开始 turn。
5. 写入失败时关闭新 MCP/runtime，最佳努力删除刚创建且尚未绑定的 JSONL，然后向调用方抛错。

同一 route 的并发初始化共享一个 pending promise，不能竞争创建两个有效 session。

### 4.2 Gateway 重启或缓存淘汰后

1. Store 在渠道启动前完成加载与校验。
2. Adapter 查询到 binding 后调用 `JsonlSessionRepo.open(metadata)`。
3. 打开后校验 JSONL header 的 `id/cwd/path` 与 binding 一致。
4. 使用恢复出的同一 `sessionId` 重新装配 tools、TODO bucket、hooks、permissions 和 MCP。
5. 目标文件缺失、损坏或 metadata 不一致时抛出可见错误；不创建新 session、不修改 binding。

`GatewaySessionManager` 的 idle/max-concurrent 淘汰只删除 lane、关闭 harness/MCP 和 adapter cache，store binding 保持不变。

## 5. `/new` 生命周期事务

`/new` 从直接调用 `agent.resetSession(sessionKey)` 改为调用 `GatewaySessionManager.reset(route)`，由 manager 同时控制 lane 与 adapter。

顺序：

1. Manager 同步登记该 route 的 reset promise，使随后到达的普通消息等待 reset 完成。
2. 清空 reset 开始前已经存在的 lane 本地队列；这些消息属于旧会话。
3. Adapter 递增 route generation 并立即让旧 callbacks 失效。
4. 若旧 harness 正在运行，调用 `abort()`，等待其回到 idle，然后关闭 MCP/runtime 并移除缓存。
5. 创建新的 JSONL + harness，但暂不发布到缓存。
6. Store 以单次原子写完成：旧 binding 追加为 `reason: "new"` 的 archive，并把当前 binding 指向新 metadata。旧目标即使缺失/损坏也允许被归档并替换。
7. 写成功后发布新 cache entry，manager 将 lane 恢复为 idle，等待中的新消息进入新 session。
8. 命令仅在上述步骤完成后回复 `Started a fresh session.`。

失败语义：

- 新会话创建失败：binding 不变，不写 archive。
- store 写失败：binding 与 archive 均不变；新 harness/runtime 被关闭，新 JSONL 最佳努力删除。
- 旧 turn 已被中止但事务失败时，下一条普通消息按旧 binding 重新打开旧 JSONL；不得报告 `/new` 成功。
- 命令失败必须向渠道发送明确错误，不能只写 stderr。

### 5.1 迟到事件和排队消息

Adapter 的每个 `runTurn` 捕获 entry identity/generation。EventBridge 调用任何 channel callback 前检查它仍是当前 generation；reset 后的旧 text delta、turn end 和 error 均被抑制。

SessionLane 对 reset 开始前的本地 interrupt queue 执行清空。Harness 内部 steer/follow-up 队列由 `abort()` 清理。reset 登记后新到达的普通消息等待事务结束，因此归属新 session。

## 6. Bootstrap 调整

将 `createHarnessForSession(gatewayEnv, sessionKey)` 改为接收明确目标：

```ts
type HarnessSessionTarget =
  | { kind: "new" }
  | { kind: "resume"; metadata: JsonlSessionMetadata };
```

helper 内部选择 `repo.create` 或 `repo.open`，后续 harness/tools/resources/hooks/queue-mode 装配完全复用，并在结果中返回 canonical metadata。`bootstrap({ resumePath })` 也委托这个 helper，删除当前重复的 resume 装配代码。Gateway 的 route/sessionKey 不进入 bootstrap，避免通用 bootstrap 反向依赖 `gateway/`。

## 7. 归档与跨渠道边界

- “归档”在 V1 指 binding 历史记录，不移动、重命名、修改或删除 JSONL/TODO。
- `/new` 只轮换发起命令的 locator。未来若多个 locator 绑定同一 session，是否联动轮换属于身份绑定产品语义，不在本任务决定。
- V1 不提供 archive list/resume/delete UI；记录用于未来恢复、审计和清理功能。
- CLI 继续使用现有新建与 `--resume`/TUI `/resume`，不会自动加入 Gateway locator。
- 本功能上线前的旧 Gateway JSONL 不迁移、不自动认领。

## 8. 错误与运营语义

- 映射文件损坏/未知版本：Gateway 在启动渠道前 fail-fast，错误包含文件路径，原文件不修改。
- binding 目标不可打开：该聊天普通消息收到可操作错误，提示修复文件或执行 `/new`；其他聊天不受影响。
- store 临时写/rename 失败：保持旧内存快照与旧磁盘文件。
- 日志不得输出消息正文；route key、sessionId 和映射路径可用于诊断。

## 9. 兼容与回滚

- 无现有用户，因此 route key 和新存储格式不需要迁移兼容层。
- TUI/headless 的新建与 resume 行为保持不变；bootstrap refactor 需用现有测试验证。
- 回滚代码时，新文件只是旁路 metadata，不影响 JSONL/CLI resume；旧版本会忽略它。
- 实现不修改用户已有的未提交文件 `novi-personal-agent-gap-analysis.md`。

## 10. 验证重点

- Store schema、原子 rotate、损坏/未知版本 fail-fast、写失败不污染内存。
- 首次绑定、冷启动恢复、idle 淘汰后恢复、悬空/损坏 target 拒绝普通消息。
- 同 route 并发首次初始化只创建一次。
- 运行中 `/new` 中止旧 turn、清空旧队列、抑制迟到输出、归档旧 binding、切换新 binding。
- `/new` 在 store 写失败时不确认成功，并能从旧 binding 继续。
- bootstrap 的 create/resume 公共装配路径保持 TUI/headless 行为与 TODO sessionId 分桶。

