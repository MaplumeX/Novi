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
  /** 重建 harness 并 setState。session 省略=复用当前(/reload)；传入=切换(child 4)。 */
  replace: (next: ReplaceOptions) => Promise<void>;
}
```

### replace 流程

```
1. await oldHarness.waitForIdle()     // 确保不在 turn 中
2. unsubscribe()                       // useHarnessState useEffect cleanup 自动做
3. session = next.session ?? old.session  // /reload 复用；/new /resume 传入新 session
4. new AgentHarness({ env, session, models, model: old.getModel(), systemPrompt })
5. await replayHarnessState(newHarness, oldHarness, env, cwd, { reloadResources })
6. setHandle(newHandle)                // 触发 useHarnessState 重订阅
```

### replayHarnessState —— 全走 public getter

replay 不能读 harness 的 private `resources`/`tools` 字段。全部走 public getter：

```ts
export async function replayHarnessState(
  newHarness: AgentHarness,
  oldHarness: AgentHarness,
  env: ExecutionEnv,
  cwd: string,
  opts: { reloadResources?: boolean } = {},
): Promise<void> {
  // 1. Tools: 重建 built-in set + 恢复 activeToolNames（从 old.getActiveTools()）
  const tools = createBuiltinTools(env);
  const activeToolNames = oldHarness.getActiveTools().map(t => t.name);
  await newHarness.setTools(tools, activeToolNames);  // ← 必须传 activeToolNames！

  // 2. Model + thinking level
  await newHarness.setModel(oldHarness.getModel());
  await newHarness.setThinkingLevel(oldHarness.getThinkingLevel());

  // 3. Stream options (timeout/retry)
  await newHarness.setStreamOptions(oldHarness.getStreamOptions());

  // 4. Resources: reload from disk 或 carry over
  if (opts.reloadResources) {
    const loaded = await loadResources(env, cwd);
    await newHarness.setResources({ skills: loaded.skills, promptTemplates: loaded.promptTemplates });
  } else {
    await newHarness.setResources(oldHarness.getResources());
  }
}
```

> **关键**：`setTools(tools)` 不传第二参数会沿用上一次的 `activeToolNames`（见上节），
> 但新 harness 初值为 `[]`，所以 replay **必须**显式传 `activeToolNames`，否则 0 个工具 active。

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

`useHarnessState(handle.harness, handle.session)` 的 `useEffect` 依赖数组为 `[harness, session]`。
当 `handle.replace` 调 `setHandle` 时，`handle.harness` identity 变化 → effect cleanup
（`unsubscribe()`）自动执行 → 新 effect 以新 harness 重订阅 + `reloadMessages()`。

### 已验证的 public getter/setter

以下方法在 harness 重建场景中验证可用：

| 方法 | 用途 |
|------|------|
| `getModel()` | replay model |
| `getThinkingLevel()` | replay thinking |
| `getActiveTools()` | replay active tool names |
| `getResources()` | carry over resources |
| `getStreamOptions()` | replay stream options |
| `setModel(model)` | set on new harness |
| `setThinkingLevel(level)` | set on new harness |
| `setTools(tools, activeToolNames?)` | set on new harness |
| `setResources(resources)` | set on new harness |
| `setStreamOptions(opts)` | set on new harness |
| `waitForIdle()` | 确保不在 turn 中 |
| `subscribe(fn)` → `unsubscribe` | 事件订阅/重订阅 |

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
