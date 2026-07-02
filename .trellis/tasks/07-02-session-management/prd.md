# B: session management (new/resume/name/session in-process)

## Goal

实现真正的 in-process 会话管理：`/new` 新建并切换 session、`/resume`(picker) 浏览并恢复历史 session、`/name` 命名 session、`/session` 查看当前 session 元信息。消除 child 1 之前的「quit 重启」stub。复用 child 1 产出的 `HarnessHandle.replace()` + `replayHarnessState()` 基础设施。

**依赖关系**：依赖 child 1（config-personalization）的 `HarnessHandle` + `replayHarnessState`。child 1 的 `/reload` 已验证 harness 重建流程，本 child 把同一机制用于 session 切换。

## Background — 已确认事实

### HarnessHandle（child 1 已实现）
- `HarnessHandle.replace({ session?, sessionPath?, reloadResources? })`：重建 harness + 重放状态 + 重绑订阅。
- `/reload` 已用 `replace({ reloadResources: true })`（复用当前 session）。
- session 切换：`replace({ session: newSession, sessionPath: newPath, reloadResources: true })`。

### 技术约束（见 parent research/harness-session-swap.md）
- `AgentHarness` 无 session 热切 API（session 为 private）。
- session 切换 = 重建 harness + 重放 + 重绑。child 1 已打通此流程。
- `/fork` `/clone` 不做（需自建 SessionManager 级 entry 复制层，成本过高，后置）。

### JsonlSessionRepo
- `repo.create({ cwd, id })` → 新 Session。
- `repo.open({ path } as JsonlSessionMetadata)` → 恢复 Session。
- sessions 存于 `~/.novi/sessions/<encodeCwd(cwd)>/<timestamp>_<id>.jsonl`。

### session 命名
- pi：`/name <name>` 写 session metadata 的 displayName，影响 `/resume` 列表 + StatusBar。
- Novi 的 `JsonlSessionMetadata` 支持 name 字段吗？需在实现时检查 `session.setMetadata` / metadata 形状——若不支持，命名只存内存（不持久化）或扩展 metadata。

## Requirements

### R1 `/new` 新建并切换
- `/new`：确认（可选）→ `repo.create({ cwd, id: uuidv7() })` → `handle.replace({ session, sessionPath, reloadResources: true })`。
- 切换后 TUI 显示空消息列表（新 session 无历史）。
- 确认提示（可选）：若当前 session 有未保存对话，提示「Start a new session?」——简化为直接切换（session 已落盘，不丢）。

### R2 `/resume` picker
- `/resume`：打开 session picker（列表形式，复用 Ink 渲染，非 overlay——或作为 overlay 变体）。
- 列出 `sessionsDir` 下按 mtime 倒序的 session 文件（复用 `listSessionFiles`，已在 commands.ts）。
- 显示：文件名（或 session name 若有）/ mtime / 消息数（若易取）。
- `↑`/`↓` 选；`Enter` → `repo.open({ path })` → `handle.replace({ session, sessionPath })`；`Esc` 取消。
- 切换后 TUI 重载新 session 的 branch messages。

### R3 `/name <name>`
- 设置当前 session 的显示名。
- 持久化到 session metadata（若 `JsonlSessionMetadata` 支持则写盘；否则在内存维护 + 影响当前会话展示）。
- 影响：`/resume` 列表显示名、StatusBar（可选显示名）、`/session`。

### R4 `/session`
- 显示当前 session 元信息：file path / id / message count / (name 若有) / (tokens/cost 若 child 7 已做——本 child 只显示 file/id/count)。
- `session.getMetadata()` 拿 path；`session.getBranch()` 拿 entries count。

### R5 session 切换后状态正确
- harness 重建后：model/thinking/tools/resources 从旧 harness 重放（`replayHarnessState` 已做）。
- messages 从新 session 的 branch 重载（`useHarnessState` 依赖 `handle.session` 变化触发 reload）。
- sessionPath 显示更新。
- 事件订阅不泄漏（child 1 已验证的 R1）。

## Acceptance Criteria

- [ ] `/new` 创建新 session 并切换，TUI 显示空消息列表，sessionPath 更新。
- [ ] `/resume` 打开 picker，列出历史 session（含 mtime），↑↓ 选择，Enter 切换，Esc 取消。
- [ ] `/resume` 切换后 TUI 显示所选 session 的历史消息。
- [ ] `/name <name>` 设置 session 显示名，`/resume` 列表与 `/session` 反映新名。
- [ ] `/session` 显示 file path / id / message count。
- [ ] session 切换后发消息事件只触发一次（订阅不泄漏）。
- [ ] session 切换后 model/thinking/tools 保持（重放正确）。
- [ ] `tsc --noEmit` + `eslint` + `vitest` 全绿。

## Out of Scope

- `/fork` `/clone`（后置，需 SessionManager 级 entry 复制）。
- session 删除（后置）。
- 跨 cwd 的 session 浏览（sessions 按 cwd 编码，本 child 只列当前 cwd 的）。

## Technical Notes

- 详细设计见 child 4 的 `design.md`：session picker 渲染（overlay vs 命令输出）、name 持久化路径、/resume 列表数据结构。
- 本 child 的 `implement.md` 给出文件改动清单 + 验证命令。
