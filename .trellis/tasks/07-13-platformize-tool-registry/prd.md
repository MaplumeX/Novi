# 平台化工具注册与启停

## Goal

把静态 BuiltinToolRegistry 升级为可校验、可诊断、可动态启停的工具描述与装配层，为后续插件/MCP 接入提供稳定边界。

## Requirements

- ToolDescriptor 统一声明 name、factory、capabilities、risk、defaultPermission、presentation 和可选依赖。
- 注册时检测重复名、descriptor/tool name 不一致、无效 schema 与缺失依赖。
- 注册重名、descriptor/tool name 不一致、无效权限元数据等安全关键契约错误必须阻止启动。
- 可选工具缺少依赖、凭证或外部服务不可用时跳过该工具并输出明确诊断，不拖垮整个 harness。
- unavailable 工具不得暴露给模型，并必须在 `/tools` 与 Headless `tools_update` 中报告原因。
- 支持 settings/运行模式决定 active tool set，并在 rebuild/resume/gateway 中保持一致。
- 工具可见性与调用权限分层：整工具 deny、disabled、unavailable、未启用外部工具不暴露；allow/ask 和仅含 scoped deny 的工具继续暴露，由运行时 gate 判断具体调用。
- 权限、TUI 展示与 Headless 事件消费 descriptor，不再维护彼此漂移的硬编码映射。
- 预留外部工具来源接口，但不在本任务实现完整 MCP transport。

## Acceptance Criteria

- [x] 所有内置工具通过 descriptor 注册，旧注册结构和兼容分支被删除。
- [x] 重复名和名字不一致有确定性测试。
- [x] 安全契约错误阻止启动；可选工具初始化故障可降级且有稳定 unavailable 诊断。
- [x] 禁用工具不会暴露给模型，也不能通过普通 tool call 绕过。
- [x] 整工具 deny 会移出 active set；scoped deny 不移除工具，只拒绝匹配调用。
- [x] tools_update 包含来源、能力和 active 状态。
- [x] bootstrap、reload、resume、gateway 共用同一装配路径。

## Decisions

- 工具故障采用分级策略：安全关键契约错误 fail fast；可选能力运行前初始化故障 fail soft，并显式标记 unavailable。
- 采用 availability/permission 双层模型，行为对齐 Claude Code/Codex 的整工具禁用与作用域拒绝区分。
