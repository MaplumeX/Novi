# 加固工具权限与工作区边界

## Goal

确保工具授权遵循当前最严格策略，并为文件、命令和网络能力建立可扩展的作用域权限基础。

## Background

- `PermissionGate.onToolCall` 当前先检查 session grant，再解析静态策略，历史授权可绕过新 `deny`。
- 权限键只有工具名，未配置工具隐式 `allow`。
- 文件工具接受 cwd 外绝对路径，`write_file` / `edit_file` 默认无需确认。

## Requirements

- 当前 `deny` 永远优先于 session grant，`/reload` 后立即生效。
- 工具 descriptor 声明 capability、风险等级和默认权限；未知工具采用 fail-safe 默认。
- 权限规则区分整工具 deny 与 scoped deny：前者影响 availability，后者只影响匹配调用。
- 作用域授权至少可表达 workspace 内文件读/写、具体命令摘要和公开网络访问。
- workspace 内读取、搜索和变更按对应工具策略正常决策。
- workspace 外读取、搜索默认询问，并可按规范化路径授予有界权限。
- workspace 外写入、编辑默认拒绝，只有全局配置的显式白名单可以放行；项目配置不得放宽。
- `bash` 仍按命令能力单独授权；本任务不要求 shell 遵守原生文件工具的 workspace 路径边界。
- 权限提示与文档必须明确：文件边界不是 OS 沙箱，获批 shell 命令及其子进程可能访问 workspace 外路径。
- session grant 不再按整个工具名授权，而是按 capability 的最小规范化作用域保存。
- `read_file` 授权当前 canonical 文件；`ls` 授权当前目录；`glob`/`grep` 授权当前 canonical 根及子树；`fetch_content` 授权当前域名；`web_search` 仅授权搜索能力；`bash` 只授权完整规范化命令。
- workspace 外变更不提供 session grant，只接受 global 白名单。
- 路径授权同时校验 lexical path 与可解析的 symlink target；静态 deny 在 reload 后始终优先。
- session grant 在 harness rebuild/resume 中语义明确一致，但不持久化到跨进程长期策略。
- 保留全局权限与 project tighten-only 合并语义。

## Acceptance Criteria

- [x] 已授权工具在策略改为 `deny` 后立即拒绝。
- [x] workspace 内正常读写保持可用；workspace 外读取触发路径审批，默认越界写入被阻止。
- [x] 只有全局白名单可放行 workspace 外变更，project settings 无法扩大边界。
- [x] 新增未知高风险工具不会因为未配置而自动执行。
- [x] 整工具 deny 不进入模型上下文；scoped deny 保留工具定义并稳定拒绝匹配调用。
- [x] TUI 审批能展示 capability、规范化目标和授权作用域。
- [x] Allow for this session 只放行相同最小作用域，参数或目标变化重新决策。
- [x] Headless/Gateway 在无法交互时 fail closed，并输出机器可识别拒绝码。
- [x] 权限单元测试与 bootstrap/reload/resume 集成测试通过。

## Decisions

- 采用严格 workspace 边界：内侧按工具策略；外侧读取/搜索默认询问并按路径授权；外侧变更默认拒绝，仅全局白名单可放行。
- 本轮不实现 shell 沙箱，也不保证 `bash` 无法绕过 workspace 边界；shell 风险由独立命令审批承担。
- session grant 采用最小作用域：文件/目录/子树/域名/搜索能力/完整命令，不再工具级放行。
