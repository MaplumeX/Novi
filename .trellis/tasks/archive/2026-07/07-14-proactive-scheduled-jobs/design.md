# Novi 主动任务与提醒闭环：技术设计

## 1. 设计目标与边界

本任务在现有 Gateway 进程内增加单一 scheduler owner，以文件型持久化状态驱动一次性提醒、隔离 LLM Cron 和单例 Heartbeat。设计必须复用现有 Gateway route、JSONL Session、ChannelAdapter、工具注册/权限和进程生命周期，不建立第二套会话或授权体系。

首期不执行任意脚本，不绑定 Skills，不新增 Telegram 之外的渠道，不让多次 Cron run 共享 Agent 上下文，也不提供 Gateway 停止期间的离线写管理。

## 2. 总体架构

```mermaid
flowchart LR
  IN[Telegram inbound] --> APP[GatewayApp]
  APP --> CMD[/jobs command]
  APP --> LANE[GatewaySessionManager]
  LANE --> AD[NoviAgentAdapter]
  AD --> TOOL[jobs tool]
  CMD --> JS[JobService]
  TOOL --> JS
  JS --> STORE[JobStore]
  STORE --> SCH[GatewayScheduler]
  SCH --> RUN[AutomationAgentRunner]
  RUN --> STORE
  SCH --> DEL[DeliveryService]
  DEL --> CH[ChannelAdapter]
  DEL --> LANE
  LANE --> AD
  AD --> SES[origin JSONL Session]
  HB[HeartbeatSource] --> SCH
```

组件职责：

- `JobStore`：严格解码、原子 job/runtime mutation、per-run 文件、清理和恢复查询。
- `JobService`：route 所有权、schedule/target/model/tool 校验和生命周期操作的唯一业务入口。
- `GatewayScheduler`：单进程 claim、下一次唤醒、并发/预算门控、执行与投递重试、启动恢复和停机排空。
- `AutomationAgentRunner`：创建临时隔离 JSONL Session，装配受限模型/工具/系统提示，聚合 usage，超时/abort/清理。
- `DeliveryService`：按 channel account 找 adapter、重新校验目标、至少一次发送、来源 Session 幂等追加。
- `HeartbeatSource`：读取/解析 `HEARTBEAT.md`、计算 due items、生成内部 heartbeat run。

该能力作为一个集成任务实现。Store、runner、delivery 和 heartbeat 虽可分别测试，但它们共享同一个 run 状态机、恢复协议和配置安全边界；拆成独立 Trellis 子任务会使跨子任务临时契约不可运行，因此本任务不建立 parent/child 树，而在 `implement.md` 中设置阶段性 review gate。

## 3. 持久数据契约

### 3.1 路径

```text
~/.novi/jobs/
├── store.json                         # job definitions + runtime/budget/heartbeat state
├── scheduler.lock                     # one scheduler owner per NOVI_HOME
└── runs/<jobId>/<runId>.json          # one bounded, atomically rewritten run record
```

目录使用 `0700`，文件 best-effort `0600`。`store.json` 和 run 文件都带独立 `version: 1`。缺失表示空状态；非法 JSON、未知版本或非法字段使 Gateway 在 channel 启动前 fail-fast，且不得覆盖原文件。

### 3.2 Job

```ts
type JobStatus = "enabled" | "paused" | "completed" | "cancelled";

type JobSchedule =
  | { kind: "at"; atUtc: string; timezone: string; localLabel?: string }
  | { kind: "cron"; expression: string; timezone: string };

type JobPayload =
  | { kind: "reminder"; text: string }
  | {
      kind: "agent";
      prompt: string;
      model: { provider: string; id: string };
      tools: string[];
    };

type JobDelivery = { kind: "origin" } | { kind: "telegram"; target: GatewaySessionLocator };

interface ScheduledJob {
  id: string;
  name: string;
  owner: GatewaySessionRoute;
  status: JobStatus;
  schedule: JobSchedule;
  payload: JobPayload;
  delivery: JobDelivery;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
  cancelledAt?: string;
  completedAt?: string;
}
```

Job ID 使用 `uuidv7()`。所有读取和 mutation 都先比较 canonical owner route key；调用者知道其他 route 的 ID 也返回 not found，不泄漏存在性。

### 3.3 Run

```ts
type ExecutionStatus = "queued" | "running" | "succeeded" | "failed" | "interrupted" | "skipped";
type DeliveryStatus =
  "not_required" | "pending" | "sending" | "delivered" | "suppressed" | "delivery_failed";

interface ScheduledRun {
  version: 1;
  id: string;
  jobId: string;
  trigger: "scheduled" | "manual" | "recovery" | "heartbeat";
  scheduledFor: string;
  createdAt: string;
  execution: {
    status: ExecutionStatus;
    attempt: number;
    maxAttempts: number;
    startedAt?: string;
    finishedAt?: string;
    session?: JsonlSessionMetadata;
    result?: string;
    resultTruncated?: boolean;
    usage?: UsageSummary;
    error?: BoundedError;
  };
  delivery: {
    status: DeliveryStatus;
    attempt: number;
    maxAttempts: number;
    nextAttemptAt?: string;
    messageIds?: string[];
    deliveryAmbiguous?: boolean;
    possibleDuplicate?: boolean;
    originAppendedAt?: string;
    error?: BoundedError;
  };
}
```

计划触发 run ID 由 `jobId + scheduledFor` 稳定派生；manual run 使用 UUID。稳定 ID 配合 exclusive create，关闭同一 occurrence 的重复 claim。Agent 结果在投递前截断到配置上限（默认 64 KiB UTF-8）并原子持久化；所有重投都复用同一文本。

## 4. JobStore 原子性与恢复

### 4.1 单 owner

`GatewayScheduler.start()` 在启动 channel 前 exclusive-create `scheduler.lock`。活跃 owner 存在时 Gateway fail-fast；PID 已不存在的 stale lock 可删除后重试。正常 stop 关闭 scheduler 后删除 lock。首期明确不支持多个 Gateway 进程共享一个 `$NOVI_HOME` Job Store。

### 4.2 Claim 顺序

计划 occurrence 的 claim 顺序固定为：

1. exclusive-create deterministic run 文件为 `queued`；已存在则复用。
2. 原子更新 `store.json` 中 job 的 `nextRunAt`。
3. 将 run 交给内存 worker queue。

若步骤 1 后崩溃，启动 reconcile 会发现 run 并补做 cursor advance；不会创建第二个 run。若步骤 2 后崩溃，run 已存在，可恢复执行。

### 4.3 启动恢复

- 一次性提醒逾期：创建/恢复唯一 run，结果头标注原计划时间和“延迟提醒”。
- Cron 逾期：启动阶段不创建历史 run，直接用当前时间求下一个未来 occurrence。
- `running`：改为 `interrupted`；若剩余执行 attempt，复用同一 run 重试，否则终止失败。
- `pending`/可重试失败：按 `nextAttemptAt` 恢复投递。
- `sending`：设置 `deliveryAmbiguous=true`、`possibleDuplicate=true` 后重投，提供至少一次语义。
- 临时 automation session 存在：先从 JSONL 聚合尚未入账的 usage，再清理 session，避免崩溃绕过预算账本。

Telegram 无客户端幂等键，严格 exactly-once 不属于契约。执行结果和来源 Session custom entry 可本地幂等；Telegram 渠道可能在响应丢失的崩溃窗口重复。

## 5. 调度与时间语义

新增固定版本依赖 `croner` 10.0.1。只使用 paused evaluator 的 `nextRun(from)` 做验证和下一时间计算，不使用它的内存 callback/timer；`store.json.nextRunAt` 才是事实源。Croner 会把 DST gap 中不存在的墙上时刻向后平移，因此 Novi 必须用 `CronPattern` 复核候选的本地 hour/minute，不匹配时继续取下一 occurrence，才能实现本任务约定的 gap skip。

- 入口预校验恰好 5 字段，拒绝秒/年字段、nickname 和首期未声明的扩展符号。
- day-of-month/day-of-week 使用 Vixie OR 逻辑。
- IANA timezone 在创建时固化；Novi 包装层保证 DST gap skip，Croner 保持 overlap first-once。
- 最短周期默认 5 分钟；创建/更新时计算后续 occurrence 并拒绝小于全局下限的表达式。
- 一次性提醒解析为 UTC 后必须位于未来；启动恢复是唯一允许处理过去 `atUtc` 的路径。
- scheduler 使用可注入 clock/timer，按最近的 `nextRunAt`/delivery retry/heartbeat tick 唤醒，并设置最长轮询上限；不 busy-loop。
- 运行中事件循环延迟只 claim 一个已到期 occurrence，然后从当前时间求下一次；不批量追赶。

## 6. Gateway 配置

`gateway.json` 增加：

```json
{
  "automation": {
    "timezone": "Asia/Shanghai",
    "allowedTools": ["read_file", "ls", "glob", "grep", "web_search", "fetch_content"],
    "minCronIntervalMs": 300000,
    "runTimeoutMs": 120000,
    "maxExecutionRetries": 1,
    "maxDeliveryRetries": 3,
    "maxConcurrentLlmRuns": 2,
    "dailyTokenLimit": 200000,
    "dailyCostUsd": 1,
    "retentionDays": 30,
    "maxRunsPerJob": 100,
    "maxResultBytes": 65536
  },
  "heartbeat": {
    "enabled": false,
    "everyMs": 1800000,
    "model": "provider/model",
    "activeHours": { "start": "09:00", "end": "22:00", "timezone": "Asia/Shanghai" },
    "target": {
      "account": "telegram-main",
      "chatType": "direct",
      "chatId": "123",
      "threadId": "42"
    }
  }
}
```

安全/成本字段以全局层为上界：可信项目层只能收紧数字、缩小 tools、禁用 Heartbeat，不能启用、换模型/目标或放宽预算。显式 `--config` 视为 operator-owned 单层配置。automation/heartbeat 变化需要 Gateway restart，SIGHUP 不热更。

每日账本按 automation timezone 的日历日分桶。每条 assistant `message_end` usage 都累计 tokens/cost；run 前任一预算已达上限则 `skipped`。单次调用可能越过剩余额度，预算不宣称流中硬截断。每天第一次预算 skip 向该 run 的正常投递目标发一次告警。

## 7. 隔离 Agent 执行

扩展 `createHarnessForSession(gatewayEnv, target, options)`，增加明确 profile，而不是复制 bootstrap：

```ts
interface HarnessSessionOptions {
  model?: Model<Api>;
  systemPrompt?: AgentHarnessOptions["systemPrompt"];
  resources?: AgentHarnessResources;
  connectMcp?: boolean;
  registerUserHooks?: boolean;
  additionalToolDescriptors?: readonly ToolDescriptor[];
  activeToolAllowlist?: readonly string[];
}
```

- 普通 Gateway profile：现有资源、MCP、hooks 保持不变，并注入 route-scoped `jobs` descriptor。
- Automation profile：固定 model、专用最小 system prompt、空 Skills/templates、`connectMcp:false`、`registerUserHooks:false`，只激活全局 allowlist ∩ job allowlist ∩ 当前可用 builtin tools。
- `jobs` descriptor 不存在于 automation assembly；不是仅靠 prompt 告诉模型“不要调用”。
- 工具 registry 增加 `state.jobs` capability/session scope，并让 permission canonicalizer 识别 canonical route key。普通 Gateway 中默认 allow，仍可被全局 deny；项目设置不能放宽。
- automation 保留现有 PermissionGate、WorkspaceScopeGuard 和 ToolExecutionRuntime；外部读取若需要交互批准仍 fail-closed。
- runner 订阅全部 assistant `message_end` 聚合 usage，在 `agent_end` 取最终文本；timeout 时 `abort()` 并等待短清理窗口，最后关闭 MCP（通常为空）并删除临时 JSONL。
- 固化 model 必须能从 `gatewayEnv.models` 精确解析且认证可用；否则 run 明确失败，不 fallback。

## 8. 管理入口

### 8.1 `jobs` 工具

工具 closure 只持有当前 route 和 `JobService`，动作包含：

- `create`（`at + reminder` 或 `cron + agent`）
- `list` / `get`
- `pause` / `resume` / `cancel`
- `run`
- `retry_delivery`

schema 接受结构化 ISO/local+timezone/Cron，不解析模糊自然语言。工具结果返回稳定 job/run 摘要；错误通过 throw 进入标准 tool error 流。

### 8.2 `/jobs`

`/jobs [list]`、`/jobs show <jobId>`、`pause|resume|cancel|run <jobId>`、`retry-delivery <runId>` 直接调用同一 `JobService`。CommandRegistry context 注入 service；不复制授权、schedule 或 mutation 逻辑。

`run` 对 enabled/paused job 生成独立 manual run，不改变 pause 状态；cancelled/completed job 拒绝。`resume` 只计算下一未来 occurrence。

## 9. Channel 投递与可继续会话

现有 `send(chatId, text)` 无法表达 topic，统一升级为：

```ts
interface ChannelSendTarget { chatId: string; threadId?: string }
interface ChannelDeliveryReceipt { messageIds: string[] }
send(target: ChannelSendTarget, text: string): Promise<ChannelDeliveryReceipt>;
```

普通 reply/stream/typing/cancel 同样传 target，使现有 Telegram topic 回复也落回正确 thread。Telegram adapter 将 `threadId` 映射为 `message_thread_id`，长文本 receipt 记录所有 chunk message IDs。

DeliveryService：

1. 解析 origin 或显式 locator，按 channel type/account 找已启动 adapter。
2. 创建时和触发时都验证目标：显式目标必须已有 durable Gateway binding，并符合当前 DM/group policy；撤销授权后 fail-closed。
3. 在发送前原子写 `sending`；成功 receipt 后写 `delivered`。首次失败后按指数退避最多重试 3 次（总尝试最多 4 次）。
4. 消息头包含稳定的 job name + short job/run ID。静默只适用于成功的 LLM/Heartbeat 输出；失败通知不静默。
5. 若实际 target 等于 owner route，交给 `GatewaySessionManager.enqueueSystemOperation()` 串行追加来源 custom message。

Session lane queue 扩展为 `message | system-operation` union。AgentProtocolAdapter 增加 `appendScheduledDelivery(route, entry)`；adapter 按 durable binding resume 当前来源 session。追加前读取 branch 查找 `details.runId`，存在则 no-op，解决“append 成功但 run 状态未落盘”的崩溃窗口。custom message 用稳定包装声明这是系统生成、可能含不可信外部数据、不是新用户授权。append 不触发 Agent。

## 10. Heartbeat

路径优先级：可信项目 `<cwd>/.novi/HEARTBEAT.md` 非空时覆盖用户级 `~/.novi/HEARTBEAT.md`。文件支持可选 YAML frontmatter：

```md
---
tasks:
  - name: inbox-triage
    every: 30m
    prompt: Check urgent unread mail.
---

# Additional constraints

- Keep alerts short.
```

- 有 tasks 时仅把到期 task 加入 prompt；无 task 但正文有效时，正文在每个 heartbeat tick 视为一个 due check。
- task state 以 `name + normalized content hash` 持久化 last-success；无 due item、文件缺失或仅空 Markdown 结构时不建 run、不调用模型。
- active hours 在配置 IANA timezone 下检查；窗口外跳过到下一个 tick。
- Heartbeat 复用 AutomationAgentRunner、预算、投递和 retention，但使用内部 synthetic job ID，不向普通会话暴露 `jobs`。
- `HEARTBEAT_OK`、`SILENT`、`[SILENT]`、`NO_REPLY`、`NO REPLY` 视为成功静默；正常成功后才推进 task last-success。
- Cron queue/running 时 Heartbeat 延后；Heartbeat 运行时 scheduler 不启动新的 Cron LLM run。提醒文本投递不占 LLM mutex。

## 11. 清理、停止与观测

- 启动和每 24 小时执行 maintenance：删除超过 30 天的 cancelled/completed job、超过 30 天或每 job 第 100 条之外的 run、孤立空目录和已结算 automation JSONL。
- 清理绝不删除 enabled/paused job；错误、渠道响应和 diagnostics 统一脱敏、单行化、限长。
- `GatewayApp.start()` 顺序为 store/lock/reconcile → channels → scheduler；确保恢复投递时 adapter 已可用。具体实现可在 channels start 后 scheduler dispatch，但 lock/store validation 必须先发生。
- stop 顺序为 scheduler 停止 claim → abort/wait active automation → session manager 排空 → channels stop → agent/env cleanup → release lock。
- `/status` 增加 jobs enabled/paused、queued/running、pending delivery、今日 tokens/cost、heartbeat last status；`--gateway status` 仍为无运行时的静态状态，并明确 scheduler 未连接。
- 运行时 warning 写 stderr；用户可操作错误通过 `/jobs` 或主动失败通知返回，不在深层 store/runner 任意写 stdout。

## 12. 兼容、发布与回滚

- 无已有 `~/.novi/jobs` 时为空 store；Heartbeat 默认关闭，因此升级后没有主动调用或新增费用。
- TUI/headless 不注入 `jobs` descriptor，现有 bootstrap 行为不变。
- Channel send contract 是内部 breaking refactor，必须一次性更新 Gateway 全部 caller/test，不能保留 string/target 双协议。
- 新 job store schema 首期无迁移来源；未知版本 fail-fast。
- 回滚旧版本时停止 Gateway 即停止 scheduler；`~/.novi/jobs` 保留但旧代码忽略。重新升级可继续恢复。

## 13. 关键失败矩阵

| 条件                          | 行为                                            |
| ----------------------------- | ----------------------------------------------- |
| store/run 损坏或版本未知      | channel 启动前 fail-fast，保留文件              |
| 第二个 scheduler owner        | fail-fast，不启动重复调度                       |
| 固化 model 缺失/无认证        | run failed，不 fallback                         |
| 工具超出 automation allowlist | 创建时拒绝；陈旧调用由 gate 拒绝                |
| Cron 启动时已过期             | 不追赶，求下一未来时间                          |
| 一次性提醒启动时已过期        | 唯一 run 立即延迟投递                           |
| 执行中崩溃                    | interrupted，同 run 按剩余额度重试              |
| 结果已生成但投递失败          | 不重跑 Agent，只重投持久结果                    |
| `sending` 时崩溃              | 标记 ambiguous/possibleDuplicate 后至少一次重投 |
| 来源 append 后状态写失败      | 以 branch 中 runId 去重                         |
| 预算达到上限                  | skip 后续 LLM run，每日最多一次告警             |
| Heartbeat 无 due item         | 完全跳过，不创建 run                            |
| 显式 target 被撤销授权        | delivery_failed，不绕过当前 policy              |

## 14. 参考

- OpenClaw Scheduled Tasks: https://docs.openclaw.ai/automation/cron-jobs
- OpenClaw Heartbeat: https://docs.openclaw.ai/gateway/heartbeat
- Hermes Scheduled Tasks: https://hermes-agent.nousresearch.com/docs/user-guide/features/cron
- Croner: https://github.com/Hexagon/croner
- Telegram Bot API `sendMessage`: https://core.telegram.org/bots/api#sendmessage
