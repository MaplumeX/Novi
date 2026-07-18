# MCP 协议完整性与上下文高效工具发现实施计划（父任务）

父任务不直接修改业务代码。实际实现按下列子任务顺序进行；只有当前置子任务质量门通过后才启动后继任务。

## 1. 子任务 1：Catalog 协议内核

- [x] 完成并审阅 `07-17-mcp-catalog-refresh` 的 PRD/design/implement。
- [x] 启动并完成全分页、schema validator、revision、listChanged、原子 refresh/LKG。
- [x] 运行子任务聚焦测试与完整基础质量门。
- [x] 确认对外 catalog/manager API 足以支持后继任务，避免后继绕过 snapshot 读取 SDK client state。

## 2. 子任务 2：按需发现与权限委托

- [x] 在子任务 1 完成后启动 `07-17-mcp-tool-discovery-permissions`。
- [x] 完成 search/invoke、toolRef、exposure 设置、真实 descriptor 权限 subject、source rule/grant revision 与 live projection。
- [x] 验证 large catalog provider payload、stale/forged ref、安全收紧与四类 harness 构建路径。
- [x] 运行子任务聚焦测试与完整基础质量门。

## 3. 子任务 3：结果与生命周期

- [x] 在前两个子任务完成后启动 `07-17-mcp-result-lifecycle`。
- [x] 完成 result fidelity、binary artifact、output validation、progress/cancellation、错误分类和跨表面文档。
- [x] 验证所有结果类型、预算/JSON safety、abort/timeout/progress 竞态。
- [x] 运行子任务聚焦测试与完整基础质量门。

## 4. 父任务集成验收

- [x] 使用一个 fake MCP server 同时覆盖多页、大 catalog、listChanged、各种 result content、progress、abort 与 refresh failure。
- [x] 对照父 PRD AC1-AC8 逐项记录证据，确认三个子任务之间没有重复 catalog、权限或事件真相。
- [x] 复核无 MCP、小 MCP direct、大 MCP deferred、显式 direct/deferred、pinned、disabled source/tool、child allowlist 的组合矩阵。
- [x] 复核 TUI `/tools`、print/json、Gateway、child agent catalog 和 invocation 使用同一 revision/availability 语义。
- [x] 复核支持矩阵只把本期 Tools 能力标为支持，OAuth、Resources/Prompts、Sampling/Elicitation、Tasks 仍明确未支持。
- [x] 使用 `trellis-update-spec` 更新并复核 `tool-runtime-contracts.md`、`pi-agent-core-api.md`、错误处理、设置/目录及相关跨层规范。

## 5. 最终质量门

- [x] 运行全部 MCP、permission、registry、runtime、event、bootstrap、TUI、headless、gateway、agent 聚焦测试。
- [x] 运行 `npm run typecheck`。
- [x] 运行 `npm run lint`。
- [x] 运行 `npm run test`。
- [x] 运行 `npm run build`。
- [x] 运行 `git diff --check` 并审查 `git status --short`。
- [x] 使用 `trellis-check` 做 spec compliance、cross-layer 与 context-drift 复核。

## 集成验收证据（2026-07-18）

| 父级 AC | 自动化证据 |
| --- | --- |
| AC1 | `src/mcp/exposure.test.ts` 的 10,000-tool bounded exposure/search；`src/tools/assembly.test.ts` 的 paginated deferred discovery + invoke 组合回归。 |
| AC2 | `src/mcp/client-manager.test.ts` 的全分页、cursor/limit、listChanged storm、LKG；`src/tools/assembly.test.ts` 的 live projection、grant revoke、stale ref。 |
| AC3 | `src/mcp/client-manager.test.ts` 的 fail-soft/LKG/reconnect；父级组合回归验证 refresh failure 保留当前 revision 与 search proxy。 |
| AC4 | `src/mcp/result-mapper.test.ts` 覆盖 text/image/resource/structured/audio/blob、artifact 与 bounds；`src/tools/events.test.ts`、Headless/Gateway replay 验证统一 JSON-safe envelope。 |
| AC5 | `src/mcp/catalog.test.ts`、`client-manager.test.ts`、`result-mapper.test.ts`、`src/tools/events.test.ts` 覆盖 input/output schema、tool/protocol/transport、timeout、abort、progress 与 terminal race。 |
| AC6 | `src/permissions/policy.test.ts`、`gate.test.ts`、`tui-approver.test.ts` 与 assembly tests 验证真实 MCP subject、`external.invoke`、source/tool deny 和 revision grant。 |
| AC7 | `src/tools/session-assembly.test.ts`、`src/tui/commands.test.ts`、`src/headless/events.test.ts`、`src/gateway/agent/event-bridge.test.ts`、`src/agents/profiles.test.ts` 覆盖 builtin-only、目录/事件投影与 child allowlist。 |
| AC8 | `README.md` 与 `docs/tool-system-design.md` 给出 Tools-first supported/degraded/unsupported 矩阵；全量 140 files / 1211 tests、typecheck、lint、build、diff-check 均通过。 |

规范同步结果：`tool-runtime-contracts.md` 已包含 catalog、deferred discovery/permission 与 result lifecycle 三个 7-section 可执行场景；`directory-structure.md` 已记录新增 MCP 所有权。`pi-agent-core-api.md` 既有 `setTools(activeToolNames)`/MCP session assembly 契约、`error-handling.md` 的统一 `NOVI_ERROR` codec 与当前实现一致，本轮不重复扩写。

## 风险与回滚点

- 子任务 1 的 catalog snapshot 是后续唯一真相；若 API 不稳定，不得在子任务 2/3 创建旁路缓存应急。
- 子任务 2 触及 PermissionGate 和所有 harness 装配路径，是最高安全/回归风险；必须保留 builtin-only 与小 catalog direct 回归。
- 子任务 3 触及 runtime/artifact/event 公共协议；binary payload 不得进入 JSONL/Gateway 公共事件。
- 任一子任务失败时保留已完成子任务的独立价值，不启动依赖它的后继任务；不得通过扩大 out-of-scope 能力规避阻塞。
