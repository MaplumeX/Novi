# C2: message queue UX (steer/followUp/Escape restore/Alt-Up)

## Goal

完善消息队列 UX：steer / followUp 独立快捷键、Escape abort + restore queue、Alt+Up 取回 queue。harness 已有 `steer()`/`followUp()`/`nextTurn()` + `queue_update` 事件，`useHarnessState` 已投影 queue——本 child 接通快捷键 + queue 展示 + restore 逻辑。

**依赖关系**：本 child 依赖 child 2（editor-capabilities）升级后的 InputBox（cursor 模型 + 快捷键路由）。在 InputBox 的 useInput 里接入 steer/followUp/Alt+Up/Esc-restore。

## Background — 已确认事实

### harness API（已验证，见 spec/backend/pi-agent-core-api.md）
- `steer(text, { images? })`：turn 中调用，消息在当前 assistant turn 的 tool calls 后、下次 LLM 调用前注入。返回 `Promise<void>`。
- `followUp(text, { images? })`：turn 中调用，消息在 agent 完成所有工作后注入。返回 `Promise<void>`。
- `nextTurn(text, { images? })`：排队下一轮用户 prompt。返回 `Promise<void>`。
- `queue_update` 事件：`{ steer: AgentMessage[]; followUp: AgentMessage[]; nextTurn: AgentMessage[] }`，已投影到 `HarnessState.queue`。
- `abort()`：返回 `Promise<AbortResult>`。

### 当前 InputBox（child 2 升级后）
- EditorState cursor 模型 + Emacs 键位 + overlay 支持。
- turn 中（phase !== "idle"）：`submit()` 在非 `/` 命令时直接 return（不发 prompt）——**这正是本 child 要改的点**：turn 中 Enter 应走 steer，Alt+Enter 走 followUp。

### 当前 queue 展示
- `StatusBar` 已显示 `queue: N (sX fY nZ)`。但队列内容本身不可见，用户无法知道 queued 了什么。

### pi 参考
- Enter = steer（turn 中）；Alt+Enter = followUp；Escape = abort + restore queue；Alt+Up = 取回 queue 末尾到编辑器。

## Requirements

### R1 Enter = steer
- turn 中（phase === "turn"）Enter 提交时：调 `harness.steer(text)` 而非直接 return。
- idle 时 Enter 仍走 `harness.prompt(text)`（不变）。
- compaction 中（phase === "compaction"）Enter 不响应（与现有 phase 守卫一致）。
- steer 后清空输入。

### R2 Alt+Enter = followUp
- turn 中 Alt+Enter 提交时：调 `harness.followUp(text)`。
- idle 时 Alt+Enter 行为：等同 Enter（prompt）或拒绝——定为提示「followUp 只在 turn 中有意义」。简化：idle 时 Alt+Enter 走 prompt（作为普通提交）。
- followUp 后清空输入。

### R3 Escape = abort + restore
- turn 中 Escape：调 `harness.abort()`，等待 abort 完成后，把当前编辑器中的未发送文本**保留**（不丢）；若 abort 时有 queued steer/followUp，把它们的内容 restore 到编辑器（拼接，或逐条提示）。
- idle 时 Escape：清空编辑器（现有行为，若已有则保留）。
- 实现要点：abort 是异步的，abort 后 harness 回 idle，queue_update 会反映 queue 清空。restore 逻辑：在调 abort 前，先从 `state.queue` 读取 steer+followUp 的内容，abort 完成后塞回编辑器。

### R4 Alt+Up = 取回 queue 末尾
- Alt+Up：从 queue 末尾取一条消息（优先级 steer > followUp > nextTurn）放回编辑器，并从 queue 移除。
- harness 无「dequeue」公共 API——queue 是 harness 内部管理的。**实现路径**：harness 不支持从 queue 移除，因此 Alt+Up 的「取回」语义为：读 queue 末尾内容到编辑器，但实际 queue 仍保留（harness 会照常投递）。
  - **简化方案**：Alt+Up 只在 queue 非空且有未发送编辑器内容为空时，取 queue 末尾**预览**到编辑器，用户可编辑后重新 steer/followUp。不真正从 harness queue 移除（harness 不支持）。
  - AC 里标注此限制：Alt+Up 是「取回预览」，不是「dequeue」。

### R5 queue 展示
- StatusBar 已展示 queue 计数（保留）。
- 可选：在 InputBox 上方（或 notice 区）短暂显示 queued 内容摘要（如「queued: [steer] 把 X 改成 Y」）。简化为本 child 只保计数 + `/queue` 命令列详情（若易实现）。

## Acceptance Criteria

- [ ] turn 中 Enter 提交文本调 `harness.steer(text)`，输入清空，queue 计数 +1。
- [ ] turn 中 Alt+Enter 提交文本调 `harness.followUp(text)`，输入清空，queue 计数 +1。
- [ ] idle 时 Enter 仍走 `harness.prompt(text)`（无回归）。
- [ ] turn 中 Escape 调 `harness.abort()`，harness 回 idle，编辑器中未发送内容保留，已 queued 的 steer/followUp 内容 restore 到编辑器。
- [ ] Alt+Up 把 queue 末尾消息内容预览到编辑器。
- [ ] compaction 中 Enter/Esc 不响应（phase 守卫）。
- [ ] queue 计数在 StatusBar 正确反映 steer/followUp/nextTurn 变化。
- [ ] `tsc --noEmit` + `eslint` + `vitest` 全绿。

## Out of Scope

- 真正的 dequeue（harness 不支持从 queue 移除，本 child 不建 SessionManager 层）。
- queue 内容常驻 UI 面板（后置，可选）。

## Technical Notes

- 详细设计见 child 3 的 `design.md`：快捷键路由状态机、abort+restore 流程、Alt+Up 预览语义。
- 本 child 的 `implement.md` 给出文件改动清单 + 验证命令。
