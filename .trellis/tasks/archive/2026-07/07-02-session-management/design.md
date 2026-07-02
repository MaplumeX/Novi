# Design — B: session management

> 复用 child 1 的 HarnessHandle.replace + replayHarnessState。本文件细化 child 4 独有部分。

## 边界

| 产出 | 文件 |
|------|------|
| `/new` `/resume` `/name` `/session` 命令 | 改 `src/tui/commands.ts` |
| session picker（overlay 变体） | 改 `src/tui/App.tsx` + 新 `src/tui/SessionPicker.tsx` |
| session name 持久化 | 改 `src/tui/harness-handle.ts`（metadata 写入）或命令层 |

## session picker 方案

### Overlay 变体

```ts
type Overlay =
  | null
  | { kind: "settings" }
  | { kind: "filePicker"; ... }
  | { kind: "sessionPicker" };
```

`/resume` → `setOverlay({ kind: "sessionPicker" })`。SessionPicker 组件 own `useInput`（↑↓/Enter/Esc）。

### SessionPicker 组件（src/tui/SessionPicker.tsx）

- props: `{ sessions: SessionInfo[]; onPick(session); onCancel() }`
- `SessionInfo`：`{ name?: string; path: string; mtime: Date; messageCount?: number }`。
- 渲染：带 cursor 高亮的列表（文件名/mtime/消息数）。
- `↑`/`↓` 移 cursor；`Enter` → `onPick(selected)`；`Esc` → `onCancel()`。

### 数据加载

`/resume` 命令时调 `listSessionFiles(sessionsDir)`（已有）+ 读每个文件的消息数（可选，`session.getBranch().length` 需 open——成本高）。简化：picker 只显示文件名 + mtime（消息数后置或留空）。

## /new 流程

```ts
// commands.ts /new
const cwd = ctx.cwd;
const repo = new JsonlSessionRepo({ fs: ctx.env, sessionsRoot: ctx.sessionsDir });
const session = await repo.create({ cwd, id: uuidv7() });
const meta = await session.getMetadata();
await ctx.handle.replace({ session, sessionPath: meta.path, reloadResources: true });
ctx.print(`New session: ${meta.path}`);
```

## /resume 流程

```
1. /resume 命令 → listSessionFiles → setOverlay({ kind: "sessionPicker" })
2. 用户选 → onPick(sessionInfo)
3. repo.open({ path: sessionInfo.path })
4. handle.replace({ session, sessionPath, reloadResources: true })
5. setOverlay(null)
```

## /name 持久化

### metadata 形状检查

`JsonlSessionMetadata` 是否有 name 字段？实现时需检查 `session.setMetadata` 或 repo 的 metadata 写入 API。

- 若 `JsonlSessionMetadata` 有 `name?: string`：写盘。
- 若无：在 HarnessHandle 层维护 `sessionName: string | undefined`（内存），影响 `/session` + `/resume` 列表（但重启后丢失）。
- 实现时优先尝试写盘；若 API 不支持，降级内存 + 注释。

## /session 输出

```
Session:
  file: /path/to/session.jsonl
  id: <uuid>
  messages: N
  name: <name if set>
```

`session.getMetadata()` 拿 path；`session.getBranch()` 或 `getEntries()` 拿 count。

## CommandContext 扩展

child 1 已加 `handle`/`env`/`cwd`。本 child 用 `ctx.handle`/`ctx.env`/`ctx.sessionsDir`。`/resume` 需 `setOverlay`（已有）。

## 测试范围

- `/new`/`/resume`/`/name`/`/session` 逻辑涉及 harness 重建 + session repo，难纯单测。
- 可单测：`SessionInfo` 列表排序、`/session` 输出格式化函数。
- 集成手测：/new 切换 + /resume 恢复 + /name 命名 + /session 显示。
