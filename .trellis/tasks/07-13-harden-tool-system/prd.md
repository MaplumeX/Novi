# 强化 Novi 工具系统 P0/P1

## Goal

把 Novi 当前“可用的内置工具集”提升为具备明确安全边界、统一资源预算、可扩展注册协议和完整事件可观测性的工具平台，并确保 TUI、Headless、Gateway 与会话恢复使用一致的工具契约。

## Background

- 当前工具权限只按工具名决策，session grant 在重新解析静态策略之前直接放行，可能绕过 `/reload` 后的新 `deny`。
- 未配置工具默认 `allow`，文件路径只做绝对化，没有 workspace 写入边界。
- `bash`、文件遍历和 Web 缓存缺少端到端资源治理；部分文本虽然对模型截断，内部仍保留全量数据。
- `BuiltinToolRegistry` 仅是静态工厂列表，缺少 descriptor、capability、冲突校验、健康诊断与动态启停基础。
- Headless 工具事件丢失 partial/result/details，TUI 的 `edit_file` 展示仍按旧参数协议解析。

## Requirements

- R1：修复权限决策顺序，任何当前生效的 `deny` 都不得被历史 session grant 绕过。
- R2：建立 capability 与作用域感知的权限基础，新增或未知高风险工具不得隐式放行。
- R2.1：session grant 使用 capability 最小作用域，不再以工具名整体授权；静态 deny 永远优先。
- R3：采用严格 workspace 边界：内侧按工具策略；外侧读取/搜索默认询问并可按路径授权；外侧变更默认拒绝，仅全局白名单可放行，并给出稳定拒绝原因。
- R4：建立统一工具运行预算，覆盖 timeout、输出字节、partial update、遍历数量/深度、并发和缓存容量。
- R4.1：预算层级为内置默认、global 可调、project 只收紧、CLI 当前运行显式覆盖；所有运行模式共享解析结果。
- R4.2：超额输出默认写入受 `0600`、容量和年龄上限保护的本地 artifact；global 可关闭，project 不得强制开启或放宽配额。
- R4.3：默认预算为 50 KiB/2,000 行模型输出、256 KiB 内存、16 KiB delta、10 Hz、120 秒 Bash、50,000 文件/64 深度/10,000 结果、256 MiB 会话 artifact/1 GiB 全局/7 天、512 MiB Web cache/30 天。
- R5：将内置注册中心升级为带元数据和校验的工具描述协议，为后续插件/MCP 接入提供稳定边界；本任务不要求直接实现完整 MCP 客户端。
- R5.1：注册安全契约错误必须阻止启动；可选工具的依赖、凭证或服务故障允许降级，但必须从模型 active set 移除并公开 unavailable 诊断。
- R6：支持按运行模式和配置启停工具，默认只激活明确启用且策略允许暴露的工具。
- R6.1：availability 与 permission 分层；整工具 deny/disabled/unavailable 不暴露，scoped deny 保留工具并在调用时执行。
- R7：统一工具结果和错误的可序列化协议，保留向模型提供简洁文本的能力。
- R8：Headless JSON 必须完整投影工具 partial、final result、error、truncation 与必要 metrics，并保持 JSON-safe。
- R8.1：partial 协议采用 `toolCallId + sequence + delta`，final 事件提供有界结果 envelope。
- R9：TUI 必须正确展示规范化后的 `edit_file.edits[]`，未知/外部工具保持可读降级。
- R10：所有变更必须覆盖 fresh session、resume、`/reload`、TUI、print/json headless 和 gateway harness 创建链路；仓库内消费者一次性切换，不保留旧协议兼容层。

## Task Map

- 权限与工作区边界：P0 安全语义、capability、作用域授权。
- 工具资源治理：输出背压、遍历预算、缓存回收。
- 工具注册与启停：descriptor、校验、动态 active set、扩展边界。
- 工具事件与展示协议：统一结果 envelope、Headless/TUI 投影。

父任务负责跨子任务契约、一致性与最终集成验收，不直接作为首个实现目标。

## Acceptance Criteria

- [ ] 已有 session grant 无法绕过后续生效的 `deny`，并有回归测试覆盖。
- [ ] 文件写入/编辑默认受 workspace 边界约束，越界拒绝在 TUI、Headless、Gateway 中一致。
- [ ] 新工具注册必须声明 descriptor/capability；重复名、名字不一致和无效元数据会被确定性拒绝或诊断。
- [ ] 大输出、深目录和长期 Web 缓存均有配置上限，不再依赖执行完成后的表面截断。
- [ ] Headless JSON 客户端可以关联并消费一次工具调用的开始、增量、结束、结构化结果与错误。
- [ ] `edit_file.edits[]` 的单项和多项编辑在 TUI 中均显示正确摘要/diff。
- [ ] 全量 lint、typecheck、test 通过，并新增跨层集成测试验证 bootstrap/reload/resume/gateway 一致性。
- [ ] 四个子任务分别通过验收，父任务完成最终契约一致性复核。

## Out of Scope

- 完整 MCP transport/client 实现与第三方插件市场。
- 操作系统级容器、seccomp 或虚拟机沙箱。
- 强制 `bash` 及其子进程遵守原生文件工具的 workspace 路径权限；本轮仅保留独立命令审批并清晰披露边界。
- JavaScript 浏览器渲染、OCR 和新的 Web 搜索供应商。
- 重写上游 `pi-agent-core`；优先通过其公共 API 完成。

## Decisions

- 文件系统采用严格边界；项目配置只能收紧，不能扩展 workspace 外写入白名单。
- 工具注册/初始化故障采用分级处理：安全契约 fail fast，可选能力 fail soft。
- Headless 工具流采用带序号 delta，结束时发送有界 final result。
- 工具预算允许 global 调整、project 只收紧、CLI 当前运行显式放宽或收紧。
- 工具暴露采用双层模型：整工具禁用影响 active set，作用域权限只影响具体调用。
- 不实现 shell 沙箱，不承诺 `bash` 遵守文件工具 workspace 边界。
- 工具事件与结果协议允许完整 breaking change，不做旧字段双写或迁移适配。
- 超额输出使用受治理的本地 artifact，结果与历史不保留无界全量副本。
- session grant 采用 canonical 文件/目录/子树/域名/搜索能力/完整命令的最小作用域。
