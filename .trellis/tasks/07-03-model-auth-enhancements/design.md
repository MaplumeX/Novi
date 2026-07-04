# Design — Model Auth Enhancements

> 关联 PRD: `07-03-model-auth-enhancements/prd.md`
> 涉及层：backend (`src/` 根: bootstrap / settings / models-loader / onboarding) + frontend (`src/tui`: commands / App / ModelPicker / SettingsForm / TrustPrompt)

## 1. 目标与非目标重述

补全四块（B/C/D/E）+ `--list-models`，**不碰 OAuth**。核心是把 pi-ai 已暴露但 Novi 未接的能力（`MutableModels.setProvider` / `AgentHarnessStreamOptions.transport` / `setSteeringMode,setFollowUpMode`）与 settings 打通，并自建一个 pi 兼容的 `models.json` loader。

## 2. 架构边界

```
src/
  models-loader.ts          ← NEW: ~/.novi/models.json + <cwd>/.novi/models.json → Provider[]
  settings.ts               ← 扩字段: transport / steeringMode / followUpMode / scopedModels / defaultProjectTrust（child2亦用）
  bootstrap.ts              ← 接 loader + transport + queue modes + scopedModels 透传
  onboarding.ts             ← probeProviderConfigured 也走带 custom provider 的 models 解析
  tui/
    commands.ts             ← /model 每次重新构建 list（已如此）；新增 /scoped-models, /trust(child2)
    App.tsx                 ← Ctrl+P / Shift+Ctrl+P 绑定 + scopedModels state
    scoped-models.ts        ← NEW: pattern matching + 循环索引计算
    SettingsForm.tsx        ← 编辑 transport/steeringMode/followUpMode/scopedModels/defaultProjectTrust
```

**依赖方向不变**：`models-loader.ts` 只依赖 `ExecutionEnv` + pi-ai 公开 API (`createProvider`, `envApiKeyAuth`, api 工厂)，绝不引用 TUI / harness 内部。`replayHarnessState` 走 public getter/setter 的现状保持。

## 3. 数据流与契约

### 3.1 models.json → Provider 映射

`loadCustomModels(env, cwd): { providers: Provider[], diagnostics: string[] }`

文件 schema（pi 镜像子集）:
```jsonc
{
  "providers": {
    "<id>": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",          // KnownApi 字面量
      "apiKey": "ollama" | "$OPENAI_API_KEY",
      "name"?: "Ollama",
      "models": [
        { "id": "llama3.1:8b", "name"?, "reasoning"?, "input"?: ("text"|"image")[], "contextWindow"?, "maxTokens"?, "cost"?: {input,output,cacheRead,cacheWrite} }
      ]
    }
  }
}
```

加载：
1. 按 `{globalPath, projectPath}` 顺序读，两个Provider map合并；**同名 provider project override global**（`setProvider` upsert 语义天然支持，故 project 后注册）。
2. 对每个 provider：
   - `apiKey` 解析：形如 `$VAR` → `process.env[VAR]`（缺失 → 该 provider 仍注册但 `getAuth()` 返回 undefined，`/model` 自然不展示）；其余字面量透传。
   - `api` 字面量 → 对应 api 工厂（`openai-completions`→`openAICompletionsApi()`，`openai-responses`→`openAIResponsesApi()`，`anthropic-messages`→`anthropicMessagesApi()`，`mistral-conversations`→`mistralConversationsApi()`）。未知 api → diagnostic + 跳过该 provider。
   - `models[]` → 映射为 `Model<Api>` 对象（`id`/`name`/`reasoning`/`input`/`contextWindow`/`maxTokens`/`cost` 直接拷贝；`api` 字段取 provider 的 `api`）。
   - 构造 `createProvider({ id, name, baseUrl, headers, auth: { apiKey: literalOrEnvKey ? envApiKeyAuth(name,[envVar]) : { apiKey: literalKey } }, models, api })`。
     - 注意：novi 的 credentials.json 注入已发生在 bootstrap 早期，env var 已就位；`envApiKeyAuth` 在 getAuth 时读 env。字面量 apiKey 直接用 `{ apiKey: <literal> }` 形式（AuthResult 直接视为 configured）。
3. 解析失败降级：文件缺失→空列表；JSON 非法/根非对象→diagnostic + 空列表；单 provider 字段非法→跳过该 provider + diagnostic。**永不抛出**。对齐 settings/resources 降级原则。

### 3.2 bootstrap 装配顺序

`bootstrap()` 当前在第 5 步 `builtinModels()`。改动后：
```
models = builtinModels()                        // 内置
customProviders = loadCustomModels(env, cwd)    // ← NEW
for (p of customProviders.providers) models.setProvider(p)
// diagnostics → stderr warning（同 settings/resources）
... resolveModel(models, provider, modelId)     // 现有逻辑不变
```

### 3.3 transport / queue modes / scopedModels → harness

bootstrap 接 `resolvedSettings` 后（在 setTools 之后、return 之前）：
```ts
// transport + retry（现有 retry 块扩展）
const retryProv = resolvedSettings.retry?.provider;
const transport = resolvedSettings.transport;
if (retryProv || transport) {
  await harness.setStreamOptions({
    ...(transport !== undefined ? { transport } : {}),
    ...(retryProv?.timeoutMs !== undefined ? { timeoutMs: retryProv.timeoutMs } : {}),
    ...(retryProv?.maxRetries !== undefined ? { maxRetries: retryProv.maxRetries } : {}),
    ...(retryProv?.maxRetryDelayMs !== undefined ? { maxRetryDelayMs: retryProv.maxRetryDelayMs } : {}),
  });
}
// queue modes
if (resolvedSettings.steeringMode) await harness.setSteeringMode(resolvedSettings.steeringMode);
if (resolvedSettings.followUpMode) await harness.setFollowUpMode(resolvedSettings.followUpMode);
```

scopedModels 不进 harness，进 `BootstrapResult.scopedModels`（App.tsx 消费）。

### 3.4 replayHarnessState 复刻

`harness-handle.ts` 的 `replayHarnessState` 当前步骤 3 是 `setStreamOptions(oldHarness.getStreamOptions())`——**transport 自动复刻**（getStreamOptions 已含 transport）。queue modes：新增 `setSteeringMode(old.getSteeringMode())` + `setFollowUpMode(old.getFollowUpMode())`。custom providers 不需 replay（`models` 实例在 replace 时复用同一个 `BootstrapResult.models`，provider 注册持久）。scopedModels 在 App side，replace 不动它。

## 4. Settings schema 扩展

```ts
export interface NoviSettings {
  // ... 现有 ...
  transport?: "sse" | "websocket" | "websocket-cached" | "auto";
  steeringMode?: "one-at-a-time" | "all";
  followUpMode?: "one-at-a-time" | "all";
  scopedModels?: string[];                       // glob patterns
  defaultProjectTrust?: "ask" | "always" | "never";   // child 2 用
}
```

`resolveSettings` 新增这几项的 provenance（沿用现有 `global|project|cli|default` 模式，无嵌套对象，简单拷贝 + 源判定）。`cli` 层扩展：`--transport`, `--steering-mode`, `--follow-up-mode`, `--models`（逗号分隔 → string[]），`--list-models [search]`。

## 5. TUI / Scoped Models

### 5.1 scoped-models.ts
```ts
export function matchScopedModels(patterns: string[], entries: {provider:string,id:string}[]): {provider,id}[]
export function nextScopedIndex(current: number, len: number, reverse: boolean): number
```
pattern 用 `minimatch`（项目已依赖 `minimatch@^10`），格式 `provider/id` 或 `provider/*`。匹配当前已配置 provider 的模型全集。

### 5.2 App.tsx Ctrl+P 绑定
- `Ctrl+P`: 若 `scopedModels.length>0`，取当前 `harness.getModel()` 在 scoped list 中的索引 → `nextScopedIndex` → `setModel(scoped[next])`。命中空 → 不操作 + 临时 notice「no scoped models」。
- `Shift+Ctrl+P`: 同上 reverse。
- scoped list 在 `renderApp` 接收 `BootstrapResult.scopedModels` 时一次性计算；`/settings` 改动后写入 settings，但需 `/reload` 才生效（对齐 pi「adjust via /settings + reload」）。

### 5.3 /scoped-models 命令
- 无参：列出当前 scopedModels + 匹配到的模型名。
- `/scoped-models add <pattern>` / `remove <pattern>` / `clear`：写 settings.json scopedModels。提示 `/reload` 生效。

## 6. `--list-models [search]`

`cli.ts` 早期分支：若 `--list-models` → bootstrap 轻量装配（env + creds + settings + models（含 custom providers））→ `models.getProviders()` 遍历 `getModels()` + `getAuth()` 过滤已配置 → 打印 `provider/id  name` 行 → exit 0。search 子串过滤 id/name。**不创建 session、不启动 harness/TUI**。复用 `onboarding.ts` 的 `probeProviderConfigured`-style env 装配但只取 models 部分。

## 7. Compatibility / Migration

- 现有 settings.json 无新字段 → 走 SDK 默认（不调 setStreamOptions 的 transport / 不调 queue mode setter / scopedModels=空 → Ctrl+P 无效），行为与当前完全一致。
- 现有无 models.json → `loadCustomModels` 返回空列表，无影响。
- `/model` 命令无需改动（已动态查 `getProviders/getModels/getAuth`），custom provider 自然进入列表。

## 8. Tradeoffs

- **不实现 `compat` 字段**：`supportsDeveloperRole`/`supportsReasoningEffort` 需要 stream payload 改写层，超出本轮。pi 用户迁来时这些字段被忽略 + stderr warning（forward-compat）。
- **`apiKey` env 插值仅 `$VAR` 单一形式**（不做 `${VAR:-default}` 嵌套），与 pi 一致。
- scopedModels 用 minimatch glob 而非正则，对齐 pi 的 `--models` 语义。

## 9. Rollback

纯新增 + settings 字段扩展，无破坏性 schema 变更。回滚 = 删除新增文件 + 还原 settings 字段 + 还原 cli flag。无 session 数据迁移。
