# Write Novi agent architecture documentation

## Goal

为 Novi（agent harness + TUI + headless + gateway）在仓库根目录交付实现级架构地图 **`ARCHITECTURE.md`**，帮助贡献者与维护者快速定位：进程入口、三种运行表面、共享核心接线、模块边界、关键控制/数据流，以及更深契约文档所在位置。

受众：**贡献者 / 自己**（非终端用户产品文案）。

## Background

- 单包 TypeScript ESM（`package.json`），Node `>=22.19`，bin → `dist/cli.js`；开发入口 `src/cli.ts`。
- 依赖 `@earendil-works/pi-agent-core` + `@earendil-works/pi-ai` 提供 harness / session / models。
- 当前树已有模块布局规范（`.trellis/spec/backend|frontend/directory-structure.md`）、工具系统长文（`docs/tool-system.md`）、gateway 配置摘录（`docs/gateway.md`）、功能向说明（`README.md`），但**缺少根级统一架构入口**。
- 工作区中 `ARCHITECTURE.md` 处于删除状态；本任务**禁止**从 git 历史/暂存区恢复旧文，必须基于**当前工作树**重写。

## Confirmed decisions

| 决策 | 选择 |
|------|------|
| 交付路径 | 根目录 `ARCHITECTURE.md` |
| 受众深度 | 实现级（模块/边界/流/文件锚点） |
| 自包含程度 | **架构地图**：外链 `docs/*` 与 `.trellis/spec/*`，不复制长契约表 |
| 图示 | **Mermaid only**（系统分层 + 入口/表面 + 至少一条关键流） |
| 语言 | **中文正文**；路径/符号/API 保持英文标识 |
| README | **不修改** `README.md` |
| 章节大纲 | 采用默认 11 节大纲（写作时可微调标题措辞） |
| 证据来源 | 仅当前工作树；禁止 git history/index/stash 作为正文来源 |

## Requirements

- R1. **System map**：定位、主要模块、三表面（TUI / headless print|json / gateway）、`cli.ts` 入口。
- R2. **Core wiring**：`prepareGatewayEnv` / `createHarnessForSession` / `bootstrap`；settings、trust、credentials、models、resources、hooks、session、compaction；文件锚点。
- R3. **Cross-surface contracts**：harness 订阅归属、共享 `tools/events.ts` tool 投影 vs 表面本地 non-tool 投影、依赖方向（gateway 不 import `tui/` 等）。
- R4. **关键流**（至少）：交互一轮；tool call + permission/budget/artifact；headless JSON 生命周期；gateway inbound → session lane → agent → outbound。
- R5. 细节契约**外链**权威源；允许关键路径短摘要。
- R6. 相对当前树准确；可写 non-goals（如 workspace 边界非 OS sandbox）。
- R7. 可维护、不发明不存在的 API。
- R8. 少量 Mermaid；散文与链接为事实源。
- R9. 中文正文 + 英文标识符。
- R10. 代码树交付物仅 **`ARCHITECTURE.md`**（外加任务目录规划产物）。

## Default outline (approved)

1. 概述  
2. 系统分层图（Mermaid）  
3. 进程入口与运行表面  
4. 共享核心接线  
5. 工具系统地图（外链 `docs/tool-system.md` 等）  
6. MCP 集成地图  
7. Gateway 子系统  
8. 关键控制/数据流（Mermaid）  
9. 持久化与配置面  
10. 模块索引 / 延伸阅读  
11. 维护说明（可选短节）

## Acceptance Criteria

- [ ] AC1. 根目录存在 `ARCHITECTURE.md`。
- [ ] AC2. 内容为实现级架构地图，非营销文案。
- [ ] AC3. 未使用 git 历史/已删暂存文作为措辞或结构来源。
- [ ] AC4. 覆盖 TUI、headless、gateway 与共享 core。
- [ ] AC5. tool/permission/MCP/session 边界有说明且外链深文档；无长表复制。
- [ ] AC6. 与当前 `src/` 及 `bootstrap` / `assembleSessionTools` / `GatewayApp` 等交叉核对。
- [ ] AC7. 中文正文；路径与符号英文。
- [ ] AC8. 用户审阅草稿后再完成/archive。
- [ ] AC9. 含 Mermaid（系统图 + 入口/表面 + ≥1 关键流）。
- [ ] AC10. 未修改 `README.md`。

## Out of scope

- 修改 `README.md`、`.trellis/spec/**` 正文，或其它非架构交付文件。
- 终端用户教程 / 完整 CLI man / 取代 README 功能说明。
- 新功能或重构。
- 从 git 恢复旧 `ARCHITECTURE.md`。
- 完整复述 budgets、web provider 矩阵、MCP schema 等。
- 翻译外链英文 docs/spec。
- ASCII 作为主可视化。

## Technical notes (for design, not requirements)

- 入口分支：`src/cli.ts` → list-models / onboarding / trust / `runGateway` / `bootstrap` + `runPrint`|`runJson`|`renderApp`。
- 共享准备：`prepareGatewayEnv`；会话：`createHarnessForSession`；TUI/headless 封装：`bootstrap`。
- 工具：`assembleSessionTools` / `createToolAssembly` / `createBuiltinToolAssembly`；权限：`permissions/**` + hooks `tool_call`。
- Gateway：`gateway/run.ts` + `GatewayApp` + `SessionManager` / `session-lane` + `NoviAgentAdapter` + `event-bridge`；禁止依赖 TUI。
- 权威深文：`docs/tool-system.md`、`docs/gateway.md`、`.trellis/spec/backend/*`、`.trellis/spec/frontend/*`。
