# Novi agent hook mechanism

## Goal

为 Novi agent harness 引入一套**面向用户/项目可配置的 hook 机制**，让用户能在 agent 生命周期的关键节点（turn 开始前、工具调用前后、compaction 前）注册自定义处理逻辑，并能对流程施加影响（拦截/改写/取消）。

## Background（已确认事实）

来自代码库调研：

- **底层 core 已有 hook 派发实现**：`@earendil-works/pi-agent-core` 的 `AgentHarness` 内部有 `emitHook(event)` 派发路径，事件类型见 `types.d.ts` 的 `AgentHarnessEventResultMap`：
  - `before_agent_start` → `BeforeAgentStartResult`（可改 messages / systemPrompt）
  - `context` → `ContextResult`（可改 messages）
  - `before_provider_request` → `BeforeProviderRequestResult`（可 patch streamOptions）
  - `before_provider_payload` → `BeforeProviderPayloadResult`（可改 payload）
  - `after_provider_response` → undefined（只读）
  - `tool_call` → `ToolCallResult`（可 block + reason）
  - `tool_result` → `ToolResultPatch`（可改写 content/details/isError/terminate）
  - `session_before_compact` → `SessionBeforeCompactResult`（可 cancel / 提供 compaction）
  - `session_compact` → undefined
  - `session_before_tree` → `SessionBeforeTreeResult`（可 cancel / 改 summary）
  - `session_tree` → undefined
  - 其余 `model_update` / `thinking_level_update` / `resources_update` / `tools_update` / `queue_update` / `save_point` / `abort` / `settled` → undefined（只读通知）
- **core 有公开的注册方法 `on(type, handler)`**（`agent-harness.js:929`），但**未在 `.d.ts` 中声明**——TS 层面调用需要类型断言（`(harness as any).on(...)` 或扩展类型声明）。`subscribe(listener)` 则是公开声明的单向监听（不能返回 result）。
- `emitHook` 语义：顺序执行所有注册 handler，**最后一个返回非 undefined 的 result 胜出**（`agent-harness.js:178-194`）。
- core 派发给 hook handler 的事件字段（camelCase）：`tool_call`({toolCallId, toolName, input})、`tool_result`({toolCallId, toolName, input, content, details, isError})、`before_agent_start`({prompt, images, systemPrompt, resources})、`session_before_compact`({preparation, signal})（`agent-harness.js:344-365, 476-482, 625`）。
- **Novi 当前完全没有使用 `on()`**：`grep "\.on(" src/` 只命中 `child.on("error"/"exit")`（external-editor 子进程事件），没有任何 harness hook 注册。
- **Novi 的事件消费全是 `subscribe`**：`src/tui/useHarnessState.ts:147`、`src/headless/run.ts:47,89`。
- **注释引用 hook 语义的地方**：`src/compaction.ts:65`、`src/tui/useHarnessState.ts:254`、`src/headless/events.ts:180-184`（把 `session_before_compact`/`session_before_tree` 投影成 `_raw: "hook"`，仅分类标记）。
- **`AgentHarnessOptions` 不含 `handlers` 字段**：构造时不传 handlers，handlers 是 harness 私有成员，只能通过 `on()` / `subscribe()` 运行时注册。
- **Novi 现有"从磁盘加载 + 注册到 harness"的模式**：skills / prompt templates / custom models 都走 `loadX(env, cwd, {includeProject: trusted})` → 在 bootstrap 装配 + `replayHarnessState` 在 harness 重建时重放。hook 复用这一模式。
- **settings 结构**：`NoviSettings`（`src/settings.ts`）目前无 hook 配置项；`loadSettings` 读 `~/.novi/settings.json` + `<cwd>/.novi/settings.json`，project 层受 trust gate。
- **harness 重建**：`/reload` / `/new` / `/resume` 都重建整个 `AgentHarness`（`harness-handle.ts`），`replayHarnessState` 用 public getter 重放 tools/model/thinking/stream/queue/resources；hook 注册需要在 `replayHarnessState` 中重新注册（handler 闭包绑定具体 harness 实例，无法跨实例 carry over）。
- `.claude/hooks/*.py` 是 Claude Code 平台的 hook，与 Novi harness 无关。

## Requirements

### R1 配置形态与加载

- 在 `~/.novi/hooks/hooks.json`（用户层）和 `<cwd>/.novi/hooks/hooks.json`（项目层）以 manifest 声明 hook。
- 项目层受 trust gate：未信任时跳过项目层 manifest，只加载用户层（复用 `loadX(env, cwd, {includeProject: trusted})` 模式）。
- manifest schema（仿 Claude Code）：`{ hooks: { <event>: [{ matcher?: string, hooks: [{ command: string, args?: string[], timeoutMs?: number }] }] } }`。
- 两层 manifest 合并：同事件名的 matcher 组追加（user 在前，project 在后），不互相覆盖。
- manifest 解析错误（非法 JSON、未知事件名、schema 不符）→ diagnostic 警告，不阻塞启动。

### R2 触发范围

- MVP 暴露 4 个事件：`before_agent_start`、`tool_call`、`tool_result`、`session_before_compact`。
- 用"已支持事件"配置表（非硬编码 if-else），预留扩展到第二档（`before_provider_request`/`before_provider_payload`/`after_provider_response`/`session_before_tree`/`context`）的能力。
- 第三档纯通知事件（`settled`/`abort`/`model_update` 等）不派发给用户脚本；即使 manifest 声明了也不派发（未知事件名在加载时即被 diagnostic 拒绝）。
- `matcher` 字段：对 `tool_call`/`tool_result` 按工具名过滤（精确匹配或 `|` 分隔多选，仿 Claude Code exact-match 语法）；其他事件忽略 matcher。

### R3 IPC 协议

- **stdin**：事件 JSON，snake_case 字段，含 `session_id`/`cwd`/`hook_event_name` + 事件特定字段（映射 core 事件对象）。
- **stdout**：`{ "result": { <core result fields> } }`，result 字段映射 core 的 `AgentHarnessEventResultMap`（snake_case ↔ camelCase 转换由 Novi 完成）。
- 空 stdout + exit 0 = no-op。非空 stdout 必须是合法 JSON；解析失败 → stderr 警告 + no-op（不崩溃 harness）。
- **超时**：默认 10s，manifest `timeoutMs` 可覆盖。超时 → SIGTERM → 500ms grace → SIGKILL，结果视为 no-op + stderr 警告。
- **退出码**：exit 0 = 正常（读 stdout）；exit 2 = 阻断错误（`tool_call` 自动生成 `{ block: true, reason: <stderr> }`，其他事件 warn + no-op）；其他非 0 = 脚本失败（warn + no-op）。进程隔离，脚本崩溃不影响 harness。
- 多脚本对同一事件：按 manifest 顺序执行，每个脚本返回的 result 按 core `emitHook` 语义合并（最后一个非 undefined 胜出）。

### R4 注册时机与 harness 重建重放

- bootstrap 时 `loadHooks(env, cwd, {includeProject: trusted})` 加载 manifest → `registerHooks(harness, hookConfig, {env, cwd, sessionId})` 对每个已支持事件调 `harness.on(type, dispatcher)`。
- `replayHarnessState` 在 `/reload`、`/new`、`/resume` 重建 harness 时重新 `loadHooks` + `registerHooks`（trusted 用 old handle 的，与 `loadResources` 一致）。
- dispatcher 闭包是懒 spawn 的：脚本只在事件匹配时才执行，无事件不启动进程。
- hook 加载的 diagnostics 随 `replayHarnessState` 返回值上报（与 resource diagnostics 同通道）。

### R5 类型安全

- core 的 `on(type, handler)` 未在 `.d.ts` 声明，Novi 通过本地类型扩展或类型断言访问，封装在 `src/hooks/registry.ts` 内部，不泄漏到外部调用方。

## Acceptance Criteria

- [ ] `~/.novi/hooks/hooks.json` 存在时，其声明的脚本在对应事件触发时被执行（stdin 收到事件 JSON）。
- [ ] `<cwd>/.novi/hooks/hooks.json` 在 trusted 时加载，untrusted 时跳过。
- [ ] `tool_call` 脚本返回 `{ "result": { "block": true, "reason": "..." } }` 时，工具调用被阻断且 reason 传给模型。
- [ ] `tool_result` 脚本返回 `{ "result": { "content": [...], "is_error": true } }` 时，工具结果被改写。
- [ ] `before_agent_start` 脚本返回 `{ "result": { "messages": [...] } }` 时，messages 被注入。
- [ ] `session_before_compact` 脚本返回 `{ "result": { "cancel": true } }` 时，compaction 被取消。
- [ ] 脚本超时（超过 10s 或 manifest 配置的 `timeoutMs`）→ 进程被杀，harness 继续正常运行，stderr 有警告。
- [ ] 脚本 exit 2 + `tool_call` 事件 → 自动 block + reason。
- [ ] 脚本崩溃/非 0 退出（非 2）→ harness 不受影响，stderr 警告。
- [ ] manifest 非法 JSON / 未知事件名 → diagnostic 警告，harness 正常启动。
- [ ] `/reload`、`/new`、`/resume` 重建 harness 后，hook 仍然生效（重新注册）。
- [ ] `matcher` 过滤：`tool_call` matcher 为 `"Bash"` 时，非 Bash 工具调用不触发该脚本。
- [ ] lint + typecheck + 现有测试通过。

## Decisions

- **D1（配置形态）**：采用脚本文件目录形态（A）。`~/.novi/hooks/` + `<cwd>/.novi/hooks/`，按事件名映射脚本，stdin 传事件 JSON、stdout 收 result JSON。语言无关、进程隔离、与 pi/Claude Code 心智模型一致、复用现有双层 + trust gate 模式。
- **D2（触发范围）**：MVP 暴露第一档 4 个事件——`before_agent_start`（可改 messages/systemPrompt）、`tool_call`（可 block + reason）、`tool_result`（可改写 content/isError/terminate）、`session_before_compact`（可 cancel）。架构上用“已支持事件”配置表，预留扩展到第二档（`before_provider_request`/`before_provider_payload`/`after_provider_response`/`session_before_tree`/`context`）的能力；第三档纯通知事件不派发给用户脚本。
- **D3（映射方式）**：manifest 声明式（B）。`~/.novi/hooks/hooks.json` + `<cwd>/.novi/hooks/hooks.json`，schema 仿 Claude Code：`{ hooks: { <event>: [{ matcher?: string, hooks: [{ command: string, args?: string[], timeoutMs?: number }] }] } }`。复用 settings 双层 + trust gate 加载模式；matcher 支持 `tool_call`/`tool_result` 按工具名过滤。
- **D4（IPC 协议）**：
  - **stdin**：事件 JSON，snake_case 字段，包含 `session_id`/`cwd`/`hook_event_name` + 事件特定字段（直接映射 core 事件对象，如 `tool_call_id`/`tool_name`/`input`/`content`/`is_error`/`prompt`/`system_prompt`/`preparation`）。
  - **stdout**：`{ "result": { <core result fields> } }`，映射 core 的 `AgentHarnessEventResultMap`（如 `{ block, reason }` / `{ content, is_error, terminate }` / `{ messages, system_prompt }` / `{ cancel }`）。空 stdout + exit 0 = no-op。非空 stdout 必须是合法 JSON，解析失败→警告 + no-op（不崩溃 harness）。
  - **超时**：默认 10s，manifest `timeoutMs` 可覆盖。超时→SIGTERM→500ms grace→SIGKILL，结果视为 no-op + stderr 警告。
  - **退出码**：exit 0 = 正常（读 stdout）；exit 2 = 阻断错误（`tool_call` 自动生成 `{ block: true, reason: <stderr> }`，其他事件 warn + no-op）；其他非 0 = 脚本失败（warn + no-op）。进程隔离，脚本崩溃不影响 harness。
- **D5（注册时机与重放）**：bootstrap 时加载 manifest + 注册（A，非懒加载），`replayHarnessState` 在 harness 重建时重新 `loadHooks` + `registerHooks`（trusted 复用 old handle 的，与 `loadResources` 一致）。dispatcher 闭包懒 spawn 脚本——manifest 加载时机早，但脚本执行仍只在事件匹配时。