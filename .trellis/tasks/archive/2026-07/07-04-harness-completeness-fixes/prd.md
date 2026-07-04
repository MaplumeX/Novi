# harness completeness fixes

## Goal

修复 harness 基础层面 4 个已确认的不完善点：compaction settings 死配置、todo 跨 session 残留、/reload 丢弃资源 diagnostics、/reload 半 reload 语义。

## Background

通读 src/ 后发现四处 harness 层面的缺陷（分支导航命令缺失、已删命令的 fallback 提示不一致等经用户确认为主动设计取舍，不在本任务范围）。

## Requirements

### R1 compaction settings 实际生效
- `settings.json` 的 `compaction.{enabled, reserveTokens, keepRecentTokens}` 必须被 `AutoCompactor` 消费，而非硬编码 `DEFAULT_COMPACTION_SETTINGS`。
- `compaction.enabled = false` 时，auto-compaction 不触发。
- `compaction.{reserveTokens, keepRecentTokens}` 传入 `shouldCompact` / `prepareCompaction` 的 settings 参数。
- 未配置的字段回退到 `DEFAULT_COMPACTION_SETTINGS` 对应值（部分配置不丢默认）。
- `/reload` 后 compaction settings 跟随重新解析的 settings 生效。

### R2 todo 工具按 session 隔离
- `todo` 工具的 store 按 sessionId 分桶，`/new` / `/resume` 切换 session 后 `todo list` 只看到当前 session 的条目。
- 切回旧 session 时，旧 session 的 todo 仍在（不丢失）。
- 进程退出后不持久化（保持现状，不引入落盘）。

### R3 /reload 不再丢弃资源 diagnostics
- `replayHarnessState` 中 `loadResources` 返回的 diagnostics 必须传递给调用方并打印，不能静默吞掉。
- skill / prompt template 文件损坏时，`/reload`、`/new`、`/resume` 都应给用户提示。

### R4 /reload 真正重新解析 model/thinking/streamOptions/queue-modes
- `/reload` 后 `defaultModel`、`defaultThinkingLevel`、`retry.provider.*`、`transport`、`steeringMode`、`followUpMode` 从磁盘 settings 重新解析并应用到新 harness。
- `/new`、`/resume` 保持当前行为（从 old harness 重放 model/thinking/streamOptions，因为用户期望切换 session 时保持当前运行时配置）。

## Acceptance Criteria

- [ ] `compaction.test.ts`：settings `enabled:false` 时 `maybeCompact` 不触发；`reserveTokens`/`keepRecentTokens` 被传入 `shouldCompact`。
- [ ] `todo.test.ts`：两个不同 sessionId 的 store 互不干扰。
- [ ] `harness-handle` 相关测试：`/reload` 路径返回 resource diagnostics；`/new`/`/resume` 路径同样返回 diagnostics。
- [ ] `harness-handle` 相关测试：`/reload` 传 `resolvedSettings` 时，新 harness 的 model/thinking/streamOptions/steeringMode/followUpMode 来自 settings 而非 old harness。
- [ ] `npm test` 全绿；`npm run typecheck` 无错。
- [ ] ARCHITECTURE.md §4.6 / §6.2 相应段落更新（compaction 消费 settings、HarnessHandle.replace 返回 diagnostics、/reload 语义变更）。

## Out of Scope

- 分支导航命令（/tree /goto /history）—— 主动不提供。
- 已删命令（/abort /thinking /tools /queue /templates）的恢复。
- todo 落盘持久化。
- ARCHITECTURE.md §6.5 命令清单与实际注册表的对齐（单独清理）。