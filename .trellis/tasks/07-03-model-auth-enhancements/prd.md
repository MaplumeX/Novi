# Model Auth Enhancements (custom provider, scoped models, transport, queue modes)

## Goal

在不引入 OAuth 订阅登录的前提下，补全 Novi 的模型与认证可配置性，使其在「自定义 provider/model、transport、scoped models、队列投递模式」四个维度达到与 pi 对齐的基线。

## Confirmed Facts (from code/SDK inspection)

- pi-ai 暴露 `createProvider(input: CreateProviderOptions)` 与 `MutableModels.setProvider(provider)`；`builtinModels(options?: CreateModelsOptions)` 返回 `MutableModels`。**pi-ai 不提供 models.json 加载器**——pi 的加载逻辑在 coding-agent 层，Novi 需自建。
- `AgentHarnessStreamOptions` 含 `transport?: Transport`（`"sse"|"websocket"|"websocket-cached"|"auto"`）、`timeoutMs?`/`maxRetries?`/`maxRetryDelayMs?`。`harness.setStreamOptions()` 已存在。当前 `bootstrap.ts` 仅在 settings.retry 存在时透传 retry 三字段，**从不透传 transport**。
- `QueueMode = "all" | "one-at-a-time"`。`harness.getSteeringMode()/setSteeringMode()`、`getFollowUpMode()/setFollowUpMode()` 存在；bootstrap 从未调用，走 harness 内部默认。
- 内置 provider 工厂示例（`anthropicProvider()`）用 `createProvider({id,name,baseUrl,auth:{apiKey: envApiKeyAuth(name, envVars)},models,api})` 构造；`envApiKeyAuth` 从 `@earendil-works/pi-ai/auth/helpers` 导出。
- Stream API 工厂：`anthropicMessagesApi()` / `openAICompletionsApi()` / `openAIResponsesApi()` / `mistralConversationsApi()` 等从 `@earendil-works/pi-ai/api/*.lazy` 导出，返回 `ProviderStreams`。`createProvider` 接受 `ProviderStreams` 或 `Partial<Record<TApi, ProviderStreams>>`。
- pi 的 models.json schema：`{ "providers": { "<id>": { baseUrl, api: KnownApi, apiKey: "<key or $VAR>", compat?, models: [{id,name?,reasoning?,input?,contextWindow?,maxTokens?,cost?}] } } }`，文件每次开 `/model` 时重新加载，无需重启。
- Novi `/model` 命令（`commands.ts`）已构建 flat model list（`for provider in getProviders() → getModels → getAuth` 过滤已配置 provider）；`ModelPicker.tsx` overlay 已存在。scoped models 只是在此基础上加一个「可循环子集」+热键。
- `commands.ts` 与 `App.tsx` 的 `ctx` 已持有 `models: Models`，可直接 `getModels()`/`getProviders()`。

## Requirements

### R1 自定义 provider/model（models.json）
- R1.1 加载 `~/.novi/models.json`（全局）与 `<cwd>/.novi/models.json`（项目，覆盖全局同名 provider）两层，解析为 provider 注册进 `MutableModels`（在 `builtinModels()` 之后 `setProvider`）。
- R1.2 schema 与 pi 兼容子集：provider 的 `id` / `baseUrl` / `api`（KnownApi 字面量）/ `apiKey`（字面量或 `$ENV_VAR` 插值）/ `models[]`（至少 `id`，可选 `name`/`reasoning`/`input`/`contextWindow`/`maxTokens`/`cost`）。
- R1.3 `apiKey` 支持 `$VAR` 形式 → 解析为该 env var 值；缺失则该 provider 视为未配置（`getAuth` 返回 undefined，`/model` 不展示其模型）。
- R1.4 文件每次进入 `/model`（或 Ctrl+P）时重新加载，无需重启（对齐 pi）。
- R1.5 解析失败降级为 stderr warning + 跳过该 provider，不阻塞启动（对齐 settings/resources 的降级原则）。
- R1.6 bootstrap 重建路径（`HarnessHandle.replace` 的 `replayHarnessState`）需复刻 custom providers（`/reload` 后仍生效）。

### R2 Transport 选择
- R2.1 settings 增 `transport?: "sse"|"websocket"|"websocket-cached"|"auto"`（全局/项目/cli）。
- R2.2 bootstrap 经 `harness.setStreamOptions({transport, ...retry})` 应用；`replayHarnessState` 复刻。
- R2.3 `/settings` 可查看与编辑 transport（带 provenance）。

### R3 队列投递模式
- R3.1 settings 增 `steeringMode?: "one-at-a-time"|"all"`、`followUpMode?: "one-at-a-time"|"all"`。
- R3.2 bootstrap 经 `harness.setSteeringMode()/setFollowUpMode()` 应用；`replayHarnessState` 复刻。
- R3.3 `/settings` 可查看与编辑（带 provenance）。

### R4 Scoped models 循环
- R4.1 settings 增 `scopedModels?: string[]`（`provider/id` 或 `provider/*` glob，逗号/数组）；CLI `--models <patterns>` 覆盖。
- R4.2 `Ctrl+P`（正向）/ `Shift+Ctrl+P`（反向）在 scoped 列表中循环，调用 `harness.setModel()`。
- R4.3 `/scoped-models` 命令：查看当前 scoped 列表，可增删条目（写入 settings.json）。
- R4.4 scoped 列表为空时，`Ctrl+P` 无操作（或提示）。

### R5 `--list-models [search]`
- R5.1 CLI `--list-models [search]`：列出所有已配置 provider 的模型（跨 provider），可选搜索过滤；不启动 harness/TUI，打印后 exit 0。

## Acceptance Criteria

- AC1 `~/.novi/models.json` 定义一个 `api:"openai-completions"` 的本地 provider（如 Ollama，`apiKey:"ollama"`），`/model` 能列出并切换到其模型；`models.getAuth()` 对其返回非 undefined。
- AC2 `transport: "websocket"` 写入 settings 后，`harness.getStreamOptions().transport === "websocket"`；改 `/settings` 切回 `sse` 后一致更新。
- AC3 settings `steeringMode:"all"` 后，连续两条 steer 消息一次性投递（通过 `getSteeringMode()==="all"` 与实际行为验证）。
- AC4 settings `scopedModels: ["anthropic/claude-*"]`，`Ctrl+P` 在匹配模型间循环切换且 `harness.getModel()` 跟随。
- AC5 `novi --list-models` 列出已配置 provider 的模型；`novi --list-models sonnet` 过滤命中。
- AC6 `/reload` 后 custom providers / transport / queue modes / scoped models 全部仍生效。
- AC7 `models.json` 解析失败 → stderr warning，启动继续，builtin providers 仍可用。
- AC8 lint + typecheck + 现有测试通过；新增逻辑有对应测试。

## Decisions

- **D1 models.json schema = 镜像 pi 子集**（用户已确认）：`{ "providers": { "<id>": { baseUrl, api: KnownApi, apiKey: "字面量 | $ENV_VAR", models: [{ id, name?, reasoning?, input?, contextWindow?, maxTokens?, cost? }] } } }`，两层加载，进 `/model` 重新加载。`compat.*` 兼容标志本轮不做（见 Out of Scope）。换来 pi models.json 双向兼容。
- **D2 scopedModels** 持久化到 settings.json（数组）+ `--models <patterns>` CLI flag；pattern 走 minimatch glob（项目已依赖），支持 `provider/*` 与 `provider/claude-*`。
- **D3 队列模式取值** `"one-at-a-time" | "all"`（SDK `QueueMode` 固定）。
- **D4 覆盖内置 provider**：允许 models.json 同名 provider override（`setProvider` upsert 语义天然支持），低成本顺带做。

## Out of Scope

- OAuth 订阅登录（`/login` `/logout`）。
- `models.json` 的 `compat.supportsDeveloperRole`/`supportsReasoningEffort` 等需在 stream 层适配的自定义兼容标志（仅支持 `createProvider`/stream 原生接受的字段）。
