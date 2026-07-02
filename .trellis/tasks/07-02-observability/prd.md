# F: observability (StatusBar usage + /session + provider retry)

## Goal

补齐可观测性：StatusBar 显示 token/cost/context 用量；`/session` 汇总 file/id/messages/tokens/cost；provider 级 retry 配置经 settings 暴露并通过 `setStreamOptions` 生效。

**依赖关系**：依赖 child 1（config-personalization）的 settings（`retry.provider.*` 字段已定义 + 透传）。本 child 实际消费 retry 配置 + 投影 usage 到 UI。

## Background — 已确认事实

### child 1 已做的
- `NoviSettings.retry.provider.{timeoutMs, maxRetries, maxRetryDelayMs}` 类型已定义。
- `bootstrap.ts` 已读 settings 并调 `harness.setStreamOptions({ maxRetries, timeoutMs, maxRetryDelayMs })`（透传，child 1 已打通）。
- `useHarnessState` 已投影 `message_end` 事件（含 `event.message.usage`）。

### AssistantMessage.usage
- `message_end` 事件的 `event.message`（role=assistant）含 `usage` 字段：`{ inputTokens, outputTokens, cacheReadTokens?, cacheWriteTokens?, cost? }`。
- `model.contextWindow` 给 context 总量。

### 当前 /session（child 4 实现）
- 显示 file / id / messages / name。本 child 补 tokens / cost。

### 当前 StatusBar
- 显示 phase / model / thinking / tools / queue。本 child 补 token + cost + context%。

## Requirements

### R1 StatusBar 用量展示
- 从最后 assistant message 的 `usage` 投影：inputTokens + outputTokens + cacheRead + cacheWrite。
- cost（若 usage.cost 存在）。
- context 用量 %：`totalTokens / model.contextWindow`（`totalTokens` = input+output 近似，或用 usage 的 input 作为 context 占用估算）。
- 显示格式：`tok:12k cost:$0.03 ctx:45%`（紧凑，适合单行）。

### R2 /session 补充 tokens + cost
- child 4 已显示 file/id/messages/name。本 child 加：累计 tokens（所有 assistant message usage 之和）+ 累计 cost + context window 大小。
- 从 `session.getBranch()` 取 messages → 聚合 assistant message usage。

### R3 provider 级 retry 配置生效
- child 1 已透传 `setStreamOptions`。本 child 验证：
  - settings `retry.provider.*` 写入 → `/reload` 后 harness 的 `getStreamOptions()` 反映新值。
  - retry 实际行为：provider 超时/重试按配置（手测难，至少验证 `getStreamOptions()` 返回正确值）。

## Acceptance Criteria

- [ ] StatusBar 显示 token 用量 + cost + context% （从最后 assistant message usage 投影）。
- [ ] `/session` 显示累计 tokens + 累计 cost + context window。
- [ ] settings `retry.provider.{timeoutMs, maxRetries, maxRetryDelayMs}` 写入后 `/reload` 生效（`getStreamOptions()` 反映）。
- [ ] 无 usage 数据时不 crash（显示 0/-）。
- [ ] `tsc --noEmit` + `eslint` + `vitest` 全绿。

## Out of Scope

- agent 级 retry（turn 失败退避重发）——不做，留作未来。
- 实时 token 计数（流式中途估算）——只取已完成 message 的 usage。
- 分 provider 的 cost 速率表——用 usage.cost 直接值。

## Technical Notes

- 详细设计见 child 7 的 `design.md`（若必要；本 child 较轻）。
- 本 child 的 `implement.md` 给出文件改动清单。
