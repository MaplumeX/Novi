# Gateway 会话连续性实施计划

## 1. 路由与持久存储

- [x] 在 `src/gateway/core/types.ts` 定义 `GatewaySessionLocator` / `GatewaySessionRoute`，让 turn、reset 和 manager 使用结构化 route。
- [x] 重构 `src/gateway/core/routing.ts`：由 channel + message 生成 locator 与无碰撞 canonical key；更新路由测试。
- [x] 新增 `src/gateway/core/session-store.ts`：V1 schema、严格 decoder、缺失文件初始化、resolve/bind/rotate API、Promise 写串行、同目录临时文件 + `rename` 原子提交。
- [x] 新增 `src/gateway/core/session-store.test.ts`，覆盖 round-trip、多个 locator 指向同一 metadata、archive rotate、损坏 JSON、非法字段、未知版本、route/locator 不一致与写失败不更新快照。

## 2. Bootstrap 新建/恢复统一

- [x] 将 `createHarnessForSession` 的未使用 `sessionKey` 支为 `HarnessSessionTarget`（new/resume），结果返回 canonical metadata。
- [x] 复用同一 harness 装配路径实现 Gateway cold resume，并让 `bootstrap({ resumePath })` 委托该路径，移除重复装配代码。
- [x] 保持 TUI/headless 的 permission store、tools、hooks、resources、stream/queue mode 和 MCP 契约不变。
- [x] 扩展 `src/bootstrap.test.ts`，验证 new/resume 目标选择和 Gateway/TUI permission store 约束。

## 3. Adapter 持久恢复与事务

- [x] 给 `NoviAgentAdapter` 注入已加载的 `GatewaySessionStore`。
- [x] 把缓存 entry 扩展为 canonical metadata + generation；首次访问按 binding 选择 create/open。
- [x] 增加 per-route pending/lifecycle 去重，保证并发首次初始化只产生一个有效 session。
- [x] 对恢复 metadata 做 `id/cwd/path` 一致性校验；悬空或损坏 target 抛可操作错误，不 fallback create。
- [x] 为 EventBridge callbacks 增加 entry/generation guard，抑制 reset 后旧 turn 的 delta、final/error。
- [x] 实现 reset 事务：invalidate → abort/wait/close → create → store rotate → publish；失败时保持旧 binding、关闭新 runtime 并最佳努力清理未绑定 JSONL。
- [x] 新增 `src/gateway/agent/novi-agent-adapter.test.ts`，覆盖首次 bind、冷恢复、close 后恢复、dangling target、并发初始化、reset rotate、迟到 callback、持久化失败回滚。

## 4. SessionManager 与命令语义

- [x] 让 `GatewaySessionManager` 接收 `GatewaySessionRoute`，并为每个 route 维护 reset promise。
- [x] 实现 `reset(route)`：登记 barrier、清空旧 lane queue、调用 adapter reset、让 reset 后到达的普通消息等待后进入新 session。
- [x] 更新 `AgentProtocolAdapter` 与 `CommandContext` 契约，使 `/new` 通过 manager 生命周期入口，不再直接绕过 lane 调 adapter。
- [x] `/new` 只在 rotate 成功后发送成功消息；失败时发送明确失败消息。
- [x] 扩展 session-lane/session-manager/gateway-app/command 测试，验证运行中 reset、队列清空、等待消息归属、失败回滚和成功/失败回复。

## 5. 启动接线、文档与规格

- [x] 在 `runGateway` 中于渠道启动前加载/校验 `~/.novi/gateway-sessions.json`，注入 adapter；损坏/未知版本直接抛错终止启动。
- [x] 更新 `docs/gateway.md`，记录映射路径、重启/淘汰语义、`/new`、归档和故障恢复方式。
- [x] 实现完成后使用 `trellis-update-spec` 更新 backend database、directory structure 与 pi-agent-core bootstrap 契约，删除“每次无条件新建”的旧描述。

## 6. 验证与评审门

- [x] 先运行聚焦测试：`npx vitest run src/gateway/core/routing.test.ts src/gateway/core/session-store.test.ts src/gateway/core/session-manager.test.ts src/gateway/core/session-lane.test.ts src/gateway/core/gateway-app.test.ts src/gateway/agent/novi-agent-adapter.test.ts src/bootstrap.test.ts`。
- [x] 运行 `npm run typecheck`。
- [x] 运行 `npm run lint`。
- [ ] 运行完整 `npm run test`。
- [x] 运行 `npm run build`。
- [x] 检查 `git diff --check` 和 `git status --short`，确认未修改用户的 gap analysis 文件。
- [x] 对照 PRD 验收矩阵复核：重启、淘汰、并发首次创建、运行中 `/new`、归档、悬空目标、损坏 store、写失败回滚。

## 风险文件与回滚点

- `src/bootstrap.ts`：create/resume 公共装配路径；若回归，优先回滚统一 helper，保留 Gateway store/adapter 逻辑。
- `src/gateway/core/session-manager.ts` / `session-lane.ts`：reset barrier 与递归 drain 的竞态；聚焦验证旧 queue 不会在新 session 重放。
- `src/gateway/agent/novi-agent-adapter.ts`：generation、MCP 释放和新建失败清理；任何失败不得提前发布 cache/binding。
- `src/gateway/core/session-store.ts`：唯一持久映射写入点；禁止就地覆盖和解析失败自动清空。
