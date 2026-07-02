# Implement — C2: message queue UX

## 文件改动清单

| 文件 | 动作 | 内容 |
|------|------|------|
| `src/tui/InputBox.tsx` | 改 | submit 路由（phase × 按键 → prompt/steer/followUp）；Esc 调 onEscapeAbort；Alt+Up 调 onAltUp；新增 props onSteer/onFollowUp/onEscapeAbort/onAltUp |
| `src/tui/App.tsx` | 改 | onSteer/onFollowUp/onEscapeAbort/onAltUp 实现；messageText 下沉或复用 |
| `src/tui/queue-helpers.ts` | 新增（可选） | `messageText` / `restoreText` 纯函数 |
| `src/tui/queue-helpers.test.ts` | 新增（可选） | 纯函数单测 |
| `src/tui/commands.ts` | 改 | `/queue` 命令（列出 queue 内容预览） |

## 执行步骤

### 1. queue-helpers 纯逻辑 + 单测
- `messageText(message: AgentMessage): string`（从 commands.ts 的 messagePreview 下沉，提 plain text）。
- `restoreText(queuedTexts: string[], currentText: string): string`（拼接 queued + 保留 current）。
- 单测覆盖。
- **validation**: `npx vitest run src/tui/queue-helpers.test.ts` 绿。

### 2. InputBox submit 路由
- 改 submit 签名收 mode（prompt/steer/followUp）。
- useInput：Enter（无 shift）依 phase 路由（turn→steer, idle→prompt, compaction→noop）；Alt+Enter→followUp（turn）或 prompt（idle）。
- Escape：turn→onEscapeAbort；idle→清空。
- Alt+Up：onAltUp。
- 新增 props：onSteer, onFollowUp, onEscapeAbort, onAltUp。
- **validation**: `tsc --noEmit` 绿；手测 turn 中 Enter 走 steer。

### 3. App.tsx 接 steer/followUp/abort-restore/Alt+Up
- onSteer/onFollowUp 调 harness.steer/followUp + catch。
- onEscapeAbort：读 state.queue steer+followUp 文本 → abort → restore 到 editor。
- onAltUp：取 queue 末尾 messageText 到 editor。
- 传新 props 给 InputBox。
- **validation**: 手测 steer/followUp/Escape-restore/Alt+Up 全流程。

### 4. /queue 命令
- 列出 steer/followUp/nextTurn 各队列消息预览。
- **validation**: 手测 `/queue`。

### 5. 全量验证
- `npx tsc --noEmit`
- `npx eslint .`
- `npx vitest run`
- 手测集成：turn 中 steer + followUp + Escape abort+restore + Alt+Up + StatusBar 计数。

## risky 文件

- `src/tui/InputBox.tsx`：submit 路由改动影响所有提交路径。Step 2 后手测 idle Enter 仍正常（无回归）。
- `src/tui/App.tsx`：abort 异步 + restore 时序。Step 3 后手测 abort 后 editor 内容正确。

## 完成判据（见 prd AC）

全部 AC 勾选 + tsc/eslint/vitest 三绿。
