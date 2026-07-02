# Tool Registration Mechanism

## Goal

为 Novi 引入代码级工具注册抽象（`BuiltinToolRegistry`），替代 `src/tools/index.ts` 中硬编码的工具数组字面量。内部结构性重构，**不改变用户可见行为**，不含插件/扩展功能。

## Background（已确认事实）

经代码勘察确认：

- **当前机制**：`src/tools/index.ts` 的 `createBuiltinTools(env)` 手动 import 8 个内置工具，组装成数组返回。唯一注册点是 `bootstrap.ts:260-261`（`harness.setTools(tools, tools.map(t => t.name))`，全量启用）和 `tui/harness-handle.ts:replayHarnessState`（rebuild 时重新创建内置集 + 保留 `activeToolNames` 子集）。
- **工具结构**：每个工具文件导出 `createXxxTool(env): AgentTool` 工厂函数（`todo` 例外，无 env 依赖）。`AgentTool` 自带 `name/label/description/parameters/execute`。
- **启用/禁用**：`AgentHarness.setTools(tools, activeToolNames?)` 已支持 active 子集，`activeToolNames` 默认全部。运行时 `/tools` 命令只读 `getActiveTools()` 列表，无添加/移除工具的运行时命令。
- **Settings 结构**：`NoviSettings`（`src/settings.ts`）有 provider/model/thinking/compaction/retry，无 tools 相关配置项。本次不新增 settings 配置。
- **系统提示词**：`default-system-prompt.ts` 不硬编码工具名，工具 schema 由 harness 注入模型，重构不影响 prompt。
- **Headless 与 TUI 共享 bootstrap.ts**：改 bootstrap.ts 即两条路径同时受益。
- **现有测试**：`tools/__tests__/index.test.ts` 校验 `createBuiltinTools` 返回 8 个工具 + 元数据完整性（name/label/description/parameters/execute）。
- **spec 记录**：`.trellis/spec/backend/directory-structure.md` 记录了 `tools/index.ts` 的 aggregator 角色和工具文件模式（`createXxxTool(env) → AgentTool`）。

## Requirements

1. **新增 `BuiltinToolRegistry` 抽象**（`src/tools/registry.ts`）：
   - 持有一组工具注册项（name + factory）。
   - 提供 `add(name, factory): this`（链式）、`buildAll(env): AgentTool[]`、`names(): string[]`。
   - `ToolFactory` 签名兼容现有 `(env: ExecutionEnv) => AgentTool`（含 `todo` 的无参数情况，需兼容处理）。

2. **改写 `src/tools/index.ts`**：用集中显式注册替代数组字面量——模块级单例 `registry`，链式 `.add()` 调用 8 个内置工具。`createBuiltinTools(env)` 保留为 `registry.buildAll(env)` 的薄包装（调用方签名不变）。

3. **调用方零改动**：`bootstrap.ts` 和 `tui/harness-handle.ts` 仍调用 `createBuiltinTools(env)`，行为不变。

4. **测试更新**：`tools/__tests__/index.test.ts` 继续验证 8 个工具 + 元数据完整性；可选新增 registry 单元测试（add/buildAll/names 行为）。

## Out of Scope

- 插件 / 扩展加载（第三方工具、磁盘约定目录扫描）。
- MCP server 网关接入。
- 运行时动态增删工具到可用池（仍是编译期固定 8 个内置工具）。
- settings 配置驱动的启用/禁用（本次纯代码重构，无用户可见行为变化）。

## Acceptance Criteria

1. `src/tools/registry.ts` 存在，导出 `BuiltinToolRegistry` 类 + `ToolFactory` 类型。
2. `src/tools/index.ts` 用 `BuiltinToolRegistry.add()` 集中注册 8 个内置工具，无遗留数组字面量。
3. `createBuiltinTools(env)` 签名不变，`bootstrap.ts` / `tui/harness-handle.ts` 调用处无改动。
4. `tools/__tests__/index.test.ts` 通过，仍验证 8 个工具名 + 元数据完整性。
5. 项目 `lint` + `typecheck` 通过。

## Open Questions

无（范围已确认：B 纯代码重构 + 集中显式注册）。
