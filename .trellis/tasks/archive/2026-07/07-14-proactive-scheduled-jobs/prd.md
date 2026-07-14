# Novi 主动任务与提醒闭环

## Goal

让 Novi 从“仅在收到用户消息后运行”的被动 Agent，具备可持久化、可恢复、可治理的最小主动执行闭环：用户可以创建提醒或周期任务，Gateway 能在后台按时执行，并将结果安全地投递回目标会话或渠道。

## Background

- 当前问题陈述认为 Novi 的主循环是“用户发消息 → Agent 执行 → 回复 → 等待下一条消息”，尚无完整的主动唤醒能力。
- OpenClaw 的 Cron、Heartbeat，以及 Hermes 的 Scheduled Tasks 是产品能力参考；具体语义仍需结合 Novi 现有架构验证，不能直接照搬。
- 这是一个跨持久化、调度、Agent 运行时、会话/渠道投递和权限治理的复杂功能，规划完成前不进入实现。

## Technical Notes

- Novi 当前没有数据库，运行状态采用 `$NOVI_HOME`/`~/.novi` 下的文件持久化；Gateway session store 已采用严格 schema、串行 mutation、同目录临时文件加原子 rename 的提交方式（`src/gateway/core/session-store.ts:31-37,49-72,146-171`）。
- Gateway 启动时只准备一次共享环境，然后创建 channels、`NoviAgentAdapter`、session manager 和 app；SIGINT/SIGTERM 已有统一停机入口，适合在同一生命周期内挂载 scheduler（`src/gateway/run.ts:129-175,202-220`）。
- 渠道会话已有稳定的 `channel/account/chat/thread` locator，可作为任务来源与默认投递目标，而无需从非结构化 session key 反推路由（`src/gateway/core/types.ts:57-75`）。
- Agent adapter 已支持创建/恢复 JSONL session、执行 turn、abort 和资源回收；普通 Gateway 会话是有上下文的持久会话（`src/gateway/agent/novi-agent-adapter.ts:51-138,181-210`）。
- Channel contract 已有最终文本投递接口，当前实际渠道只有 Telegram；Telegram `send()` 已处理消息长度切片和瞬态发送重试（`src/gateway/core/types.ts:91-112`，`src/gateway/channels/telegram.ts:84-129`）。
- Gateway 是非交互运行面：现有权限模型会将需要交互批准的工具调用 fail-closed；Gateway session grants 仅存活于进程内，不能被重启后的无人值守任务继承（`.trellis/spec/backend/tool-runtime-contracts.md`）。
- OpenClaw 将 scheduler 放在 Gateway 中，持久化 job/runtime/run history，并为每次执行建立 background task；它区分直接 system event、LLM agent turn 和无 LLM command payload，且支持显式模型、工具、超时和投递策略。
- OpenClaw Heartbeat 是完整 Agent turn；它通过 active hours、空任务跳过、OK 静默、隔离轻量上下文、低成本模型和超时来控制噪音与成本。
- Hermes 默认让 Cron 在新 Agent session 中执行，支持一次性/周期任务、生命周期管理、Skills、来源或指定渠道投递，以及无 LLM 脚本任务；Cron 执行期间禁用 Cron 管理工具以阻止递归调度。

## Requirements

- 提供持久化 Job Store，任务在 Gateway 进程重启后仍可恢复。
- 支持无需 LLM 的一次性文本提醒，以及在隔离新会话中运行的 LLM Cron 周期任务。
- 明确定义重启、停机或调度延迟造成的错过任务策略。
- 支持任务状态查询、暂停、恢复、取消、立即触发、失败重试和执行超时，并保留有界运行记录。
- 支持将执行结果投递回任务来源 Telegram 会话，或投递到显式指定的 Telegram chat/thread。
- 提供可配置的低频 Heartbeat，支持静默结果、活跃时段和成本限制，使非精确时刻的主动工作无需创建大量独立定时任务。
- 对无人值守执行设置权限边界、可用模型和成本上限。
- Cron/Heartbeat 隔离执行环境不得暴露创建或修改定时任务的能力，并需防止通知回流或其他形式的执行循环。
- 保持现有被动消息处理路径兼容，不因主动任务功能改变普通会话的既有行为。

### User-facing Management

- 普通 Gateway 会话必须暴露模型可调用的 `jobs` 工具，支持用自然语言创建和管理任务。
- Gateway 必须提供不调用 LLM 的 `/jobs` slash command，用于列表、详情、暂停、恢复、取消和立即运行；模型不可用时仍可管理已有任务。
- `jobs` 工具只在普通用户驱动的 Gateway 会话中可见；Cron/Heartbeat 隔离执行环境不得注册该工具。
- 首期不增加独立 `novi jobs ...` CLI，也不支持 Gateway 停止期间离线修改 Job Store，避免跨进程双写竞争。

### Heartbeat Scope

- 首期每个 Gateway 实例最多运行一个 Heartbeat；不按 Telegram 会话复制，也不引入多 Agent 身份模型。
- `gateway.json` 的 `heartbeat` 区块配置启停、间隔、活跃时段、模型、超时、预算和明确的 Telegram 投递目标。
- Heartbeat 指令默认读取用户级 `~/.novi/HEARTBEAT.md`；可信项目可用 `<cwd>/.novi/HEARTBEAT.md` 覆盖。
- Heartbeat 每次使用隔离新会话和精简上下文；指令文件缺失、有效内容为空或没有到期检查项时跳过且不调用模型。
- 无需通知时必须返回稳定静默标记并抑制渠道投递。
- 首期 Heartbeat 只能通过配置文件启停，不允许普通对话动态创建多个 Heartbeat。

### Unattended Runtime Policy

- 创建 LLM Cron 时必须固化当时解析出的 `provider/model`；模型不存在、不再允许或无法认证时 fail-closed，不静默切换模型或启用 fallback。
- Heartbeat 必须在 `gateway.json` 中显式配置模型。
- 无人值守 Agent 默认只允许 `read_file`、`ls`、`glob`、`grep`、`web_search`、`fetch_content`；`bash`、文件写入、MCP、`todo` 和 `jobs` 默认禁止。
- 单个任务的工具 allowlist 只能是全局无人值守 allowlist 与当前 Gateway active tools 的交集，任务不得扩大权限。
- 单次 Agent run 默认超时 120 秒，失败后最多自动重试 1 次。
- 后台 LLM run 最多并发 2 个；Heartbeat 与 Cron 不得并发执行。
- Cron 最短周期默认 5 分钟。
- Gateway 每日默认预算为 200,000 tokens 或 1 USD，任一达到后跳过当日后续 LLM run，并且每天最多投递一次预算告警。
- token/cost 从模型 usage 事件持久累计；预算在 run 开始前检查并阻止后续 run，不承诺在单次流式模型调用途中精确截断。
- 上述默认值可在全局 `gateway.json` 中配置，但普通对话创建的任务不能突破全局上限。

### Schedule and Timezone Semantics

- 周期任务只接受标准 5 字段 Cron，精度到分钟；首期不支持秒级 Cron 或固定间隔表达式。
- 每个 Cron job 创建时固化一个 IANA 时区，不随 Gateway 主机时区变化。
- 未显式指定时区时使用 `gateway.json` 的 `automation.timezone`；若未配置，则解析主机 IANA 时区并固化到 job。
- 一次性提醒持久化为 UTC 绝对时间；`jobs` 工具只接受带偏移的 ISO 时间，或“本地日期时间 + IANA 时区”的结构化输入。
- 模糊自然语言时间由模型结合 Gateway 当前日期与默认时区转换；Job Store 和 scheduler 不解析自然语言。
- 夏令时导致的缺失本地时刻不补跑；重复本地时刻只运行一次。
- `/jobs` 展示任务时区及对应的绝对时间。

### Ownership and Authorization

- Job 由创建它的 `channel/account/chat/thread` route 所有；私聊中等同于个人所有，群聊/topic 中由同一 route 的已授权参与者共同管理。
- `/jobs` 和普通会话中的 `jobs` 工具只能列出、查询或修改当前 route 所有的任务；Job ID 不得绕过 route 校验。
- 显式投递到其他 Telegram chat/thread 不改变 job 的来源 route 与所有权。
- 首期不提供跨 route 的全局管理员任务视图，也不为群聊任务引入发送者级私有所有权。

### Continuable Origin Delivery

- 成功投递到 job 来源 route 后，必须通过 pi-agent-core 的公开 Session API 追加一条带 job/run 标识的 custom message，使用户后续回复可以引用刚完成的定时结果。
- custom message 必须明确标记为系统生成的定时任务输出及潜在不可信外部内容，不能被解释为新的用户授权。
- 只有来源 route 写入上下文；显式指定的其他 Telegram 目标只接收消息，不修改目标会话。
- Session 追加必须通过来源 route 的 session lane 串行化，避免与普通对话并发写 JSONL。
- 渠道投递和 Session 追加都不得进入 inbound pipeline、触发 Agent turn 或调用 `jobs`；同一 run 只能成功追加一次。

### Recovery and Missed-Run Policy

- Gateway 启动或恢复调度时，逾期的一次性提醒立即执行一次；投递内容必须标注为延迟提醒并包含原计划时间。
- 周期 Cron 不追赶 Gateway 离线期间的历史触发次数，只从当前时间计算下一个未来触发点。
- 暂停后恢复的周期任务同样只计算下一个未来触发点，不补跑暂停期间的触发。
- Gateway 崩溃时处于执行中的 run 在恢复后标记为 `interrupted`，仅在任务仍有重试额度时重试一次。
- 恢复执行必须使用持久化 run identity；同一计划 occurrence 不得创建第二个 run，执行重试只能增加原 run 的 attempt；来源 Session 追加必须本地幂等。

### Execution and Delivery Outcomes

- 每个 run 的执行状态与投递状态必须独立持久化；成功生成结果后，投递失败不得重新执行 LLM 或任务负载。
- Telegram 首次投递失败后最多自动重试 3 次（总尝试最多 4 次）并采用指数退避；Gateway 重启后继续尚未完成或停留在 `sending` 的投递。
- Telegram Bot API 不提供客户端幂等键，因此渠道语义为至少一次：若 Gateway 在 Telegram 已接收消息但本地尚未记录成功的窗口内崩溃，恢复重试可能产生重复消息。
- 每条主动消息必须携带简短稳定的 job/run 标识；从不确定的 `sending` 状态恢复时，run 记录 `deliveryAmbiguous`/`possibleDuplicate` 供 `/jobs` 展示。
- 自动重试耗尽后，run 标记为 `delivery_failed`，保留生成结果与最后错误，并支持 `/jobs retry-delivery <runId>` 手动重投。
- 单次投递失败不暂停周期任务，后续周期仍按既定计划运行。
- 一次性提醒仅在投递成功后进入完成态；重试耗尽后保留失败记录，不自动删除。

### Retention and Cleanup

- 启用或暂停的 job 定义长期保留，直到用户取消。
- 已取消 job 和已成功完成的一次性提醒保留 30 天后清理。
- 每个 job 的 run history 最多保留 100 条且最长保留 30 天；任一边界命中即清理最旧记录，所有终态使用相同规则。
- 每个 run 持久化并投递的最终结果最多 64 KiB UTF-8；超出后截断并添加稳定标记，确保重启重投使用同一份有界结果。
- 错误文本、诊断和渠道响应必须脱敏并限制长度。
- Gateway 启动和每日低频维护执行清理，不调用模型；已清理的 run 不再支持手动重投。

## Acceptance Criteria

- [ ] 一次性提醒可持久化、按时触发一次，并向目标会话或渠道投递可观察结果。
- [ ] 合法 Cron 表达式可创建周期任务；任务可查询、暂停、恢复、取消和立即触发。
- [ ] Cron 任务跨 Gateway 重启和主机时区变化仍按创建时固化的 IANA 时区运行；DST 缺失/重复时刻符合既定语义。
- [ ] 一次性提醒拒绝无法消歧的时间输入，并以 UTC 绝对时间持久化。
- [ ] 用户可通过普通自然语言对话创建/管理任务，也可通过 `/jobs` 在不调用模型的情况下完成全部生命周期操作。
- [ ] 当前 route 无法通过列表、详情或已知 Job ID 读取/修改其他 route 的任务；群聊同一 route 内已授权参与者共享任务管理权。
- [ ] Cron/Heartbeat 运行时的工具目录中不存在 `jobs`，即使 prompt 明确要求也无法创建或修改任务。
- [ ] Gateway 重启后，未完成任务可以恢复；错过任务按明确且经过测试的策略处理。
- [ ] 一次性提醒在离线错过后只补发一次且标注延迟；周期任务不回放离线或暂停期间的历史触发。
- [ ] 崩溃时的执行被记录为 `interrupted`，仅按剩余额度重试一次，且不会为同一计划 occurrence 创建第二个 run。
- [ ] Telegram 暂时失败只重试同一 run 的已生成结果，不再次调用模型；重启后可以继续投递。
- [ ] `sending` 崩溃恢复遵循至少一次语义，消息包含稳定 job/run 标识，可能重复会在 run 状态中可观察；系统不宣称 Telegram exactly-once。
- [ ] 自动投递重试耗尽后可按 run 手动重投，且不会影响周期任务的下一次调度。
- [ ] 来源 route 收到结果后可在下一条普通消息中继续讨论该结果；额外投递目标不会被写入上下文。
- [ ] 同一 run 即使经历重启或手动重投，也最多向来源 session 追加一次，且追加本身不会触发 Agent 或新任务。
- [ ] 执行中的任务具有可观察状态，并受重试次数和超时限制。
- [ ] 无人值守的 Agent 任务只能使用允许的工具/权限与模型，并受单次及周期成本预算约束。
- [ ] 固化模型失效时任务明确失败且不 fallback；任务无法请求到全局无人值守 allowlist 之外的工具。
- [ ] 达到每日 token 或 USD 上限后不再启动新的 LLM run，预算告警每天最多发送一次；新的一天可恢复调度。
- [ ] 系统能识别并阻止至少包括“Cron 执行创建新 Cron”和“任务结果再次触发同一任务”的循环路径。
- [ ] Heartbeat/低频检查不会在无工作时产生无界模型调用或通知噪音。
- [ ] 单个 Gateway 最多运行一个 Heartbeat；空指令/无到期项不调用模型，静默结果不投递，活跃时段外不执行。
- [ ] Job/run/output 清理符合 30 天、每 job 100 条和每 run 64 KiB 上限，清理过程不调用模型且不会删除仍启用或暂停的 job。
- [ ] 关键调度、恢复、幂等、投递和安全策略均有自动化测试。

## Out of Scope

- Cron 绑定一个或多个 Skills。
- 执行用户提供的任意脚本或 shell command 的无 Agent 任务；首期的无 LLM 能力仅限系统内建的文本提醒投递。
- Telegram 以外的主动投递渠道；数据模型与 channel contract 应保持可扩展，但不在首期实现新的 channel adapter。
- 跨多次 Cron 运行共享 Agent 上下文；每次 LLM Cron 和 Heartbeat 都使用隔离的新会话。

## References

- OpenClaw Scheduled Tasks: https://docs.openclaw.ai/automation/cron-jobs
- OpenClaw Heartbeat: https://docs.openclaw.ai/gateway/heartbeat
- Hermes Scheduled Tasks: https://hermes-agent.nousresearch.com/docs/user-guide/features/cron
