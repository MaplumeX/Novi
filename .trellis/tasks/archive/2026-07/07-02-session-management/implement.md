# Implement — B: session management

## 文件改动清单

| 文件 | 动作 | 内容 |
|------|------|------|
| `src/tui/SessionPicker.tsx` | 新增 | session picker overlay 组件 |
| `src/tui/App.tsx` | 改 | Overlay 加 sessionPicker 变体；rendering 分支；onPick/onCancel |
| `src/tui/commands.ts` | 改 | `/new`（repo.create + handle.replace）/ `/resume`（list + setOverlay）/ `/name`（持久化）/ `/session`（info 输出）；替换现有 stub |

## 执行步骤

### 1. SessionPicker.tsx
- `SessionInfo` 类型 + 列表渲染 + useInput（↑↓/Enter/Esc）。
- props: `{ sessions, onPick, onCancel }`。
- **validation**: `tsc --noEmit` 绿。

### 2. /new 命令
- `repo.create({ cwd, id: uuidv7() })` → `handle.replace({ session, sessionPath: meta.path, reloadResources: true })`。
- 替换现有 stub。
- **validation**: 手测 `/new` 切换 + 空消息列表 + sessionPath 更新。

### 3. /resume 命令 + overlay
- `listSessionFiles` → `setOverlay({ kind: "sessionPicker" })`。
- App onPick → `repo.open({ path })` → `handle.replace(...)` → `setOverlay(null)`。
- **validation**: 手测 `/resume` 列表 + 选择 + 恢复历史消息。

### 4. /name 命令
- 检查 `JsonlSessionMetadata` 是否有 name 字段。
- 有 → 写盘（`session.setMetadata` 或 repo.update）；无 → HarnessHandle 内存 `sessionName`。
- **validation**: 手测 `/name foo` + `/session` 反映 + `/resume` 列表反映。

### 5. /session 命令
- 输出 file/id/messages/name。
- `session.getMetadata()` + `session.getBranch()`/`getEntries()`。
- **validation**: 手测 `/session`。

### 6. 全量验证
- `npx tsc --noEmit` / `npx eslint .` / `npx vitest run`。
- 手测集成：/new + /resume + /name + /session + 切换后发消息事件不泄漏 + model/thinking 保持。

## risky 文件

- `src/tui/App.tsx`：第三个 overlay 变体，渲染分支增多。Step 3 后手测 overlay 切换。
- session 切换的 handle.replace：若 replace 流程有 bug 会导致状态丢失。Step 2-3 后手测 + 验证订阅不泄漏。

## 完成判据（见 prd AC）

全部 AC 勾选 + tsc/eslint/vitest 三绿。
