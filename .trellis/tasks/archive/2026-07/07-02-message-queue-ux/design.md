# Design — C2: message queue UX

> child 3 细化设计。复用 child 2 的 InputBox cursor 模型 + child 1 的 useHarnessState queue 投影。

## 边界

| 产出 | 文件 |
|------|------|
| steer/followUp 快捷键 + Esc-restore + Alt+Up | 改 `src/tui/InputBox.tsx` + `src/tui/App.tsx` |
| queue restore 逻辑 | 改 `src/tui/App.tsx`（读 state.queue） |
| 可选 `/queue` 命令 | 改 `src/tui/commands.ts` |

## 快捷键路由（InputBox useInput）

现有 InputBox 已有 EditorState + Emacs 键位。新增：

```
turn 中（phase === "turn"）:
  Enter (无 shift)        → submit() 走 steer 路径
  Alt+Enter / Meta+Enter  → submit() 走 followUp 路径
  Escape                 → abort + restore

idle 中:
  Enter                  → submit() 走 prompt（不变）
  Alt+Enter              → submit() 走 prompt（简化，不区分）
  Escape                 → 清空编辑器（现有）

compaction 中:
  Enter / Alt+Enter / Esc → 不响应

Alt+Up（任意 phase，queue 非空时）:
  → 取 queue 末尾预览到编辑器
```

### submit 改造

```ts
function submit(mode: "prompt" | "steer" | "followUp"): void {
  const text = state.text.trim();
  if (!text) return;
  setState(reset(state));  // 清空
  if (mode === "prompt") onPrompt(text);          // idle
  else if (mode === "steer") onSteer(text);       // turn
  else if (mode === "followUp") onFollowUp(text); // turn
}
```

InputBox 新增 props: `onSteer`, `onFollowUp`。

App 层：
```ts
const onSteer = (text) => harness.steer(text).catch(e => print(`Steer failed: ${e.message}`));
const onFollowUp = (text) => harness.followUp(text).catch(e => print(`FollowUp failed: ${e.message}`));
```

submit 路由（由 phase 决定 mode）：
```ts
// InputBox 内
if (key.return) {
  if (key.shift) { setState(insertNewLine(state)); return; }
  if (key.alt || key.meta) { submit("followUp"); return; }  // Alt+Enter
  if (phase === "turn") { submit("steer"); return; }
  if (phase === "idle") { submit("prompt"); return; }
  // compaction: no-op
  return;
}
```

## Escape abort + restore

### 流程

```
1. (turn 中 Escape)
2. 读 state.messagesRef / state.queue：收集 queued steer[] + followUp[] 的文本内容
3. harness.abort()
4. 等 agent_end（phase 回 idle）—— harness.abort 返回 AbortResult
5. 把 queued 内容 restore 到编辑器：若多条，换行拼接；若 0 条，编辑器保留原未发送文本
6. 若编辑器原本也有未发送内容，拼在 restore 内容之后
```

### 实现

App 层提供 `onEscapeAbort()`：
```ts
const onEscapeAbort = async () => {
  if (state.phase !== "turn") {
    // idle: clear editor
    setEditorState({ text: "", cursor: 0 });
    return;
  }
  const queuedTexts = [
    ...state.queue.steer.map(m => messageText(m)),
    ...state.queue.followUp.map(m => messageText(m)),
  ];
  await harness.abort();
  // abort 后 harness 回 idle，queue_update 会清空 queue
  // restore: 把 queued 文本拼到编辑器
  setEditorState(prev => {
    const restored = queuedTexts.join("\n");
    const combined = restored ? (prev.text ? `${restored}\n${prev.text}` : restored) : prev.text;
    return { text: combined, cursor: combined.length };
  });
};
```

`messageText(m)`：从 AgentMessage 提取 plain text（复用 commands.ts 已有的 `messagePreview` 逻辑，或下沉到 shared helper）。

InputBox 把 Escape 事件调 `onEscapeAbort()`。

## Alt+Up 预览

### 语义

queue 是 harness 内部管理的，无 dequeue API。Alt+Up 只做「取末尾预览」：

```ts
const onAltUp = () => {
  const all = [...state.queue.steer, ...state.queue.followUp, ...state.queue.nextTurn];
  if (all.length === 0) { print("Queue is empty."); return; }
  const last = all[all.length - 1];
  const text = messageText(last);
  setEditorState({ text, cursor: text.length });
};
```

> 限制（写进 AC + /help）：Alt+Up 不从 harness queue 真正移除，harness 仍会投递该消息。若用户编辑后重发，会产生重复。用户需理解这是「取回编辑」而非「撤销排队」。若需真正撤销，只能 abort 整轮。

## /queue 命令（可选，易实现）

```
/queue → 列出 steer/followUp/nextTurn 各队列的消息文本预览（前 80 字符）
```

## 测试范围（vitest 单测）

- `submit` 路由（phase × 按键 → mode）—— 但 submit 在组件内，测纯逻辑部分（如 `pickSubmitMode(phase, key)` 纯函数）。
- `messageText` 提取（若下沉为纯函数则测）。
- restore 拼接逻辑（纯函数 `restoreText(queuedTexts, currentText)`）。

TUI/集成（手测）：steer/followUp/abort+restore/Alt+Up 实际跑一轮对话验证。
