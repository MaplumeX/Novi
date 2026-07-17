# 子代理与后台任务竞品研究

## 1. 结论先行

成熟方案通常不把“子代理”和“后台任务”当成同一个原语，而是分成两层：

1. **会话内委派（fork/join）**：子代理拥有独立上下文，立即或并行运行，完成后把摘要回传给父会话。它适合调研、评审、拆分等短期工作，但通常不承诺进程重启后从执行现场继续。
2. **持久任务（durable queue/state machine）**：任务先写入持久化存储，再由 worker 认领；支持重试、人工阻塞、依赖和崩溃回收。它适合真正的后台工作，但恢复语义通常是“从安全边界重跑”，不是恢复任意 LLM/tool 调用的内存现场。

Hermes 把这两层分别称为 `delegate_task` 与 Kanban，边界最清楚；OpenClaw、Codex 和 Claude Code 的子代理主要属于第一层；LangGraph 提供第二层所需的 checkpoint/replay 机制。

对 Novi 最合适的方向不是再造一套 scheduler，而是：

- 新增统一的 **Agent Run** 领域模型和运行管理器，承载 foreground/background 子代理；
- 复用现有 JSONL session、tool assembly、permission gate、usage/artifact 和 Gateway delivery；
- 将现有 scheduled jobs 视为持久任务入口，并逐步抽取共享的 run ledger / delivery 能力；
- 首版不要承诺“透明恢复执行到一半的 Agent”，崩溃后应明确标记 `interrupted`，按策略从头重试或等待人工重跑。

## 2. 产品与框架对比

| 方案 | 核心原语 | 上下文 | 并发与递归 | 后台/重启语义 | 结果回传与控制 | 对 Novi 的启示 |
| --- | --- | --- | --- | --- | --- | --- |
| OpenClaw | `sessions_spawn` + subagent registry | 默认隔离，可显式 fork | 默认深度 1，可配置深度、每父节点 child 数和全局并发 | spawn 非阻塞；完成后 push announce；运行记录可追踪，但普通子代理不等于可恢复工作流 | 父会话负责对外消息；稳定幂等 key；list/kill/steer | 推送完成事件、父会话拥有外部投递、深度化工具限制很成熟 |
| Hermes | `delegate_task` + Kanban | delegate 只拿 goal/context，隔离最强 | 并行 batch 默认最多 3；默认扁平，编排模式显式开启 | delegate 仅进程内继续，崩溃不恢复；完成结果先落 SQLite 再发布；Kanban 可持久认领与回收 | `/agents` 查看树、成本、token、文件，可 kill/pause；Kanban 有状态、评论、阻塞 | 最值得借鉴的是“两种原语，不混淆承诺” |
| Codex | multi-agent orchestration + roles | 子代理独立上下文，只回摘要 | `max_threads` 和 `max_depth`；鼓励读密集并发 | 会话内编排；写密集任务建议 worktree 隔离；不把子代理包装成透明持久工作流 | spawn/follow-up/wait/close；可 inspect/switch/stop/steer | profile、并发上限、父沙箱/批准继承、worktree 写隔离 |
| Claude Code | subagents + background agents / agent view | fresh context 或 fork，结果返回父会话 | 支持嵌套，固定最大深度 5；可通过工具策略禁止下级委派 | foreground/background 均可运行；当前 background 权限请求会显示在主会话；独立 agent view 会话可脱离终端 | 前后台切换、权限提示、日志、停止；写会话可用 worktree | 交互式 TUI 可代理子任务授权，Gateway 无人值守路径仍必须 fail-closed |
| LangGraph | graph/subgraph + checkpointed task | 可按 invocation/thread/stateless 持久化 | 由图和执行器控制 | 每个 superstep checkpoint；恢复是 replay；已开始未完成 task 可能重执行，因此副作用必须幂等 | thread、interrupt、resume、状态历史 | 真正 durable execution 必须建立显式 checkpoint 和幂等边界 |

## 3. OpenClaw

官方文档：

- <https://docs.openclaw.ai/tools/subagents>
- <https://docs.openclaw.ai/concepts/multi-agent>

关键设计：

- `sessions_spawn` 立即返回 run id，不阻塞父 Agent；完成通知是 push，而不是让父 Agent 轮询。
- 每个子代理是独立 session，拥有稳定的父子关系和后台任务记录。
- 完成结果以 runtime-generated internal event 注入父会话，并带稳定幂等键；父 Agent 决定如何向用户表达。
- 子代理不拥有对外 `message` 工具，外部消息所有权留在父会话，避免子代理绕过路由和重复投递。
- 支持 `isolated` 与 `fork` 两类上下文；支持一次性 run 和 thread-bound persistent session。
- 通过 `maxSpawnDepth`、`maxChildrenPerAgent`、全局 `maxConcurrent`、timeout 和 cascade stop 控制 fan-out。
- 按深度裁剪工具：中间编排节点可继续委派，叶子节点没有编排工具；Gateway、cron、消息等高风险工具默认不给子代理。

值得复用：

- 非阻塞 spawn + 推送完成事件；
- 父会话拥有结果投递；
- 父子树、级联取消和按深度工具策略；
- 稳定 completion id，防止恢复或重试时重复注入。

需要警惕：

- 子代理 runtime 记录和“进程崩溃后继续执行”不是一回事；不能因为 session 持久化就宣称执行现场可恢复。
- persistent threaded subagent 会显著增加生命周期、路由和资源回收复杂度，不适合 Novi MVP。

## 4. Hermes Agent

官方文档：

- <https://hermes-agent.nousresearch.com/docs/user-guide/features/delegation>
- <https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban>

### 4.1 `delegate_task`

- 每个子代理使用 fresh isolated conversation、独立 terminal 和受限工具集。
- 父 Agent 只拿到最终摘要，不复制完整对话历史，显著降低上下文污染。
- 支持单任务和并行 batch，默认并发上限为 3。
- 后台完成结果先写 SQLite，再进入 claim/ack 发布流程，因此“已完成但尚未通知”的结果不会轻易丢失。
- 但正在运行的 child 不会在进程崩溃后恢复，只会变成 unknown；官方明确建议真正 durable 的工作使用 Kanban 或其他后台机制。
- `/agents` 提供树形状态、token、成本、文件、历史和 kill/pause 控制。

### 4.2 Kanban

- Kanban 是 SQLite 持久化任务板，named profile 以独立 OS process 充当 worker。
- 支持 `triage → todo → ready → running → blocked → done → archived`，以及评论、依赖、重新运行、人工阻塞和 crash reclaim。
- worker 原子认领任务；dispatcher 回收 stale claim / crashed worker。
- workspace 可以是 scratch、指定目录或 worktree，从根源上处理并发写冲突。

最重要的经验：

- `delegate_task` 是会话内 fork/join RPC；Kanban 是持久队列/状态机。两者共享展示和部分执行设施，但不能共享同一个恢复承诺。
- Novi 的“3 子代理”适合先实现 delegate 模型；“后台任务”若要求跨重启，应接入现有 jobs/run ledger 语义，而不是把一个未完成的 Promise 写成 durable。

## 5. Codex

官方文档：

- <https://learn.chatgpt.com/docs/agent-configuration/subagents.md>

关键设计：

- 主 Agent 负责 spawn、follow-up、wait 和 close；子代理独立执行，只把压缩结果交回主上下文。
- 使用 `default`、`worker`、`explorer` 等 profile，为不同角色配置 model、reasoning、sandbox、MCP 和 Skills。
- `agents.max_threads` 与 `agents.max_depth` 形成全局资源边界，默认递归深度保持保守。
- 子代理继承父 Agent 的 sandbox / approval 约束，不能隐式放宽。
- 官方更推荐并行化读密集任务；写密集任务需要用 worktree 隔离，避免多个 Agent 同时修改同一工作区。

值得复用：

- “三个子代理”应该是最大并发/可用槽位，不应在系统提示词里硬编码成永远启动三个。
- 首版提供少量可解释 profile，比允许模型任意拼装权限更容易治理。
- 对写任务需要显式 workspace 策略：shared-readonly、shared-serialized 或 worktree，不能默认自由并发写。

## 6. Claude Code

官方文档：

- <https://code.claude.com/docs/en/sub-agents>
- <https://code.claude.com/docs/en/agent-view>

关键设计：

- 子代理使用 fresh isolated context，也可显式 fork；只有最终结果回到父上下文。
- foreground 会阻塞父会话；background 与主会话并发运行。当前版本会把 background 子代理的权限请求显示到主会话，并标明请求来源；旧版本才会自动拒绝所有需要询问的操作。
- 当前版本允许嵌套子代理，最大深度固定为 5；也可以通过移除 `Agent` 工具禁止某个 profile 继续委派。
- agent view 管理的是独立后台会话，不完全等价于父子 subagent；写会话自动使用 git worktree。

值得复用：

- Novi Gateway 本来就是非交互权限 gate，后台子代理也应保持 fail-closed；TUI 可以像 Claude Code 一样把权限请求代理到父界面，但必须显示 run/profile 来源。
- TUI 退出或父界面无法接收权限请求时，不得悬挂不可见的批准框；应自动 deny 或将 durable task 转为 `blocked`。
- 首版将递归深度默认设为 1，比直接开放多层 orchestrator 更稳；后续可在可配置限额和 profile 策略下开放更深层级。

## 7. LangGraph

官方文档：

- <https://docs.langchain.com/oss/javascript/langgraph/use-subgraphs>
- <https://docs.langchain.com/oss/javascript/langgraph/persistence>
- <https://docs.langchain.com/oss/javascript/langgraph/functional-api>
- <https://docs.langchain.com/oss/javascript/langgraph/interrupts>

关键设计：

- 图在 superstep 后写 checkpoint，通过 thread id 恢复状态、回放和容错。
- checkpointed task 将副作用/非确定性操作包裹成显式执行单元。
- resume 可能重新执行 node；一个 task 如果已经开始但还没持久化完成，也可能被再次调用，因此外部副作用必须幂等或具备 dedup key。
- interrupt 支持人工介入，但恢复仍从确定的节点边界继续，而不是恢复 JavaScript 调用栈。

对 Novi 的边界提醒：

- 若未来要宣称“后台 Agent 跨重启从中断处继续”，必须把 Agent loop 拆成可持久化 step，并为 bash、write、MCP 调用定义重放/幂等合同。
- Novi 当前的 JSONL session 可以恢复对话历史，但不足以证明最后一个 tool call 是否执行成功；MVP 应沿用 scheduled jobs 的保守语义：`running → interrupted → retry/fail`。

## 8. Novi 现状映射

| 成熟能力 | Novi 现有基础 | 差距 |
| --- | --- | --- |
| 独立子会话 | `createHarnessForSession()` + JSONL session repo | 缺少 parent/run metadata、注册与回收 |
| 会话内串行与控制 | `GatewaySessionManager` / `SessionLane` / steer/follow-up/interrupt | 只管理 route 主会话，没有 child lane/tree |
| 受限工具与权限 | unified tool assembly、permission gate、workspace scope、budget | 缺少 parent→child 收紧规则、profile、后台权限冻结 |
| 无人值守 Agent | `AutomationAgentRunner` 已禁 MCP/Skills/hooks，并使用工具 allowlist | 只能由 schedule 触发，不能立即 spawn；模型固定在 job payload |
| 持久 run ledger | `ScheduledRun` + 原子 JSON store | 结构绑定 scheduled job，尚无通用 AgentRun / parentRunId |
| 崩溃恢复 | scheduler 将 `running` 改成 `interrupted`，按 attempt 重试 | 语义成熟但当前 scheduler 串行扫描，不适合直接承载交互式 child fan-out |
| 可靠投递 | execution / delivery 分离，sending 恢复为 ambiguous，并向 origin session 幂等追加 | 需要推广为 subagent completion delivery，而不是复制一套消息逻辑 |
| 预算 | tool execution budget + automation 日 token/cost 限额 | 缺少每父会话、每棵子代理树、每 run 的 token/cost/time 限额 |
| 可观测性 | Gateway snapshot、metrics、control socket、tool events | 缺少 run list/tree/status/log/cancel 和 TUI/Headless 事件协议 |
| 并发写隔离 | workspace scope guard | scope 只是边界，不解决多个 Agent 写同一文件；需要 readonly/serialized/worktree 策略 |

## 9. 建议的成熟度分层

### MVP：立即委派 + 进程内后台运行

- 自动化测试至少覆盖 3 个子代理并行执行；默认全局并发 8、单父会话最多 5 个活动子代理，超额排队，所有限额可配置。
- 默认 depth=1；独立上下文；父 Agent 传入 task 与最小 context。
- `spawn` 非阻塞，返回 run id；`list/get/cancel` 可控；完成结果持久化后推送回父会话。
- 子代理只能使用预定义 profile，权限只能继承后收紧；后台 ask 自动 deny。
- 进程退出时，活动 run 标记 `interrupted`；不透明续跑。

### 第二阶段：durable queued task

- 引入可立即触发的持久任务 definition，复用 scheduled run ledger、重试、delivery、预算和 recovery。
- 任务可以 queued/claim/retry，重启后从头执行；要求工具副作用带幂等策略。
- 支持 blocked / awaiting-human、优先级和 worker concurrency。

### 后续：checkpointed workflow

- 只有在明确需求出现后，才引入 step checkpoint、dependency graph、worktree worker、persistent child thread 或 depth=2 orchestrator。
- 对每种工具定义 replay 安全性后，才能承诺更细粒度的恢复。

## 10. 失败模式清单

- 把 session 可恢复误写成 execution 可恢复，导致工具副作用重复。
- 子代理直接向外部 channel 发消息，造成路由越权和重复通知。
- 允许模型任意指定工具、MCP、cwd 或权限，形成 privilege escalation。
- background run 等待交互授权，永远挂起。
- 没有父树级并发/预算，递归 spawn 造成 token 爆炸。
- 多个写 Agent 共用工作目录，结果相互覆盖。
- 父会话 reset/删除后 completion 无归属，形成 orphan。
- 先推送结果、后持久化状态，崩溃窗口导致结果丢失或重复。
- 将 scheduled jobs 与 subagent runs 各自实现重试、投递和观测，长期出现两套不一致的状态机。
