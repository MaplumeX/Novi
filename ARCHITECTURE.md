# Novi 架构文档

> Novi 是一个基于 TypeScript ESM 的 Agent harness + TUI，构建在 `@earendil-works/pi-agent-core` 与 `@earendil-works/pi-ai` 之上，使用 Ink (React 终端 UI) 渲染交互界面、支持 headless 模式。

---

## 1. 技术栈与运行环境

| 维度 | 选择 |
| --- | --- |
| 语言 / 模块系统 | TypeScript, ESM (`module: Node16`, `moduleResolution: Node16`, `strict`) |
| 运行时 | Node.js ≥ 22.19 |
| 构建 | `tsc` → `dist/`；开发期 `tsx src/cli.ts` |
| 核心 SDK | `@earendil-works/pi-agent-core ^0.80.3`（AgentHarness / Session / JsonlSessionRepo / `on()` 钩子注册）、`@earendil-works/pi-ai ^0.80.3`（Models / Model / API / `createProvider` / `envApiKeyAuth` / lazy API 工厂） |
| 终端 UI | Ink 7 + React 19 |
| Markdown | `marked` + 自渲染 token (`tui/markdown/render-token.tsx`) |
| Schema | `typebox`（工具参数定义） |
| 路径匹配 | `minimatch`（scoped-models glob 匹配 `provider/id`） |
| 正文提取 | `@mozilla/readability` + `linkedom`（`fetch_content` 工具提取网页正文） |
| 其他依赖 | `ignore`、`yaml` |
| 自定义 providers | `~/.novi/models.json` + `<cwd>/.novi/models.json` → pi-ai `createProvider` / `envApiKeyAuth` |
| 生命周期钩子 | `~/.novi/hooks/hooks.json` + `<cwd>/.novi/hooks/hooks.json` → 子进程 IPC，经 `AgentHarness.on()` 注册 |
| 项目信任 | `~/.novi/trust.json`（cwd/parent 精确匹配，0600） |
| 持久化 | 纯文件系统（JSONL session / JSON settings / 文件型 skills & prompts / trust.json / models.json / hooks.json / cache/web/），无数据库 |
| 测试 | Vitest（与源码并置 `*.test.ts`） |
| Lint / 格式化 | ESLint flat config + Prettier |
| 项目管理 | Trellis（`.trellis/`，spec / tasks / workspace） |

入口包名 `novi`，`bin: "dist/cli.js"`。

---

## 2. 顶层架构分层

Novi 是单体仓库（single-package），但代码逻辑上分三层：

```
┌─────────────────────────────────────────────────────────────┐
│  Entry  (src/cli.ts)                                        │
│  parseArgs → 凭证探测 → 信任门 → bootstrap / onboarding → 渲染│
└─────────────────────────────────────────────────────────────┘
            │
   ┌────────┴─────────┐
   ▼                  ▼
┌─────────────┐  ┌──────────────────────────────────────────┐
│ Backend Core│  │              TUI (src/tui)                │
│ (src/ 根)   │  │  App.tsx → useHarnessState → MessageList │
│ bootstrap/  │  │  InputBox / Commands / Overlays          │
│ config/     │  │  theme / components / markdown           │
│ tools/      │  │  ModelPicker / TrustPrompt / Onboarding  │
│ resources/  │  └──────────────────────────────────────────┘
│ compaction/ │
│ settings/   │   ┌──────────────────────────────────────────┐
│ credentials │   │       Headless (src/headless)            │
│ trust/      │   │  run: print 模式 / json JSONL 流         │
│ models-     │   │  events: 事件投影到可序列化结构            │
│  loader/    │   │  stdin: 管道输入合并                       │
│ hooks/      │   └──────────────────────────────────────────┘
│ permissions/│
└──────┬──────┘
       │
       ▼
┌─────────────────────────────────────────────────────────────┐
│  pi-agent-core (外部依赖，不可修改)                          │
│  AgentHarness (subscribe + on() 钩子注册) + NodeExecEnv     │
│  + JsonlSessionRepo / Session (分支化 JSONL 持久化)         │
│  + pi-ai Models + builtinModels() + createProvider/Auth    │
└─────────────────────────────────────────────────────────────┘

**依赖方向**：`cli → bootstrap → {tools, resources, settings, credentials, compaction, trust, models-loader, hooks, permissions}` 与 `cli → {tui/headless}`。TUI/headless 只通过 `AgentHarness` 公共 API（`subscribe/prompt/steer/abort/compact/on()/...`）与核心交互，绝不直接读写 session JSONL 存储内部。`trust`/`models-loader`/`hooks`/`permissions` 只依赖 `ExecutionEnv` + node stdlib + pi-ai 公共 API（TuiApprover 除外，由 TUI 注入），不引用 harness 内部。

---

## 3. 启动流程 (cli.ts → bootstrap.ts)

```
cli.ts
 ├─ parseArgs(provider/model/thinking/cwd/resume/print/mode/approve/
 │            no-approve/yes/transport/steering-mode/follow-up-mode/
 │            models/list-models/help)
 ├─ --list-models [search]?  ← 轻量路径：env+creds+settings+custom providers → 打印后 exit
 ├─ probeProviderConfigured()      ← 凭证探测：合并 settings + 凭证注入 + custom providers → models.getAuth()
 │    ├─ 保守解析 trust（ask→never），project 层仅在 trusted 时加载
 │    ├─ 未配置 & headless   → 打印指引并 fail
 │    └─ 未配置 & TUI       → renderOnboardingWizard(bootstrapOptions) 引导式写入凭证/settings 后自行 bootstrap
 ├─ --- 项目信任门 ---
 │    loadTrust + hasGatedResources(settings/skills/prompts/models.json)
 │    ├─ 未 gated         → trusted=true，继续
 │    ├─ decision=always  → trusted=true
 │    ├─ decision=never   → trusted=false
 │    ├─ decision=ask & headless → trusted=false（ask→never）
 │    └─ decision=ask & TUI   → renderTrustPrompt(cwd) → once/always/never/abort
 │        （always/never 经 saveTrust 持久化；abort → exit 0）
 ├─ bootstrap({ ...bootstrapOptions, trusted, yes, approver? })
 │    1. new NodeExecutionEnv({ cwd, shellEnv: process.env })
 │    2. loadCredentials + injectCredentialsIntoEnv  ← 仅填充 env 中 undefined 的键
 │    3. ensureDir(~/.novi, ~/.novi/sessions)
 │    4. loadSettings(env, cwd, { includeProject: trusted }) → resolveSettings(merged, layers, cliOverrides)
 │       + resolvePermissionsFromSettings(layers, { yes })  ← defaults←global←project(tighten-only)←--yes
 │    5. new JsonlSessionRepo({ fs, sessionsRoot }) → repo.create() / repo.open(resumePath)
 │    6. builtinModels() + loadCustomModels(env, cwd, { includeProject: trusted })
 │       → models.setProvider(p) 注册自定义 providers（同 id 覆盖 built-in）
 │    7. resolveModel(models, provider, modelId)  ← 校验 provider/model/auth
 │    8. makeSystemPromptProvider(cwd)  ← 闭包：base + append + AGENTS.md + skills 块
 │    9. new AgentHarness({ env, session, models, model, systemPrompt, thinkingLevel })
 │   10. setTools(createBuiltinTools(env, session.id), 全部 name)
 │   11. setResources({ skills, promptTemplates })  ← loadResources(env, cwd, { includeProject: trusted })
 │   12. loadHooks + registerHooks(harness, config, { env, cwd, sessionId })  ← trust 门作用于 project 层
 │   13. setStreamOptions(retry.* + transport)  ← 仅在 settings 配置存在时透传
 │   14. setSteeringMode / setFollowUpMode  ← 队列交付模式，settings 配置时生效
 ├─ 返回 BootstrapResult（含 trusted、scopedModels）
 └─ 分发：
      - --print         → runPrint(result, prompt)
      - --mode json      → runJson(result, prompt)
      - (default)        → renderApp(result, sessionsDir)
```

**BootstrapResult 的关键契约**：除了 `harness/env/models/model/session/sessionPath`，还回传 `systemPrompt`（重建 harness 时复用）、`resolvedSettings` 与 `cliOverrides`（供 `/settings`、`/reload` 再解析）、`env`/`cwd`、`trusted`（项目层资源是否加载，传给 `HarnessHandle` 用于 `/reload` 时复用 trust 决策）以及 `scopedModels`（来自 `resolvedSettings.scopedModels`，用于 Ctrl+P 模型循环）。这一点很重要 —— `App.tsx` 与 `HarnessHandle.replace()` 都依赖这些闭包原料，而不是再次走 `bootstrap()`。

---

## 4. Backend Core（`src/` 根非 TUI 部分）

### 4.1 config.ts
纯路径解析：`getNoviDir() = ~/.novi`，`getSessionsDir() = ~/.novi/sessions`。无状态、无 IO。

### 4.2 bootstrap.ts
启动装配器（见 §3）。包含 `resolveModel()`（provider/model 校验 + auth 检查，给用户清晰错误）、`makeSystemPromptProvider(cwd)` 与 systemPrompt 工厂。负责按 `trusted` 门控加载 settings / resources / custom providers / hooks，并透传 `transport`/`steeringMode`/`followUpMode` 到 harness。

### 4.3 settings.ts
两层 (`~/.novi/settings.json` 全局 + `<cwd>/.novi/settings.json` 项目) 浅合并；失败降级为空层 + stderr 警告，绝不阻塞启动。`resolveSettings` 计算 `_sources` provenance（`global|project|cli|default`），供 `/settings` UI 显示每项来源。`loadSettings` 接受 `{ includeProject }` —— untrusted 时跳过项目层文件，其值不能影响 provider 解析或合并结果。

**优先级**：CLI flag > project > global > 内置默认。

**已知字段**：`defaultProvider`/`defaultModel`/`defaultThinkingLevel`/`compaction.*`/`retry.provider.*`/`defaultProjectTrust`（全局 fallback，非 CLI）/`transport`/`steeringMode`/`followUpMode`/`scopedModels`。`writeSettings(env, path, patch)` 以点路径 patch（如 `"compaction.enabled"`）浅合并写入现有 JSON，`null`/`undefined` 删除键，供 `/settings` 与 `/scoped-models` 使用。

### 4.4 credentials.ts
API key 物理隔离于 `~/.novi/credentials.json`（不混进 settings.json，避免误截图泄漏）。
- `loadCredentials`：丢失/损坏 → `{}`，不抛错。
- `writeCredentials`：浅合并 + `chmod 0600`（失败忽略，非致命）。
- `injectCredentialsIntoEnv`：**只填充 env 中 undefined 的键** —— 用户显式 export 的值永远胜出；空串视为已设置（用户明确清空）。

### 4.5 resources.ts
从 `~/.novi` 与 `<cwd>/.novi` 两层加载 skills（`loadSourcedSkills`）与 prompt templates（`loadPromptTemplates`）。skills 按 name 去重，**project 覆盖 user**；prompt templates 不去重。加载器跳过非法文件并收集 diagnostics，绝不抛错。`loadResources` 接受 `{ includeProject }` —— untrusted 时只扫描用户层目录。

### 4.6 trust.ts
项目信任门，控制是否加载 `<cwd>/.novi/` 下的 gated 资源（`settings.json` / `skills` / `prompts` / `models.json`）。持久化于 `~/.novi/trust.json`（0600），值为 `always`|`never`，`ask` 为默认不落盘。

- `loadTrust`：丢失/损坏 → `{}` + stderr warning，不抛错。
- `resolveProjectTrust(cwd, db, opts)`：优先级 `--approve` > `--no-approve` > **cwd 或最近父目录的 db 条目**（从 cwd 向上走，首个命中胜出） > `defaultProjectTrust`（默认 `ask`） > headless+ask → `never`。
- `hasGatedResources`：探测 `<cwd>/.novi/` 是否含任一 gated 文件/目录，无则不触发门。
- `saveTrust`：`always` 写 cwd **及直接父目录**（镜像 pi：信任向上传播一级），`never` 只写 cwd；浅合并到现有 db，best-effort `0600`。

`/trust` 命令只读/写入 trust.json，不影响当前运行时（重启或 `/reload` 后生效）。

### 4.7 models-loader.ts
从 `~/.novi/models.json`（全局）与 `<cwd>/.novi/models.json`（项目，trust 门控）加载自定义 providers，schema 镜像 pi 的 models.json 子集：`{ providers: { "<id>": { baseUrl, api, apiKey: "literal"|"$VAR", name?, headers?, models: [...] } } }`。`compat` 字段解析但不消费（前向兼容）。

- **API 工厂**：`api` literal 映射到 pi-ai lazy 工厂（`openai-completions`/`openai-responses`/`anthropic-messages`/`mistral-conversations`/`azure-openai-responses`/`openai-codex-responses`/`bedrock-converse-stream`/`google-generative-ai`/`google-vertex`）。未知 api → diagnostic + skip。
- **apiKey 解析**：`"$ENV_VAR"` → `envApiKeyAuth(name, [VAR])`（`getAuth()` 在 resolve 时读 env，缺失 → unconfigured，`/model` 隐藏）；literal → 始终配置的小 resolver；省略 → `envApiKeyAuth(name, [])` 永不配置。
- **合并**：project 同 id provider 覆盖 global（两列表拼接，后注册者经 `setProvider` upsert）。
- **降级**：文件缺失 → 空；解析失败/根非 object → diagnostic + 空；per-provider 校验失败 → skip 该 provider + diagnostic。绝不抛错。

### 4.8 hooks/
用户/项目可配置的生命周期钩子，在 agent 事件点 spawn 子进程脚本。由 `loader.ts` + `registry.ts` + `runner.ts` + `field-mapping.ts` 组成。

- **支持的 event**（`SUPPORTED_EVENTS`）：`before_agent_start` / `tool_call` / `tool_result` / `session_before_compact`。未知 event → per-event diagnostic + skip。
- **manifest**（`hooks.json`）：`{ hooks: { <event>: HookMatcherGroup[] } }`，每个 group = `{ matcher?, hooks: [{ command, args?, timeoutMs? }] }`。`matcher` 仅对 `tool_call`/`tool_result` 生效：`undefined`/`"*"`/`""` 匹配全部，`"A|B"` 精确匹配 A 或 B，否则精确匹配。其余 event 忽略 matcher。
- **加载**（`loader.ts`）：从 `~/.novi/hooks/hooks.json`（user）与 `<cwd>/.novi/hooks/hooks.json`（project，trust 门控）读入；同 event 的 matcher groups 追加合并（user 先 project 后），不 dedup/override。失败降级为 diagnostic，绝不抛错。
- **注册**（`registry.ts`）：每个 event 注册一个 dispatcher 闭包到 `harness.on(type, dispatcher)`。dispatcher 按 manifest 顺序过滤 matcher group、运行匹配脚本，返回 **最后一个非 undefined 的结果**（匹配 core `emitHook` “last non-undefined wins”）。`on()` 是 fully-typed 公共方法，无需 type assertion。
- **`tool_call` 与 PermissionGate 显式 compose**（见 §4.11）：当 `registerHooks(..., { permissionGate })` 时，`tool_call` dispatcher 先跑 gate，deny 则直接 block 并**跳过**用户 hook；allow 后再跑用户 hook（用户仍可 block）。Deny sticky，不依赖注册顺序 last-wins。
- **执行**（`runner.ts`）：`spawn` 子进程，stdin 喂 event JSON，按 exit code 分支：
  - exit 0：读 stdout，空 → undefined（no-op）；非空 → `JSON.parse` → `.result` → `toCoreResult`（snake_case→camelCase）。parse 失败/缺 `.result` → undefined + stderr warning。
  - exit 2：blocking error。`tool_call` → `{ block: true, reason }`（reason 取 stderr 或默认）；其他 event → undefined + warning。
  - 其他非 0：脚本失败 → undefined + stderr warning。
  - timeout（`timeoutMs ?? 10000`）：SIGTERM → 500ms grace → SIGKILL；undefined + warning。
  - harness 永不被脚本崩溃，所有错误降级为 warning + no-op。
- **字段映射**（`field-mapping.ts`）：每个 event 有显式 allow-list，core camelCase ↔ hook snake_case。内部字段（`resources`/`signal`/`preparation.settings` 等）绝不泄漏给脚本。stdin 始终含 `session_id`/`cwd`/`hook_event_name`。

### 4.9 permissions/
内置工具权限控制：静态策略 + TUI 交互确认。默认 `bash=ask`，其余工具隐式 `allow`。

| 文件 | 职责 |
| --- | --- |
| `types.ts` | `PermissionLevel` / `Approver` / `ApprovalChoice` |
| `policy.ts` | defaults、global override、project **tighten-only** merge、`--yes` ask→allow |
| `gate.ts` | `PermissionGate` + `SessionPermissionStore`；`NonInteractivePermissionGate`（headless fail-closed） |
| `summary.ts` | 工具参数摘要（bash→command，write/edit→path） |
| `tui-approver.ts` | 队列化 TUI Approver（once/session/deny；abort→denyAll） |
| `index.ts` | 公共导出 |

**策略解析**：`DEFAULT { bash: ask }` ← global.permissions.tools（按工具覆盖）← project.permissions.tools（**只能收紧**：severity `allow=0 < ask=1 < deny=2`，project 仅当 severity ≥ current 才接受）← CLI `--yes`（所有 `ask`→`allow`）。

**运行时**：`PermissionGate.onToolCall` — session grant → level resolve → deny block / allow pass / ask→Approver。Session grant 按工具名进程内记忆，不落盘；`/reload` 重解析磁盘 permissions 但**保留** store。

**与用户 hooks**：`registerHooks` 显式 compose（gate 先；gate deny 跳过用户 hook；gate allow 后用户仍可 block）。

**CLI**：`--yes` = ask→allow（本 run escape hatch）；**不是** `--approve`（project trust）。二者互不替代、可并存。

**Headless / gateway**：无 UI → `NonInteractivePermissionGate`，ask 自动 deny，reason 含 `pass --yes to allow`。

**TUI**：`PermissionPrompt` overlay — Allow once / Allow for this session / Deny；Esc=Deny；确认期间 phase 保持 `turn`。

### 4.10 compaction.ts
`AutoCompactor`：`settled` 事件 → `maybeCompact`（每 3 轮 debounce）→ `decideShouldCompact`(token 估算 vs contextWindow)→ `harness.compact()`。`onStart` 回调让 UI 翻转 phase 为 `compaction`，`session_compact` 事件后翻回 `idle` 并 reload 分支。

compaction settings 消费 `settings.json` 的 `compaction.{enabled, reserveTokens, keepRecentTokens}` 字段，而非硬编码 `DEFAULT_COMPACTION_SETTINGS`。`resolveCompactionSettings(resolved: NoviSettings)` 以 `DEFAULT_COMPACTION_SETTINGS` 为底，逐字段用 `resolved.compaction?.*` 覆盖（部分配置不丢默认）。`AutoCompactor` 构造接受 `initialSettings`，持有可变 settings 并通过 `setSettings()` 更新；`maybeCompact` 内 `enabled === false` → 直接 return false（不 compact），`reserveTokens`/`keepRecentTokens` 阈值字段经 `shouldCompact` 生效。`useHarnessState` 经 `useMemo(() => resolveCompactionSettings(settings), [settings])` 计算后作为第三参数传入，effect 依赖数组含 `compactionSettings`，effect 内 `compactor.setSettings(...)` 同步更新 —— `/reload` 后 settings state 变化 → compactionSettings 重算 → effect 重跑 → compactor 更新。

### 4.11 tools/
10 个内置工具，每个文件一个 `createXxxTool(env: ExecutionEnv): AgentTool`，全部经由 `tools/index.ts` 的 `createBuiltinTools(env, sessionId)` 聚合（`sessionId` 透传给 `todo` 工具），在 bootstrap 中以全 name 注册。

| tool | 说明 |
| --- | --- |
| `read-file` / `write-file` / `edit-file` | 文件编辑（`shared.ts` 提供 `sliceLines`/`unwrap`/`resolveAbsolutePath`/`walkFiles`/`shellQuote`） |
| `bash` | shell 执行 |
| `ls` / `glob` / `grep` | 文件列举与检索 |
| `todo` | 按 sessionId 分桶的 TODO 存储（`Map<string, Todo[]>`），`/new`/`/resume` 切换 session 后 todo 隔离；进程内生命周期，不持久化 |
| `web_search` | 网页搜索（`web-search.ts`）。Provider 抽象在 `web-search/` 子目录下：`provider.ts`（`SearchProvider` 接口 + `resolveProvider()`）、`duckduckgo.ts`（零配置 provider）、`ssrf.ts`（私有 IP 检查）。DuckDuckGo 默认开箱即用，未来 key-gated provider 只需新增一个文件 + 注册到 `PROVIDERS` 数组 |
| `fetch_content` | 抓取 URL 正文并转 markdown/text（`fetch-content.ts`）。用 `@mozilla/readability` + `linkedom` 提取，base64 图片替换为 `[IMAGE: alt]`，超长内容截断+全量存到 `~/.novi/cache/web/` + footer 指向 `read_file` 翻页。SSRF 防护拒绝私有/内网 URL |

工具依赖仅 `ExecutionEnv` 能力 + node stdlib（`web_search`/`fetch_content` 额外依赖 `@mozilla/readability` + `linkedom`），绝不触及 TUI / harness 内部。`web-search/` 子目录只依赖 ExecutionEnv + node stdlib + readability/linkedom。

### 4.11 default-system-prompt.ts
极简 fallback 系统提示。`makeSystemPromptProvider` 的 base 解析顺序为：
`.novi/SYSTEM.md` (项目) → `~/.novi/SYSTEM.md` (全局) → `.novi/system-prompt.md`(legacy 兼容) → `~/.novi/system-prompt.md`(legacy 兼容) → DEFAULT_SYSTEM_PROMPT；项目 > 全局，SYSTEM.md > legacy。其后拼接 `APPEND_SYSTEM.md` (两层，项目优先)、AGENTS.md 候选文件（全局 + 父目录链 + cwd，去重），最后是 `formatSkillsForSystemPrompt(resources.skills)` 块；以空行连接并省略空段。

---

## 5. System Prompt 装配（每轮重建）

`makeSystemPromptProvider(cwd)` 接收 `{ env, resources }` 回调（由 harness 在构建对话 turn 时调用），按以下顺序拼装 model-visible prompt：

1. **base**：按候选列表取第一个非空文件（`.novi/SYSTEM.md` 优先），否则 `DEFAULT_SYSTEM_PROMPT`。
2. **appendBlock**：`.novi/APPEND_SYSTEM.md` 与 `~/.novi/APPEND_SYSTEM.md` 都追加（项目在前）。
3. **contextBlock**：`AGENTS.md` 候选（全局 + 父目录链 + 当前 cwd），去重后拼接。
4. **skillsBlock**：`formatSkillsForSystemPrompt(resources.skills)`。

总体策略：项目级 > 用户级，SYSTEM.md > legacy，向后兼容 `system-prompt.md`。

---

## 6. TUI 层（`src/tui`）

TUI 是一个 Ink + React 应用，核心围绕 **HarnessHandle** 这一"可替换的 harness 容器"组织。

### 6.1 整体组件树

```
renderApp(BootstrapResult, sessionsDir)
└─ <App>
   ├─ <MessageList>           messages / streamingText / streamingThinking / streamingToolCalls
   │    ├─ <Markdown>          流式 Markdown 渲染 (tui/markdown/render-token.tsx)
   │    └─ <ToolCallBlock>      工具调用块，可折叠 (Ctrl-O)
   ├─ notice[]                 临时通知行 (theme.dim)
   ├─ <StatusBar>              model / thinkingLevel / cumulative+last usage
   ├─ <InputBox>               (默认 overlay=null) 编辑器：Emacs 键位 / @file / !bang / Ctrl+G 外部编辑器 / 历史
   └─ Overlay (互斥其一):
        ├─ <SettingsForm>       /settings：编辑 settings.json（含 transport/queue/scopedModels/trust 字段），支持重解析
        ├─ <FilePicker>         @file 触发：选文件路径插入编辑器
        ├─ <SessionPicker>       /resume：列会话 → 替换 harness
        └─ <ModelPicker>         /model（无参）：列出已配置 providers 的模型，选择切换
   底部：divider + session path + 帮助提示
```

`TrustPrompt` 与 `OnboardingWizard` **不在 App 内**：它们是独立的 `render()` 实例，在 bootstrap 之前运行，决策完成即 unmount。

### 6.2 关键抽象：HarnessHandle（`harness-handle.ts`）

`AgentHarness` 无 hot-swap session API，因此 Novi 自建 `HarnessHandle`：

```ts
interface HarnessHandle {
  harness: AgentHarness;
  session: Session<JsonlSessionMetadata>;
  sessionPath: string;
  trusted: boolean;
  replace(next: ReplaceOptions): Promise<{ diagnostics: string[] }>;  // 重建 harness + replay 状态
}

interface ReplaceOptions {
  session?: Session<JsonlSessionMetadata>;
  sessionPath?: string;
  reloadResources?: boolean;
  resolvedSettings?: ResolvedSettings;  // /reload 传：从 settings 重解析 model/thinking/stream/queue
}
```

`replace` 是一个**递归闭包**模式：每次 `replace` 构造新 `AgentHarness`，调用 `replayHarnessState(newHarness, oldHarness, env, cwd, sessionId, models, opts)` 复刻 tools（含 active names）、model/thinking/stream/queue 配置、resources（可选重新加载）、**hooks（重新加载 manifest 并重建 dispatcher 闭包）**，然后调用 `setHandle(newHandle)`，新 handle 的 `replace` 又闭包到新的 harness。这保证 stale `replace` 总读到自己所属的 handle。

`replace` 返回 `{ diagnostics: string[] }` —— `loadResources` / `loadHooks` 在文件损坏时收集的 warning 不再静默丢弃，调用方（`/reload`、`/new`、`/resume`）逐条打印 `warning: <diagnostic>`。model 重解析失败（settings 中 model 不存在）也作为 diagnostic 返回，降级保留 old harness 的 model。**trust 决策复用 old handle 的 `trusted`**（cwd-scoped，不随 session 切换变；`replayHarnessState` 用它门控 project 层 resources/hooks 的重加载）。

**model/thinking/streamOptions/queue-modes 重解析语义**：`/reload` 传 `resolvedSettings` 时，`replayHarnessState` 从 disk settings 重解析 `defaultModel`、`defaultThinkingLevel`、`retry.provider.*`/`transport`、`steeringMode`、`followUpMode` 并应用到新 harness（R4）。`/new`/`/resume` 不传 `resolvedSettings`，从 old harness 重放以保持当前运行时配置。

驱动场景：
- `/reload` → 先 `loadSettings` + `resolveSettings` + `setSettings`，再 `replace({ reloadResources: true, resolvedSettings: newResolved })`（复用当前 session）。
- `/new`、`/resume` → `replace({ session, sessionPath, reloadResources: true })`（换 session，不传 resolvedSettings）。
- 等 `waitForIdle()` 后才拆旧 harness，防止 turn 中途重建。

### 6.3 `useHarnessState`（TUI↔harness 唯一事件边界）

这是**唯一解析原始 `AgentHarnessEvent` 的地方**：所有 display 代码消费 `HarnessState`，从不直接处理 raw event（防止"每个消费者各自解析同一 payload"反模式）。订阅的 event 类型与状态投影：

| event | 投影 |
| --- | --- |
| `turn_start` | phase → `turn`，清空 `streamingToolCalls` |
| `message_start` (assistant) | 清 `streamingText`/`streamingThinking` |
| `message_update` | `text_delta`/`thinking_start`/`thinking_delta`/`thinking_end` 增量更新流 |
| `message_end` | 追加 message 到 `messages`（同步更新 `messagesRef`，供 `settled` 后的 auto-compact 读取），assistant 消息清流 + 投影 usage |
| `tool_execution_start/end` | `streamingToolCalls` 状态机 running→done/error |
| `model_update` / `thinking_level_update` / `tools_update` | 同步对应展示字段 |
| `queue_update` | 投影 steer/followUp/nextTurn 全量消息数组（非仅 count） |
| `agent_end` | phase → `idle`，清流式缓冲 |
| `settled` | AutoCompactor 决策点（phase 翻转 → `compaction`） |
| `session_compact` | 翻回 `idle` + reload 分支 |
| `session_tree` | 分支导航重写 leaf → reload 分支历史 |

依赖数组 `[harness, session, compactionSettings]`，`replace()` 后 handle.harness/session 变化 → 自动 unsubscribe/resubscribe。`compactionSettings` 变化（`/reload` 后）→ effect 重跑并 `compactor.setSettings(...)`。

`messagesRef`（ref mirror）存在的意义：auto-compact 在 `settled` 触发，发生在同一 tick 的最后一个 `message_end` 之后 —— 必须同步读最新 messages，不能等 React 异步 setState。

### 6.4 App.tsx 输入分发

App 提升 `editorState`（ lifts 到顶层，跨 overlay 不丢）、`toolExpanded`、`inputHistory`、overlay state。键盘流转：
- **Ctrl-C**：overlay 打开则关 overlay；否则 abort 后退出。
- **Ctrl-O**：折叠/展开工具调用块。
- **Ctrl-P / Shift+Ctrl+P**：在 `scopedModels` glob 匹配出的模型列表中循环切换（正向/逆向），仅含已配置 providers 的模型；无 scopedModels 时提示用 `/settings` 配置。
- **Shift+Tab**：循环 thinking level（off→minimal→…→xhigh→off）。
- **Enter**：根据 phase 分流 `handlePrompt` (idle) / `handleSteer` (turn) / `handleFollowUp`，slash 行走 `handleCommand`。
- **Escape**：turn 中 abort + 恢复 steer/followUp 队列文本到编辑器（`queue-helpers.ts` 的 `restoreText`）；idle 时清空编辑器；compaction 中 no-op。
- **Alt+Up**：预览最后一条队列消息到编辑器（不真出队）。
- **↑/↓**（单行非 slash）：浏览输入历史。

### 6.5 commands.ts（斜杠命令注册表）

`COMMANDS` 注册表（`/help` 顺序展示）+ `runCommand` 分发。实际注册的命令：
- 会话：`/new` `/resume` `/name` `/session`
- 运行时：`/model` `/compact` `/settings` `/reload` `/quit`
- 信任：`/trust [always|never]`（无参查状态，含 trust.json 条目与 `defaultProjectTrust` 来源）
- scoped 模型：`/scoped-models [add|remove|clear] <pattern>`（写入 `~/.novi/settings.json` 的 `scopedModels`，需 `/reload` 生效）

`/model` 无参 → 收集所有已配置 providers 的模型（`getAuth` 本地校验，无网络）打开 `ModelPicker` overlay；`/model <modelId>` 同 provider 切换，`/model <provider>/<modelId>` 跨 provider 切换。`/session` 投影 usage 与 retry/stream 选项。

未匹配的 `/<name>` 退化为 prompt template（`substituteArgs`）触发 `harness.prompt`（非 idle 时拒绝）。

### 6.6 其他 TUI 模块

| 文件 | 职责 |
| --- | --- |
| `Markdown.tsx` / `markdown/render-token.tsx` | 流式 Markdown 渲染（纯 token→element 变换，不碰 harness） |
| `InputBox.tsx` | 编辑器核心：cursor 模型、Emacs 键位、`@file` 触发、`!`/`!!` bang、Ctrl+G 外部编辑器、Tab 路径补全 |
| `editor-state.ts` | 光标/文本状态机（`insert`/`backspace`/`deleteForward`/`moveWord`…） |
| `bang.ts` | `!`/`!!` 前缀 shell bang 解析与执行 |
| `external-editor.ts` | `$EDITOR` 启动，编辑器返回文本 |
| `file-picker.tsx` | `@file` 文件选择 overlay |
| `SessionPicker.tsx` | `/resume` 会话选择 |
| `SettingsForm.tsx` | `/settings` 编辑表单（含 provenance，字段覆盖 transport/steeringMode/followUpMode/scopedModels/defaultProjectTrust） |
| `StatusBar.tsx` | model/thinkingLevel + cumulative/last usage 条 |
| `ToolCallBlock.tsx` | 工具调用展示与折叠 |
| `ModelPicker.tsx` | `/model` 无参触发的模型选择 overlay（按 provider 分组，↑↓ 导航） |
| `TrustPrompt.tsx` | 独立 `render()` 实例：bootstrap 前的项目信任选择（once/always/never/abort） |
| `OnboardingWizard.tsx` | 独立 `render()` 实例：首次凭证/模型引导，完成后自行 bootstrap + renderApp |
| `scoped-models.ts` | `matchScopedModels`（minimatch glob 匹配 `provider/id`）+ `nextScopedIndex`（循环索引） |
| `usage.ts` | usage 投影单一所有者（`summarizeUsage`/`formatTokens`/`formatCost`） |
| `queue-helpers.ts` | `messageText`/`restoreText` 队列文本解码（跨单元共享） |
| `theme.ts` | **共享主题**：所有组件消费 `theme.*`，禁止硬编码 Ink `color`/`dimColor` |
| `components/Spinner.tsx` | 加载动画 |

### 6.7 主题约束

`theme.ts` 是颜色的单一真相源：`role.user/assistant`、`status.idle/active/error`、`accent`、`border`、`dim`、`link`、`diff.del/add`，以及 `divider()` 工具函数。新增颜色必须走 theme，不允许硬编码。

---

## 7. Headless 层（`src/headless`）

无 TUI 的单次运行模式。

- **runPrint (`--print`)**：单次 prompt，订阅 `message_end`(assistant) 捕获最终文本，写 stdout，`process.exit(0)`。错误走 stderr，exit 1。
- **runJson (`--mode json`)**：把所有 harness event 经 `projectEvent` 投影为 JSON-serializable（白名单字段，剥离 `Model` 实例 / 函数 / `AbortSignal`）后逐行 JSONL 输出。出错时发 `{type:"error"}` 记录。
- **stdin.ts**：`readStdinIfPiped` + `mergePrompt` —— 管道时把 stdin 内容前置到 prompt。
- **events.ts**：`extractText`（content → 文本，单一解码器）+ `projectEvent`（事件投影，唯一 owner）。
- **flushStdout**：`process.exit()` 不等 Node 写缓冲排空，pip 输出可能被截断，故显式 flush 后再退出。

`--print` 与 `--mode json` 互斥；头less 模式发现未配置凭证直接 fail 并给出指引（不启动 wizard）。

---

## 8. 配置文件分层与凭证

### 配置目录（两层级）
```
~/.novi/                         用户级（全局）
├── settings.json                机器/全局行为配置
├── credentials.json             API key 凭证（0600，物理隔离）
├── trust.json                   项目信任 db（cwd/parent → always|never，0600）
├── models.json                  自定义 providers（全局层）
├── SYSTEM.md / system-prompt.md  全局 system prompt（SYSTEM.md 优先）
├── APPEND_SYSTEM.md              全局 system prompt 追加段
├── skills/                       全局 skills
├── prompts/                      全局 prompt templates
├── hooks/hooks.json             全局生命周期钩子 manifest
├── AGENT/AGENTS.md               全局 context block
└── sessions/                     会话 JSONL 根
      └── <encoded-cwd>/          按工作目录分子目录
            └── <timestamp>_<id>.jsonl
<cwd>/.novi/                      项目级（覆盖全局；同名时 project 优于 user；**trust 门控**）
├── settings.json                 项目配置
├── SYSTEM.md
├── APPEND_SYSTEM.md
├── models.json                  项目自定义 providers（trust 门控；同 id 覆盖全局）
├── skills/
├── prompts/
├── hooks/hooks.json             项目钩子 manifest（trust 门控）
└── AGENTS.md                     上下文候选之一（父目录链 + cwd 聚合去重）
```

### 凭证探测（onboarding.ts）
`probeProviderConfigured` 是 bootstrap 前的轻量探测：
1. `loadCredentials` + `injectCredentialsIntoEnv`
2. **保守解析 trust**（`ask→never`），仅在 trusted 时加载 project settings
3. `loadSettings` + `resolveSettings`
4. `builtinModels()` + **`loadCustomModels`（trust 门控）** + `models.setProvider` 注册自定义 providers
5. `resolveCandidateModel` + `models.getAuth(model)` —— **无网络调用**，仅检测 key 是否可读

未配置时：headless 打印 `formatHeadlessGuidance(provider)` 并 fail；TUI 触发 `OnboardingWizard`，它会写入凭证/settings，之后**自己调用 bootstrap 并 renderApp**（wizard 内部完成 bootstrap，避免重复装配）。

env key 名通过 `findEnvKeys(provider, ALL_SET_ENV)`（Proxy 报告所有键为 set）枚举出 provider 接受的全部 env-var 名，复用 pi-ai 内部映射而不重复维护。

---

## 9. 关键架构原则

1. **事件边界单一化**：`useHarnessState`（TUI）与 `events.ts`（headless）各自是唯一解析 raw event 的 owner，下游 display 代码只消费投影后的 `HarnessState` / JSONL。禁止在每个消费点重复解析。
2. **HarnessHandle 递归闭包**：stale `replace` 永远读到自己所属的 handle，避免 hot-swap 时的状态漂移；`waitForIdle` gate 防止 turn 中途拆 harness。
3. **凭证物理隔离**：API key 不进 settings.json，避免截图/共享泄漏；注入仅填 undefined 键，用户 export 永远胜出。
4. **失败降级不阻断**：settings/resource/custom providers/hooks/credentials/trust 解析失败均降级为空层或 diagnostic + stderr 警告，启动永不阻塞。
5. **依赖方向单向**：tools/credentials/resources/trust/models-loader/hooks 等只依赖 `ExecutionEnv` + node stdlib（+ pi-ai 公共 API），绝不引用 TUI / harness 内部；TUI 仅通过 `AgentHarness` & `Session` 公共 API 交互。
6. **单一真相源**：颜色（theme.ts）、usage 投影（usage.ts）、队列文本解码（queue-helpers.ts）、事件投影（useHarnessState / events.ts）、scoped-models 匹配（scoped-models.ts）各有唯一 owner。
7. **项目 > 用户 / 项目覆盖**对于 skills、settings、system prompt、custom providers（同 id upsert）；prompt templates 不 dedup 透传；hooks 同 event 的 matcher groups 追加合并（不 dedup/override）。
8. **信任门 cwd-scoped**：untrusted 时 `<cwd>/.novi/` 下的 settings/resources/models.json/hooks 全部跳过；trust 决策走 cwd 或最近父目录的 trust.json 条目，`/reload` 复用 old handle 的 `trusted` 不重弹。
9. **hooks 子进程隔离**：脚本经 stdin/stdout JSON IPC，内部字段不泄漏；任何 exit code/timeout/spawn 失败降级为 warning + no-op，永不崩溃 harness。
10. **无数据库**：所有持久化基于文件（JSONL session / JSON settings / 文件型资源 / trust.json / models.json / hooks.json），通过 `JsonlSessionRepo`/`Session` 公共 API 操作。TODO 按 sessionId 分桶的进程内存储、不落盘。
11. **工具权限 fail-closed**：默认 `bash=ask`；headless/gateway 对 ask 自动 deny；project permissions 只能收紧；`--yes` 是显式 escape hatch（非默认）；session grants 进程内记忆不落盘；与用户 hooks deny-sticky compose。

---

## 10. 运行模式总览

| 模式 | 触发 | 行为 |
| --- | --- | --- |
| **交互 TUI** | `novi` (默认) | Ink App，支持 `/命令`、多层 overlay（含 ModelPicker）、流式 Markdown、工具调用折叠、auto-compaction、输入历史、Ctrl+P scoped 模型循环、Shift+Tab thinking 循环 |
| **Print** | `novi -p "prompt"` | 单轮 prompt，打印最终 assistant 文本后 exit 0 |
| **JSON 事件流** | `novi --mode json "prompt"` | 把所有 event 投影成 JSONL 流式输出，便于机器消费 |
| **会话续接** | `novi --resume <path>` | 打开既有 JSONL session，恢复分支上下文 |
| **首次引导** | 无凭证且 TUI 模式 | OnboardingWizard 收集 PROVIDER/ENV KEY，写入 credentials.json/settings.json 后自行 bootstrap 并 render |
| **信任提示** | 有 gated 资源且 decision=ask 且 TUI | TrustPrompt 选择 once/always/never/abort，always/never 落盘 trust.json |
| **列出模型** | `novi --list-models [search]` | 轻量路径：env+creds+settings+custom providers，打印已配置 providers 的模型后 exit 0 |

---

## 11. 外部依赖边界（不可修改）

`@earendil-works/pi-agent-core` 与 `@earendil-works/pi-ai` 是外部依赖。Novi 通过其公共 API 使用：
- `AgentHarness`：构造 / `subscribe` / `on`（钩子注册，fully-typed） / `prompt` / `steer` / `followUp` / `abort` / `compact` / `setTools` / `setModel` / `setThinkingLevel` / `setStreamOptions` / `setSteeringMode` / `setFollowUpMode` / `setResources` / `navigateTree` / `getActiveTools` / `getModel` / `getThinkingLevel` / `getStreamOptions` / `getSteeringMode` / `getFollowUpMode` / `getResources` / `waitForIdle`
- `NodeExecutionEnv`：FS / process / cwd / shell env 能力
- `JsonlSessionRepo` / `Session`：会话创建/打开/分支/命名（**不要用内部的 `JsonlSessionStorage`**）
- `builtinModels()`、`Models.getModel/getModels/getProviders/getAuth/setProvider`
- `createProvider` / `envApiKeyAuth` / `Provider`/`ProviderAuth`/`ProviderHeaders`/`Api`/`Model` 类型；lazy API 工厂（`openai-completions` 等 9 个 `*/lazy` 入口）
- `findEnvKeys` / `getEnvApiKey`（`pi-ai/compat`）
- `loadSourcedSkills` / `loadPromptTemplates` / `formatSkillsForSystemPrompt` / `AutoCompactor`（参考）/ `estimateContextTokens` / `shouldCompact` / `DEFAULT_COMPACTION_SETTINGS` / `CompactionSettings`（compaction 配置类型，Novi 经 `resolveCompactionSettings` 消费）

任何"绕过公共 API、直读存储内部"都属于禁止模式。

---

## 12. 测试与工程化

- **Vitest**，`*.test.ts` 与源码并置（`tools/` 测试在 `__tests__/`）；`npm test`。
- **typecheck**：`tsc --noEmit`（构建产物 `dist/` 不含 `.test.ts`，因为 `include: ["src"]` 且 tsc 不编译 test 后缀）。
- **lint / format**：ESLint flat config + Prettier。
- **Trellis spec**：`.trellis/spec/{backend,frontend,guides}` 持久化跨 session 的项目约定（目录结构、持久化模式、目录组织、主题禁硬编码等），开发前需读相关 spec。

---

*本文档基于截至 2026-07-04 的源码快照整理。后续 spec 更新以 `.trellis/spec/` 为准。*
