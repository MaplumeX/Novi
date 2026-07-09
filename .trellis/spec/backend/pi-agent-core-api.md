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

### 枚举 provider 接受的 env var 名（findEnvKeys via compat）

`findEnvKeys(provider, env)` / `getEnvApiKey(provider, env)` **只从 `@earendil-works/pi-ai/compat` subpath 导出**（root `index` 和 `providers/all` 都不导出它们）。`compat` 是「临时兼容入口」（会在 coding-agent ModelManager 迁移后删除），但目前是唯一访问路径。

`findEnvKeys(provider, env)` 的语义是「返回**当前已设置**的 env var 名」，不是「provider 接受的所有 env var 名」。要枚举某 provider 接受的 env var 名（用于 onboarding 向导提示用户输入哪个变量），传一个「所有属性都返回 truthy」的 sentinel env：

```ts
import { findEnvKeys } from "@earendil-works/pi-ai/compat";
import type { ProviderEnv } from "@earendil-works/pi-ai";

const ALL_SET: ProviderEnv = new Proxy({}, { get: () => "x", has: () => true }) as ProviderEnv;
const accepted = findEnvKeys("anthropic", ALL_SET); // ["ANTHROPIC_OAUTH_TOKEN","ANTHROPIC_API_KEY"]
```

- 对于 ambient-only provider（如 `amazon-bedrock`、`google-vertex` 默认 ADC），`findEnvKeys` 返回 `undefined` —— 这些 provider 没有简单 env var key，向导应展示「请用 ambient 凭证（profile/ADC）手动配置」并跳过 key 录入。
- 不要把 provider→env-var 映射复制到 Novi 代码里——会随 pi-ai 漂移。始终用上述 sentinel trick 查询。

### 自定义 provider / models.json（loadCustomModels）

Novi 用 `~/.novi/models.json` + `<cwd>/.novi/models.json`（项目层，受 trust gate）定义 pi 兼容子集的自定义 provider。`pi-ai` **不提供** models.json loader；Novi 自建 `src/models-loader.ts`。

**关键 API 入口**（已验证公开可达）：
- `createProvider(input: CreateProviderOptions)` 与 `envApiKeyAuth(name, envVars)` 都从 **root `@earendil-works/pi-ai` 入口** 导出（`./auth/helpers` 和 `./models` 不是 package.json `exports` 暴露的 subpath，**不要直接 import `@earendil-works/pi-ai/auth/helpers`**）。
- Stream API 工厂从 `@earendil-works/pi-ai/api/*.lazy` subpath 导出（这是 exports 暴露的路径）：`anthropicMessagesApi` / `openAICompletionsApi` / `openAIResponsesApi` / `mistralConversationsApi` / `azureOpenAIResponsesApi` / `bedrockConverseStreamApi` / `googleGenerativeAIApi`（注意全大写 `IA`）/ `googleVertexApi` / `openAICodexResponsesApi`。
- `builtinModels()` 返回 `MutableModels`；`models.setProvider(provider)` upsert（同名 provider override builtin）。

`apiKey` 解析两种语义：
- `"$ENV_VAR"` → `envApiKeyAuth(name, [VAR])`：`getAuth()` 在 resolve 时读 env；var 未设置 → 返回 `undefined`（未配置，`/model` 不显示，对齐 pi）。
- 字面量（如 `"ollama"`）→ 自定义 resolver `literalApiKeyAuth()` 始终返回 `{auth:{apiKey: literal}}`（始终 configured）。**不要**用 `envApiKeyAuth` 传字面量 key——它只读 env var。

装配位置：`bootstrap()` 在 `builtinModels()` **之后** `loadCustomModels(env, cwd, {includeProject: trusted})`，逐个 `models.setProvider(p)`。`probeProviderConfigured`（onboarding）同样装配（受 trust gate，ask→never）。custom providers 不需 `replayHarnessState` 复刻——`replace` 复用同一个 `BootstrapResult.models` 实例，注册持久。

### transport / queue modes

- `AgentHarnessStreamOptions.transport?: Transport`（`"sse"|"websocket"|"websocket-cached"|"auto"`）由 `setStreamOptions` 一次调用与 retry 字段一起透传。`replayHarnessState` 在 `/new`/`/resume` 路径通过 `setStreamOptions(old.getStreamOptions())` 自动复刻；在 `/reload` 路径（传 `resolvedSettings`）从 settings 的 `retry.provider.*`/`transport` 重建（仅设置出现的字段，缺失字段从 old harness 重放）。
- `QueueMode = "all" | "one-at-a-time"`。`getSteeringMode()/setSteeringMode()` + `getFollowUpMode()/setFollowUpMode()` 存在；`replayHarnessState` 在 `/new`/`/resume` 路径需显式 `setSteeringMode(old.getSteeringMode())` + `setFollowUpMode(old.getFollowUpMode())`（不像 transport，它们不在 streamOptions 里）；在 `/reload` 路径从 settings 的 `steeringMode`/`followUpMode` 重解析（缺失时回退到 old harness）。bootstrap 在 settings 存在时调用对应 setter。

## AgentHarnessOptions 关键字段

需**同时**传 `models: Models` 和 `model: Model`：

```ts
new AgentHarness({ env, session, models, model, systemPrompt, /* optional: */ tools, resources, streamOptions, thinkingLevel, activeToolNames, steeringMode, followUpMode });
```

`systemPrompt`: `string | (ctx) => string | Promise<string>`，ctx = `{ env, session, model, thinkingLevel, activeTools, resources }`。

## 屯件事件联合（AgentEvent）

`agent_start` / `turn_start` / `message_start`{message} / `message_update`{message, assistantMessageEvent} / `message_end`{message} / `turn_end`{message, toolResults} / `agent_end`{messages}。

流式文本：`message_update` 中 `event.assistantMessageEvent.type === "text_delta"` → `.delta: string`。

### 多 turn run 中 `message_end`(assistant) 会多次触发

一次 `prompt` 触发的 run 可能包含多轮工具调用，因此会有多个 assistant `message_end` 事件（工具调用叙述 + 最终回复）。**不能直接把每个 `message_end`(assistant) 当作「run 结束」的信号**——否则下游会收到多条「最终文本」。正确做法是**缓冲最新 assistant 文本，在 `agent_end` 事件触发一次 `onTurnEnd`**，因为 `agent_end` 每次运行精确触发一次。网关 `event-bridge.ts` 正是这个模式：`message_end`(assistant) 只更新缓冲文本，`agent_end` 才调 `callbacks.onTurnEnd(bufferedText)`。

## 结构性操作需 idle

`prompt` / `skill` / `promptFromTemplate` / `compact` / `navigateTree` 需 `phase==="idle"`，否则抛 `AgentHarnessError("busy")`。`steer` / `followUp` / `nextTurn` / `abort` / runtime setters 可在 turn 中用。

即使 turn 出错，harness 经 `emitRunFailure` 仍发 `agent_end`，phase 必回 idle。

## `compact(customInstructions)` 与摘要 prompt 追加机制

`harness.compact(customInstructions?: string)` 是压缩入口，`customInstructions` 会透传给 core 的 `compact()` → `generateSummary()`，在 prompt 末尾以 `Additional focus: ${customInstructions}` 追加到 `SUMMARIZATION_PROMPT`（首次）或 `UPDATE_SUMMARIZATION_PROMPT`（增量）后面。这是**不改 pi-agent-core 源码**就能注入自定义摘要指令的唯一公开 API。

关键约束：
- `maybeCompact` 调用方**无法知道**是首次还是增量（`prepareCompaction` 在 core 内部判断是否有 `previousSummary`）。若要区分首次/增量指令，只能传组合指令让 LLM 根据 `<previous-summary>` 标签存在性自行判断。
- `generateTurnPrefixSummary`（split-turn 场景）**不接收 customInstructions**——只有主历史摘要 `generateSummary` 收到。turn prefix 本身是单个 turn 的前缀，用户消息在该 turn 起点已包含。
- 手动 `/compact`（`src/tui/commands.ts`）直接调 `harness.compact(args || undefined)`，**不经过 `AutoCompactor`**，用户 args 优先，不会自动叠加自动压缩的指令。两条路径独立。
- `session_before_compact` hook 返回 `{ compaction: CompactionResult }` 可完全跳过 `generateSummary`（core 的 `compact()` 里 `provided = hookResult?.compaction` 优先）。这是路径 ②/③（程序性 verbatim 保留）的扩展点。

## skill 开头/broadcast 为 compaction 事件

区分两类事件渠道，否则 TUI 看不到 compaction 就就出问题):

- `subscribe()` 订阅者收到 `AgentHarnessEvent` = `AgentEvent` ∪ `AgentHarnessOwnEvent`。可见的有 `session_compact`{compactionEntry, fromHook} 与 `session_tree`{newLeafId, oldLeafId, summaryEntry?, fromHook}。
- “before” 类事件 `session_before_compact` / `session_before_tree` 是 **hook** 事件，由 `emitHook()` 仅发给 `on(type)` 注册者，**不广播** 给 `subscribe()` 监听者。

后果：TUI 能看到 compact/tree “完成”，看不到“开始”。若 auto-compaction 是在 `settled` 事件后 fire-and-forget 触发，compact 期间的模型调用过程中 harness phase 是 `"compaction"`，但 TUI 仅在下一帧才 (如果有）才收到 `session_compact`——中间窗口如果用户提交 prompt 会被 harness 拒为 busy。做法：TUI 侧在调 `compact()` 前自行设 `state.phase="compaction"`，在 `session_compact` 上重置 idle。手动 `/compact` 命令因拿不到 setState 会留同类残留（接受）。

## setTools 与 activeToolNames 的非显然行为

`setTools(tools, activeToolNames?)` 在不传 `activeToolNames` 时 **沿用上一次的 activeToolNames**，而不是默认全部新工具 active。若 harness 构造时未传 `tools`/`activeToolNames`（初值为 `[]`），首次 `setTools(tools)` 不带第二参数会导致 **0 个工具 active**（注册了但全不可用）。

要默认全部 active，必须显式：
```ts
const tools = createBuiltinTools(env, sessionId);
await harness.setTools(tools, tools.map(t => t.name));
```

（源码确认：`setTools` 中 `const nextActiveToolNames = activeToolNames ? [...activeToolNames] : this.activeToolNames;`）

## bootstrap 拆分契约（prepareGatewayEnv + createHarnessForSession）

`bootstrap()` 原本一次性完成「env/credentials/settings/models/tools/resources 准备 + session/harness 创建」。多渠道网关任务将其拆成两层，支持 per-sessionKey 懒创建多个 harness，同时保持 TUI/print/json 路径的 `BootstrapResult` 契约不变。

- **`prepareGatewayEnv(options: BootstrapOptions): Promise<GatewayEnv>`**（一次）：步骤 1-4,6-8,11（env / credentials / settings / models+custom providers / systemPrompt provider / resources / hooks config / 派生的 streamOptions+steeringMode+followUpMode+thinkingLevel）。**不含** session/harness 创建。返回可复用的 `GatewayEnv`。
- **`createHarnessForSession(gatewayEnv, sessionKey): Promise<CreatedSession>`**（多次）：步骤 5,9-10,12-14（`repo.create({ cwd, id: uuidv7() })` → `new AgentHarness({ env, session, models, model, systemPrompt, thinkingLevel })` → `setTools(tools, tools.map(t => t.name))` → `setResources` → `registerHooks` → `setStreamOptions` → `setSteeringMode/setFollowUpMode`）。返回 `{ harness, session, sessionPath }`。
- **`bootstrap()`** 仍是 TUI/print/json 的唯一入口，内部委托 `prepareGatewayEnv` + `createHarnessForSession(env, "tui")`，返回值与历史完全一致。

### 关键约束

- `setTools` **必须显式传 `activeToolNames`**（见上「setTools 与 activeToolNames 的非显然行为」）。`createHarnessForSession` 每次都传 `tools.map(t => t.name)`。
- resume 路径（`options.resumePath`）仍由 `bootstrap()` 自己处理（`repo.open` + harness 装配），不走 `createHarnessForSession`。
- `GatewayEnv` 是「一次性准备结果」的载体，不含可变运行时状态；网关的 `NoviAgentAdapter` 持有它并在每个 sessionKey 上调用 `createHarnessForSession`。

### 网关侧 harness 多实例使用模式

网关一个进程内按 `channelId:chatId` 维护多个独立 `AgentHarness` 实例（`NoviAgentAdapter.sessions: Map<string, { harness, session }>`）。关键 API 映射：

- idle 时收到消息 → `harness.prompt(text)`（需 `phase==="idle"`，由 `session-lane` 的 per-sessionKey 串行保证）。
- 运行中收到消息，按 `queueMode`：`steer` → `harness.steer(text)`；`followup` → `harness.followUp(text)`；`interrupt` → `harness.abort()` 后重新 `prompt`。三者都可在 turn 中调用。
- 关闭 session → `harness.waitForIdle()` → 移除缓存。

> **网关层 vs harness 层队列模式是正交的**：harness 的 `steeringMode`/`followUpMode`（`"one-at-a-time"|"all"`）是 harness 内部队列交付模式；网关的 steer/followup/interrupt 是网关对「运行中收到新消息」的整体策略。两者分层独立。

## Harness 重建模式（HarnessHandle + replayHarnessState）

`AgentHarness` 无 session 热切 API（见上「Session 持久化」+ research/harness-session-swap.md）。
`/reload`（重载 settings/skills/prompts/contextFiles）和 `/new`/`/resume`（session 切换，
child 4）都**必须重建整个 `AgentHarness` 实例**。

### HarnessHandle 接口

Novi 在 `src/tui/harness-handle.ts` 定义可替换的 harness 句柄，`<App>` 持其为 React state：

```ts
export interface HarnessHandle {
  harness: AgentHarness;
  session: Session<JsonlSessionMetadata>;
  sessionPath: string;
  /** trust gate flag from bootstrap (cwd-scoped, not re-resolved on replace). */
  trusted: boolean;
  /** 重建 harness 并 setState。session 省略=复用当前(/reload)；传入=切换(/new//resume)。
   *  resolvedSettings 省略=从 old harness 重放 model/thinking/stream/queue（/new//resume）；
   *  传入=从 disk settings 重解析（/reload）。
   *  返回 { diagnostics } —— resource 加载警告 + model 重解析降级警告。 */
  replace: (next: ReplaceOptions) => Promise<{ diagnostics: string[] }>;
}

export interface ReplaceOptions {
  session?: Session<JsonlSessionMetadata>;
  sessionPath?: string;
  reloadResources?: boolean;
  resolvedSettings?: ResolvedSettings;
}
```

### replace 流程

```
1. await oldHarness.waitForIdle()     // 确保不在 turn 中
2. unsubscribe()                       // useHarnessState useEffect cleanup 自动做
3. session = next.session ?? old.session  // /reload 复用；/new /resume 传入新 session
4. new AgentHarness({ env, session, models, model: old.getModel(), systemPrompt })
5. const { diagnostics } = await replayHarnessState(
     newHarness, oldHarness, env, cwd, sessionMeta.id, models, opts)
6. setHandle(newHandle)                // 触发 useHarnessState 重订阅
7. return { diagnostics }              // 调用方逐条打印 warning
```

### replayHarnessState —— 全走 public getter

replay 不能读 harness 的 private `resources`/`tools` 字段。全部走 public getter：

```ts
export async function replayHarnessState(
  newHarness: AgentHarness,
  oldHarness: AgentHarness,
  env: ExecutionEnv,
  cwd: string,
  sessionId: string,
  models: Models,
  opts: { reloadResources?: boolean; trusted?: boolean; resolvedSettings?: ResolvedSettings } = {},
): Promise<{ diagnostics: string[] }> {
  const diagnostics: string[] = [];

  // 1. Tools: 重建 built-in set（传 sessionId 供 todo 分桶）+ 恢复 activeToolNames
  const tools = createBuiltinTools(env, sessionId);
  const activeToolNames = oldHarness.getActiveTools().map(t => t.name);
  await newHarness.setTools(tools, activeToolNames);  // ← 必须传 activeToolNames！

  if (opts.resolvedSettings) {
    // /reload path: 从 disk settings 重解析 model/thinking/stream/queue-modes
    const rs = opts.resolvedSettings;
    const model = models.getModel(rs.defaultProvider ?? DEFAULT_PROVIDER, rs.defaultModel ?? DEFAULT_MODEL_ID);
    if (model) await newHarness.setModel(model);
    else { await newHarness.setModel(oldHarness.getModel()); diagnostics.push(`model "…" not found; keeping current`); }
    await newHarness.setThinkingLevel(rs.defaultThinkingLevel ?? DEFAULT_THINKING_LEVEL);
    // streamOptions: 仅设置 settings 中出现的 retry/transport 字段，否则从 old harness 重放
    await newHarness.setStreamOptions(/* merged retry/transport or old.getStreamOptions() */);
    await newHarness.setSteeringMode(rs.steeringMode ?? oldHarness.getSteeringMode());
    await newHarness.setFollowUpMode(rs.followUpMode ?? oldHarness.getFollowUpMode());
  } else {
    // /new /resume path: 从 old harness 重放（保持当前运行时配置）
    await newHarness.setModel(oldHarness.getModel());
    await newHarness.setThinkingLevel(oldHarness.getThinkingLevel());
    await newHarness.setStreamOptions(oldHarness.getStreamOptions());
    await newHarness.setSteeringMode(oldHarness.getSteeringMode());
    await newHarness.setFollowUpMode(oldHarness.getFollowUpMode());
  }

  // 2. Resources: reload from disk 或 carry over
  if (opts.reloadResources) {
    const loaded = await loadResources(env, cwd, { includeProject: opts.trusted !== false });
    await newHarness.setResources({ skills: loaded.skills, promptTemplates: loaded.promptTemplates });
    diagnostics.push(...loaded.diagnostics);  // 不再静默丢弃
  } else {
    await newHarness.setResources(oldHarness.getResources());
  }

  return { diagnostics };
}
```

> **关键**：`setTools(tools)` 不传第二参数会沿用上一次的 `activeToolNames`（见上节），
> 但新 harness 初值为 `[]`，所以 replay **必须**显式传 `activeToolNames`，否则 0 个工具 active。
>
> `/reload`（传 `resolvedSettings`）重解析 model/thinking/stream/queue-modes；`/new`/`/resume`
> （不传）从 old harness 重放以保持当前运行时配置。`loadResources` 的 diagnostics 不再
> 丢弃，随返回值传回调用方打印。

### 递归闭包模式

`createHarnessHandle` 用递归闭包确保每次 `replace` 调用都引用自身所属的 handle：

```ts
function makeReplace(old: HarnessHandle): HarnessHandle["replace"] {
  return async (next) => {
    // ... rebuild, replay ...
    const newHandle: HarnessHandle = { harness: newHarness, session, sessionPath, replace: async () => {} };
    newHandle.replace = makeReplace(newHandle);  // ← 递归绑定
    setHandle(newHandle);
  };
}
```

### trust gate 与 harness 重建的交互

`HarnessHandle.trusted: boolean`（bootstrap 时写入）决定 `/reload`、`/new`、`/resume` 触发 `replace({reloadResources:true})` 时 `loadResources` 是否加载 project 层：

```ts
// harness-handle.ts replayHarnessState
if (opts.reloadResources) {
  const loaded = await loadResources(env, cwd, { includeProject: opts.trusted !== false });
  ...
}
```

- `/reload` 复用旧 `handle.trusted`（信任是 cwd 级，不随 session 变，replace 时不重新解析 trust）。
- 信任决策**不热重载**：`/trust` 只写 `trust.json`，下次启动才生效（镜像 pi）。运行中 session 的 settings/resources 已装配，半途切换 trust 会引入不可逆状态机复杂度。
- `BootstrapResult.trusted` 在 `createHarnessHandle` 初始化时传入；context files（AGENTS.md/SYSTEM.md/APPEND_SYSTEM.md）**始终加载**，不受 trust gate 影响。

### trust gate 在 bootstrap 装配中的位置

`bootstrap(options, { trusted })`（默认 `true` 向后兼容）把 `trusted` 透传给 `loadSettings`、`loadResources`、`loadCustomModels`（child 1）的 `includeProject` 选项。**probe 与 main 各解一次 trust**：
- `probeProviderConfigured`（onboarding）在 bootstrap 之前运行，是同步路径、无 overlay 能力，内部调 `resolveProjectTrust({isHeadless:true})`，`ask`→`never`（保守解，避免加载未信任的 project settings 探测 provider）。
- cli.ts main 流程在 probe 之后调一次完整 `resolveProjectTrust`：TUI 模式下 `ask` 且有 gated 资源 → 渲染独立 `TrustPrompt` overlay（renderApp 前，仿 OnboardingWizard），否则走 db decision / `defaultProjectTrust` / headless ask→never。
- 二者结果可能不同：probe 漏读 project settings 的 provider 配置 → 触发 onboarding（正确：不该用未信任配置）；信任后重启即可。

### useHarnessState 依赖

`useHarnessState(handle.harness, handle.session, compactionSettings)` 的 `useEffect` 依赖数组为 `[harness, session, compactionSettings]`。
当 `handle.replace` 调 `setHandle` 时，`handle.harness` identity 变化 → effect cleanup
（`unsubscribe()`）自动执行 → 新 effect 以新 harness 重订阅 + `reloadMessages()`。

`compactionSettings` 由 `App.tsx` 经 `useMemo(() => resolveCompactionSettings(settings), [settings])`
计算后传入。effect 开始时调 `compactor.setSettings(compactionSettings)` 同步注入 ——
`/reload` 后 settings state 变化 → compactionSettings 重算 → effect 重跑 → compactor 更新。

### 已验证的 public getter/setter

以下方法在 harness 重建场景中验证可用：

| 方法 | 用途 |
|------|------|
| `getModel()` | replay model |
| `getThinkingLevel()` | replay thinking |
| `getActiveTools()` | replay active tool names |
| `getResources()` | carry over resources |
| `getStreamOptions()` | replay stream options |
| `getSteeringMode()` | replay steering mode |
| `getFollowUpMode()` | replay follow-up mode |
| `setModel(model)` | set on new harness |
| `setThinkingLevel(level)` | set on new harness |
| `setTools(tools, activeToolNames?)` | set on new harness |
| `setResources(resources)` | set on new harness |
| `setStreamOptions(opts)` | set on new harness |
| `setSteeringMode(mode)` | set on new harness |
| `setFollowUpMode(mode)` | set on new harness |
| `waitForIdle()` | 确保不在 turn 中 |
| `subscribe(fn)` → `unsubscribe` | 事件订阅/重订阅（单向监听，不能返回 result） |
| `on(type, handler)` → `unsubscribe` | 注册 hook handler（可返回 result 影响流程） |

## hook 注册契约（on + emitHook）

`AgentHarness` 有两条独立的事件派发路径：

- **`subscribe(listener)`**：单向监听 `AgentHarnessEvent` 流（`agent_start`/`message_update`/`session_compact` 等），listener 不能返回 result。TUI/headless 用它渲染状态。
- **`on(type, handler)`**：注册 hook handler，**handler 返回 result 会影响流程**（阻断工具、改写结果、取消 compaction）。Novi 的用户可配置 hook 机制（`src/hooks/`）用它接入。

### `on(type, handler)` 签名（已正式声明）

`agent-harness.d.ts:91` 正式声明了带完整泛型类型签名的 `on()`：

```ts
on<TType extends keyof AgentHarnessEventResultMap>(
  type: TType,
  handler: (event: Extract<AgentHarnessOwnEvent, { type: TType }>) =>
    Promise<AgentHarnessEventResultMap[TType]> | AgentHarnessEventResultMap[TType],
): () => void;
```

**不需要类型断言**——`harness.on("tool_call", dispatcher)` 直接可用，TS 会按 `AgentHarnessEventResultMap["tool_call"] = ToolCallResult | undefined` 推断返回类型。

### emitHook 语义

core `emitHook(event)`（`agent-harness.js:178-194`）顺序执行该事件所有注册 handler，**最后一个返回非 undefined 的 result 胜出**，返回给 core 的 beforeToolCall/afterToolCall/compact 等调用点。handler 抛错会被 `normalizeHookError` 包装后 re-throw（会中断 turn）。

### 可 hook 事件与 result 类型

来自 `types.d.ts` 的 `AgentHarnessEventResultMap`：

| 事件 type | result 类型 | 能力 |
|---|---|---|
| `before_agent_start` | `BeforeAgentStartResult` | 可改 messages / systemPrompt |
| `context` | `ContextResult` | 可改 messages |
| `before_provider_request` | `BeforeProviderRequestResult` | 可 patch streamOptions |
| `before_provider_payload` | `BeforeProviderPayloadResult` | 可改 payload |
| `after_provider_response` | undefined | 只读 |
| `tool_call` | `ToolCallResult` | 可 block + reason |
| `tool_result` | `ToolResultPatch` | 可改写 content/details/isError/terminate |
| `session_before_compact` | `SessionBeforeCompactResult` | 可 cancel / 提供 compaction |
| `session_compact` | undefined | 只读通知 |
| `session_before_tree` | `SessionBeforeTreeResult` | 可 cancel / 改 summary |
| 其余（`model_update`/`settled`/`abort` 等） | undefined | 只读通知 |

core 派发给 hook handler 的事件字段（camelCase，来自 `agent-harness.js`）：
- `tool_call`：`{toolCallId, toolName, input}`
- `tool_result`：`{toolCallId, toolName, input, content, details, isError}`
- `before_agent_start`：`{prompt, images, systemPrompt, resources}`
- `session_before_compact`：`{preparation, signal}`

### Novi hook 机制（`src/hooks/`）

Novi 在 core `on()` 之上构建了用户可配置的脚本 hook 层：

- **配置**：`~/.novi/hooks/hooks.json`（用户层）+ `<cwd>/.novi/hooks/hooks.json`（项目层，受 trust gate）。schema 仿 Claude Code：`{ hooks: { <event>: [{ matcher?: string, hooks: [{ command, args?, timeoutMs? }] }] } }`。
- **加载**：`loadHooks(env, cwd, {includeProject: trusted})` 读两层 manifest，合并 matcher 组（user 在前，project 追加），未知事件名/非法 JSON/schema 不符 → diagnostic 警告（不阻塞）。
- **注册**：`registerHooks(harness, config, {env, cwd, sessionId}, options?)` 对每个事件调 `harness.on(type, dispatcher)`。dispatcher 闭包做 matcher 过滤 → spawn 脚本 → 解析 stdout → 转 core result。
- **`tool_call` 与 PermissionGate 显式 compose**：`options.permissionGate` 存在时，`tool_call` dispatcher 先 `await gate.onToolCall(event)`；若 `{block:true}` 则直接返回（跳过用户 hook）；否则跑用户 hook。Deny sticky：用户 hook 不能放行 permission deny；permission allow 后用户 hook 仍可 block。**不要**靠 `emitHook` last-wins 注册顺序实现权限。
- **IPC**：stdin = 事件 JSON（snake_case 字段 + `session_id`/`cwd`/`hook_event_name`）；stdout = `{ result: { ... } }`（snake_case，Novi 转 camelCase）；空 stdout + exit 0 = no-op；exit 2 = 阻断错误（`tool_call` 自动 `{block:true, reason:<stderr>}`）；默认 10s 超时（SIGTERM→500ms→SIGKILL）。
- **字段映射**：`field-mapping.ts` 用显式映射表（非通用转换），避免泄漏 `signal`/`resources`/`preparation.settings` 等内部字段给脚本。
- **MVP 暴露 4 事件**：`before_agent_start`/`tool_call`/`tool_result`/`session_before_compact`。`SUPPORTED_EVENTS` Set 控制白名单，扩展只需加成员。
- **harness 重建重放**：`replayHarnessState` 在 `/reload`/`/new`/`/resume` 时重新 `loadHooks` + `registerHooks`（handler 闭包绑定具体 harness 实例，无法跨实例 carry over）。try/catch 降级为 diagnostic，不阻塞重建。

## systemPrompt 回调约定

`AgentHarness` 构造参数 `systemPrompt` 可为 `string | (ctx) => string | Promise<string>`。
Novi 用回调形式（`makeSystemPromptProvider(cwd)`），每次 turn 重新组装 prompt。

### 拼接顺序（不可变约定）

```
[base, appendBlock, contextBlock, skillsBlock].filter(nonEmpty).join("\n\n")
```

1. **base**：`.novi/SYSTEM.md`(项目) → `~/.novi/SYSTEM.md`(全局) → `.novi/system-prompt.md`(兼容) → `~/.novi/system-prompt.md`(兼容) → `DEFAULT_SYSTEM_PROMPT`。取第一个非空，project > global > compat > default。
2. **appendBlock**：`.novi/APPEND_SYSTEM.md`(项目) + `~/.novi/APPEND_SYSTEM.md`(全局)。两层都存在则都追加（项目在前）。
3. **contextBlock**：AGENTS.md 候选路径（`~/.novi/AGENTS.md` + cwd 向上父目录各级 `AGENTS.md` + `<cwd>/AGENTS.md`），去重，顺序拼接。
4. **skillsBlock**：`formatSkillsForSystemPrompt(resources.skills)`。

> **注意**：base 是**替换**（取第一个非空），appendBlock/contextBlock/skillsBlock 是**追加**。
> SYSTEM.md 替换默认 prompt 但保留 append + context + skills 拼接。
