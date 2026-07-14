# 修复 Gateway 会话连续性

## Goal

让 Gateway 的外部会话在进程重启和运行时缓存淘汰后仍恢复到原有 Novi 会话，并为显式 `/new`、旧会话归档以及未来跨渠道身份绑定建立安全、可测试的生命周期语义。

## Background

- `createHarnessForSession()` 当前接收但不使用 Gateway `sessionKey`，每次都调用 `repo.create()`（`src/bootstrap.ts:460-478`）。
- `NoviAgentAdapter` 只在进程内保存 `sessionKey -> SessionEntry`（`src/gateway/agent/novi-agent-adapter.ts:17-60`）。Gateway 重启或 adapter cache 被清除后，旧 JSONL 仍在磁盘，但新消息会创建新会话。
- idle/max-concurrent 淘汰会关闭 adapter session 并删除内存 entry，不删除 JSONL（`src/gateway/core/session-manager.ts:107-137`，`src/gateway/agent/novi-agent-adapter.ts:120-143`）。
- 当前 `/new` 仅关闭内存 session；下一条消息才无条件新建 JSONL，且没有持久指针切换或归档记录（`src/gateway/core/commands.ts:49-58`，`src/gateway/agent/novi-agent-adapter.ts:115-118`）。
- 现有 route key 已包含渠道实例、chat type、chat id 和可选 thread，但仍是非结构化字符串（`src/gateway/core/routing.ts:3-5`）。渠道配置 `id` 是稳定实例 ID，Telegram 入口可提供 chat、sender 和 thread 标识（`src/gateway/config.ts:10-18`，`src/gateway/channels/telegram.ts:165-204`）。
- slash 命令绕过 lane，入站回调彼此异步，因此 `/new` 与正在运行/同时到达的消息需要显式串行化（`src/gateway/core/gateway-app.ts:46-52,115-129`）。
- TODO 以 `sessionId` 持久分桶；恢复相同 session 会自然恢复 TODO（`src/tools/todo.ts:24-36,88-104`）。

## Requirements

### R1. 结构化外部定位符

- 以 `channel/account/chat/thread` 表达 Gateway 会话位置：channel 为渠道类型，account 为配置中的渠道实例 ID，chat 包含类型与原生 ID，thread 可选。
- 所有 Gateway 层共享同一个规范 locator/route contract，不在各层重复拼接或解析 key。

### R2. 持久绑定与恢复

- 持久保存外部 locator 到当前 Novi `sessionId`/JSONL metadata 的绑定。
- Gateway 冷启动和运行时 cache 淘汰后，同一 locator 必须打开原 JSONL，而不是创建新会话。
- idle/max-concurrent 淘汰只释放 lane、harness、MCP 等运行时资源，不修改持久绑定。

### R3. 首次创建与并发

- 未绑定 locator 的第一条普通消息创建 JSONL，并在开始 turn 前持久化 binding。
- 同一 locator 的并发初始化只能产生一个有效绑定和一个有效 Novi session，不得分叉或覆盖。
- 新 session 创建成功但 binding 写入失败时，不得发布该 session 为当前会话。

### R4. `/new` 生命周期

- `/new` 是显式破坏性命令。若旧 turn 正在运行，必须中止旧 turn、使其迟到输出失效，并丢弃 reset 开始前仍属于旧 session 的排队消息。
- reset 开始后到达的普通消息应等待切换完成，并进入新 session。
- 只有新 JSONL 创建及持久 binding 切换均成功后才回复成功。
- binding 切换必须在同一次持久事务中把旧 locator/session 关系追加为归档记录，包含旧 metadata、归档时间和 `new` 原因。
- `/new` 不移动、改写或删除旧 JSONL/TODO。

### R5. 悬空或损坏的会话目标

- binding 存在但目标 JSONL 缺失、损坏、无法打开或 metadata 不一致时，普通消息必须失败并提示修复文件或显式 `/new`。
- 不得静默创建新 session、覆盖原 binding 或把数据损坏伪装为正常的新对话。
- 显式 `/new` 可放弃坏目标、归档旧 binding 并切换到新 session。

### R6. 映射存储完整性

- 映射文件缺失视为合法空存储。
- 已存在文件若 JSON 损坏、结构非法或版本不受支持，Gateway 必须在渠道启动前 fail-fast，报告文件路径并保留原文件不动。
- 持久更新必须防止部分写；写失败时磁盘 binding、archive 和内存快照均保持旧状态。

### R7. 归档与未来跨渠道边界

- 持久模型允许多个 locator 显式指向同一 session metadata，为未来身份绑定保留扩展边界。
- 本任务不提供创建这种关系的用户入口，也不定义多 locator 同时驱动同一 session 的运行时并发或联动 `/new` 语义。
- 归档只保存 binding 历史；本任务不提供归档列表、恢复、删除或清理 UI。

### R8. 兼容性

- TUI/headless 的新建、`--resume`/`/resume`、tools、hooks、permissions、MCP 和 TODO 行为保持兼容。
- 继续通过公开 `JsonlSessionRepo`/`Session` API 操作 JSONL，不直接读写正文（`.trellis/spec/backend/database-guidelines.md:22-41,206-211`）。

## Acceptance Criteria

- [x] AC1（R1/R2）：Gateway 重启前后，同一 Telegram chat/thread 解析到相同 `sessionId`，历史上下文与 TODO 均可继续使用。
- [x] AC2（R2）：idle 或 max-concurrent 淘汰后再次发消息，恢复原 `sessionId`，持久 binding 未改变。
- [x] AC3（R3）：同一 locator 的并发首次初始化只创建并绑定一个有效 Novi session。
- [x] AC4（R4）：运行中 `/new` 中止旧 turn、抑制旧输出、清空旧队列；reset 后到达的消息进入新 session。
- [x] AC5（R4）：`/new` 成功后 binding 指向新 `sessionId`，旧 locator/session 关系可从 archive 追溯，旧 JSONL/TODO 保持原位。
- [x] AC6（R3/R4/R6）：session 创建或 store 写入失败时不报告成功、不发布半完成 binding，并可继续从旧 binding 恢复。
- [x] AC7（R5）：binding 目标不可恢复时，普通消息返回明确错误且 binding 不变；显式 `/new` 可以替换坏 binding。
- [x] AC8（R6）：映射文件损坏、非法或版本未知时 Gateway fail-fast；原文件不被覆盖，诊断包含实际路径。
- [x] AC9（R8）：现有 Gateway、bootstrap 和会话相关测试保持通过，并新增覆盖 store、冷恢复、淘汰、并发初始化和 `/new` 事务的自动化测试。

## Out of Scope

- 引入 SQLite/ORM 或迁移 JSONL 会话正文。
- 迁移、猜测或自动认领本功能上线前创建的 Gateway JSONL；当前尚无用户。
- `/link`、绑定码、账号合并、解绑、冲突认领或其他跨渠道身份产品流程。
- 把 CLI 改造成 Gateway `ChannelAdapter`。
- 归档浏览、恢复、删除、保留期限或自动清理。
