# pi-agent-core / pi-ai 公开 API 契约

> 在 Novi 项目中实例化 `AgentHarness` 时验证过的实际公开 API。
> 源：child 1 `scaffold-harness` 实现时核对安装的 `@earendil-works/pi-agent-core@0.80.3` / `@earendil-works/pi-ai@0.80.3` 的 `.d.ts`。
> 原始偏差记录：`.trellis/tasks/07-01-scaffold-harness/research/api-deviations.md`。

## Node-only 入口

`NodeExecutionEnv` 从 **`@earendil-works/pi-agent-core/node`** 导入，**不是** root 入口：

```ts
import { NodeExecutionEnv, AgentHarness, JsonlSessionRepo, uuidv7 } from "@earendil-works/pi-agent-core/node";
```

`AgentHarness` / `JsonlSessionRepo` / `uuidv7` 也从 `/node` 入口导出，与 root 入口共享全部 core 导出。root 入口不含 `NodeExecutionEnv`。

## Session 持久化

**`JsonlSessionStorage` 不是公开导出**（仅在 `dist/harness/session/jsonl-storage.js` 内部）。使用公开的 `JsonlSessionRepo`：

```ts
const repo = new JsonlSessionRepo({ fs: env, sessionsRoot });
// 新建：repo 内部计算路径 <sessionsRoot>/<encodeCwd(cwd)>/<timestamp>_<id>.jsonl
const session = await repo.create({ cwd, id: uuidv7() });
// 恢复：repo.open 只读 metadata.path
const session = await repo.open({ path } as JsonlSessionMetadata);
```

`NodeExecutionEnv` 实现 `FileSystem`（`ExecutionEnv extends FileSystem`），可直接传 `fs`。session 文件落在 `<sessionsRoot>/<encoded-cwd>/...jsonl`，不是直接 `<sessionsRoot>/<id>.jsonl`。

## Models 与 provider key

`createModels()` 返回空 provider 集合。provider 的 env-key 自动读取挂在各 provider 工厂里。使用 `builtinModels()`：

```ts
import { builtinModels } from "@earendil-works/pi-ai/providers/all"; // subpath export
const models = builtinModels(); // 内部 createModels() + 注册全部内置 provider
```

anthropic provider 读 `ANTHROPIC_API_KEY` / `ANTHROPIC_OAUTH_TOKEN`（经 `envApiKeyAuth` + `defaultAuthContext` 读 `process.env`）。

检测未配置 provider：用公开 `models.getAuth(model)`（返回 `undefined` 即未配置，无网络调用）。

## AgentHarnessOptions 关键字段

需**同时**传 `models: Models` 和 `model: Model`：

```ts
new AgentHarness({ env, session, models, model, systemPrompt, /* optional: */ tools, resources, streamOptions, thinkingLevel, activeToolNames, steeringMode, followUpMode });
```

`systemPrompt`: `string | (ctx) => string | Promise<string>`，ctx = `{ env, session, model, thinkingLevel, activeTools, resources }`。

## 屯件事件联合（AgentEvent）

`agent_start` / `turn_start` / `message_start`{message} / `message_update`{message, assistantMessageEvent} / `message_end`{message} / `turn_end`{message, toolResults} / `agent_end`{messages}。

流式文本：`message_update` 中 `event.assistantMessageEvent.type === "text_delta"` → `.delta: string`。

## 结构性操作需 idle

`prompt` / `skill` / `promptFromTemplate` / `compact` / `navigateTree` 需 `phase==="idle"`，否则抛 `AgentHarnessError("busy")`。`steer` / `followUp` / `nextTurn` / `abort` / runtime setters 可在 turn 中用。

即使 turn 出错，harness 经 `emitRunFailure` 仍发 `agent_end`，phase 必回 idle。

## skill 开头/broadcast 为 compaction 事件

区分两类事件渠道，否则 TUI 看不到 compaction 就就出问题):

- `subscribe()` 订阅者收到 `AgentHarnessEvent` = `AgentEvent` ∪ `AgentHarnessOwnEvent`。可见的有 `session_compact`{compactionEntry, fromHook} 与 `session_tree`{newLeafId, oldLeafId, summaryEntry?, fromHook}。
- “before” 类事件 `session_before_compact` / `session_before_tree` 是 **hook** 事件，由 `emitHook()` 仅发给 `on(type)` 注册者，**不广播** 给 `subscribe()` 监听者。

后果：TUI 能看到 compact/tree “完成”，看不到“开始”。若 auto-compaction 是在 `settled` 事件后 fire-and-forget 触发，compact 期间的模型调用过程中 harness phase 是 `"compaction"`，但 TUI 仅在下一帧才 (如果有）才收到 `session_compact`——中间窗口如果用户提交 prompt 会被 harness 拒为 busy。做法：TUI 侧在调 `compact()` 前自行设 `state.phase="compaction"`，在 `session_compact` 上重置 idle。手动 `/compact` 命令因拿不到 setState 会留同类残留（接受）。

## setTools 与 activeToolNames 的非显然行为

`setTools(tools, activeToolNames?)` 在不传 `activeToolNames` 时 **沿用上一次的 activeToolNames**，而不是默认全部新工具 active。若 harness 构造时未传 `tools`/`activeToolNames`（初值为 `[]`），首次 `setTools(tools)` 不带第二参数会导致 **0 个工具 active**（注册了但全不可用）。

要默认全部 active，必须显式：
```ts
const tools = createBuiltinTools(env);
await harness.setTools(tools, tools.map(t => t.name));
```

（源码确认：`setTools` 中 `const nextActiveToolNames = activeToolNames ? [...activeToolNames] : this.activeToolNames;`）
