# Research: AgentHarness session-swapping capability

## Question

B 主题（in-process `/new` `/resume` `/fork` `/clone`）依赖会话切换。
`AgentHarness` 是否原生支持切换/替换 session？

## Method

读取 `node_modules/@earendil-works/pi-agent-core/dist/harness/agent-harness.d.ts`
（已确认与运行时 `agent-harness.js` 对应的公开类型）。

## Finding

`AgentHarness` **无** session 切换 API：

- `session` 为 `private` 字段，无 public setter / getter（只有 `session` 入参在 constructor）。
- 公开方法里没有 `setSession` / `switchSession` / `newSession` / `fork` / `clone`。
- 有 `navigateTree`（分支内切换 leaf，不改 session 文件）、`compact`、`appendMessage`，
  但这些都是「同一 session 内」的操作。

可用公开能力：
- `subscribe()` 返回 unsubscribe——TUI 可解绑再重绑。
- `setModel` / `setTools` / `setActiveTools` / `setResources` / `setThinkingLevel`
  / `setStreamOptions` / `setSteeringMode` / `setFollowUpMode`——重建后需重放。
- `abort()` + `waitForIdle()`——切换前需先确保 idle。
- `JsonlSessionRepo`（`create` / `open`）——可独立建/开任意 session 文件。

## Implication for B (session management)

in-process session 切换 **必须重建整个 `AgentHarness`**：

1. 确认当前 harness idle（`waitForIdle`）。
2. `unsubscribe()` 解绑旧 harness 的事件订阅。
3. 用 `JsonlSessionRepo.create/open` 得到新 `Session`。
4. `new AgentHarness({...})` 新建一个 harness（复用旧 env / models / systemPrompt provider）。
5. 在新 harness 上重放状态：`setTools` + `setActiveTools` + `setResources` + `setModel` + `setThinkingLevel`。
6. TUI hook `useHarnessState` 重新以新 harness + 新 session 订阅事件、重载 `getBranch()`。
7. 更新 `sessionPath` 展示。

即：harness 不支持「热切」，需要 TUI/App 层持有一个可替换的 harness 句柄
（而非把 harness 直接传死给 `<App>`）。这把当前 `App` props 形态（harness 直接传入并固化）
变成「stateful harness holder」——是 B child 的核心设计改动。

`/fork`（从某 entry 之前分叉到新 session）与 `/clone`（复制当前 branch 到新 session），
pi 通过其自研 SessionManager 的高级方法实现；
Novi 只有 `JsonlSessionRepo` + `Session.getEntries/getBranch`，
fork/clone 需要：读旧 session 的 branch entries → 选择切点 → 新 session 里
append 对应 messages。**`/fork` `/clone` 实现成本明显高于 `/new` `/resume`**，
可考虑本轮只做 `/new` `/resume` `/name` `/session`，fork/clone 后置或留作 stretch。

## Source

- `node_modules/@earendil-works/pi-agent-core/dist/harness/agent-harness.d.ts`
（class `AgentHarness` 公开签名）
- 当前 Novi 代码：`src/bootstrap.ts`（harness 构造路径）、`src/tui/App.tsx`
（harness 直接作为 props 传入并固化）
