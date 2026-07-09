# Tool permission model for agent harness

## Goal

为 Novi agent harness 引入**内置工具权限控制**：静态策略 + TUI 交互确认，默认拦住 `bash`，把「全自动执行」升级为可配置的安全控制面。用户不再只能靠外部 hook 脚本做硬挡。

## Background

- core `tool_call` hook 返回 `{ block?: boolean; reason?: string }`；`beforeToolCall` 在 `execute` 前调用。
- core `emitHook`：**最后一个非 undefined result 胜出**。
- 现有 `src/hooks/` 可 silent block，无交互确认。
- 10 个 builtin 工具默认全 active；无 permission settings。
- TUI phase 仅 `idle | turn | compaction`。
- CLI `--approve` / `--no-approve` 专指 **project trust**，不得复用。
- project settings 仅 trusted 时加载；permissions 合并需 **只允许收紧**。
- 参考：pi `permission-gate.ts`（Yes/No + non-UI block）；Novi 做成内置。

## Decisions

| ID | 决策 |
|---|---|
| D1 | 静态策略 + 交互确认（非纯 allow/deny，非 policy DSL） |
| D2 | 默认仅 `bash=ask`；其余工具 `allow`；可按工具覆盖 `ask\|allow\|deny` |
| D3 | headless/gateway 对 `ask` fail-closed；CLI `--yes` 将 `ask→allow`（与 `--approve` 解耦） |
| D4 | TUI：Allow once / Allow for this session / Deny；session 按工具名记忆，不落盘 |
| D5 | 与用户 hook：**deny sticky**（任一方 deny 即 deny） |
| D6 | project 层 permissions **只能收紧**，不能放宽 |

## Requirements

### R1 策略模型与 settings
- settings 增加 `permissions.tools: Record<toolName, "allow"|"ask"|"deny">`。
- 内置默认：`{ bash: "ask" }`；未列出工具视为 `allow`。
- 解析优先级：defaults ← global ← project(tighten-only) ← CLI `--yes`(ask→allow)。
- project 收紧规则：severity 只能 `allow→ask/deny` 或 `ask→deny`，不能 `ask→allow` / `deny→*`。
- `/reload` 从磁盘重解析 permissions；**保留**进程内 session grants。

### R2 执行期 gate
- 在 harness `tool_call` 路径拦截；deny 返回 `{ block: true, reason }`，模型可见 reason。
- `allow`：直接放行。
- `ask` + TUI：阻塞等待用户选择后再放行/拒绝。
- `ask` + 非交互（print/json/gateway 且无 UI）：自动 deny + 明确 reason（除非 `--yes`）。
- session grant：用户选 “Allow for this session” 后，同工具名本进程内不再 ask。

### R3 TUI 确认
- 展示：工具名 + 关键参数摘要（bash 至少显示 `command`）。
- 选项：Allow once / Allow for this session / Deny。
- 确认期间 turn 保持可感知的 pending 状态（不误当成 idle；不丢 in-flight turn）。
- Esc 或等价取消 = Deny。

### R4 与用户 hooks 组合（deny sticky）
- 用户 `tool_call` hooks 与内置 gate 同时生效。
- 任一方 deny → 最终 deny。
- 用户 hook **不能**放行已被 permission deny 的调用。
- permission allow 后，用户 hook 仍可额外 block。

### R5 CLI / 模式覆盖
- 新增 `--yes`：把所有 `ask` 视为 `allow`（本 run）。
- 与 `--approve`（project trust）互不替代、可并存。
- help 文案区分两者。

### R6 可配置与可观测
- 可通过 settings / `/settings` 查看与编辑 `permissions.tools.*`（至少能改 bash）。
- deny / auto-deny 时 reason 清晰（如 `permission denied: bash (ask, non-interactive)` / `blocked by user`）。
- 不要求完整 `/permissions` 专用命令（可选增强，非必须）。

## Acceptance Criteria

- [ ] **AC1** 默认配置下，TUI 中 `bash` 触发确认面板；`read_file` 等不触发。
- [ ] **AC2** Allow once 仅放行当前 tool call；同 turn 下一次 bash 再 ask。
- [ ] **AC3** Allow for this session 后，同进程后续 bash 不再 ask；重启后恢复 ask。
- [ ] **AC4** Deny 使该 tool call 以 block+reason 失败，turn 继续（模型可见拒绝）。
- [ ] **AC5** `--print` / `--mode json` 无 `--yes` 时，bash 被自动 deny，不执行命令。
- [ ] **AC6** `--yes` 下 bash 不再 ask/auto-deny，直接执行。
- [ ] **AC7** settings `permissions.tools.bash=deny` 时，即使 TUI 也不弹窗，直接 deny。
- [ ] **AC8** settings `permissions.tools.bash=allow`（global）时，TUI 不弹窗。
- [ ] **AC9** project settings 试图 `bash=allow` **不能**覆盖默认/global 的 `ask`（tighten-only）。
- [ ] **AC10** project 可将 `bash=deny` 收紧成功。
- [ ] **AC11** 用户 hook 对某工具 block 时，即使 permission allow，最终仍 block。
- [ ] **AC12** permission deny 时，用户 hook 无法改为 allow。
- [ ] **AC13** `/reload` 后磁盘 permissions 生效，session grants 仍保留。
- [ ] **AC14** `npm test` + `npm run typecheck` 通过；ARCHITECTURE / 相关 spec 更新。

## Out of Scope

- OS/container sandbox、workspace 路径边界（另任务）
- 参数级 policy DSL / 命令 regex allowlist
- 确认 UI 持久写入 Always 到 settings
- gateway per-channel 独立权限配置
- MCP / 自定义工具插件协议
- 专用 `/permissions` 命令（非必须）
- 其它 harness 缺口（分支导航、subagent 等）

## Non-Goals / Notes

- 这不是 sandbox；只是 tool execution 前的授权层。
- `--yes` 是 escape hatch，不是默认。
- 安全默认优先于「零摩擦」。
