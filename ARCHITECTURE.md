# Novi 架构文档

> Novi 是一个基于 TypeScript ESM 的 Agent harness + TUI，构建在 `@earendil-works/pi-agent-core` 与 `@earendil-works/pi-ai` 之上，使用 Ink (React 终端 UI) 渲染交互界面、支持 headless 模式。

---

## 1. 技术栈与运行环境

| 维度 | 选择 |
| --- | --- |
| 语言 / 模块系统 | TypeScript, ESM (`module: Node16`, `moduleResolution: Node16`, `strict`) |
| 运行时 | Node.js ≥ 22.19 |
| 构建 | `tsc` → `dist/`；开发期 `tsx src/cli.ts` |
| 核心 SDK | `@earendil-works/pi-agent-core`（AgentHarness / Session / JsonlSessionRepo）、`@earendil-works/pi-ai`（Models / Model / API） |
| 终端 UI | Ink 7 + React 19 |
| Markdown | `marked` + 自渲染 token (`tui/markdown/render-token.tsx`) |
| Schema | `typebox`（工具参数定义） |
| 持久化 | 纯文件系统（JSONL session / JSON settings / 文件型 skills & prompts），无数据库 |
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
│  parseArgs → 凭证探测 → bootstrap / onboarding → 渲染或 headless│
└─────────────────────────────────────────────────────────────┘
            │
   ┌────────┴─────────┐
   ▼                  ▼
┌─────────────┐  ┌──────────────────────────────────────────┐
│ Backend Core│  │              TUI (src/tui)                │
│ (src/ 根)   │  │  App.tsx → useHarnessState → MessageList │
│ bootstrap/  │  │  InputBox / Commands / Overlays          │
│ config/     │  │  theme / components / markdown           │
│ tools/      │  └──────────────────────────────────────────┘
│ resources/  │
│ compaction/ │
│ settings/   │   ┌──────────────────────────────────────────┐
│ credentials │   │       Headless (src/headless)            │
└──────┬──────┘   │  run: print 模式 / json JSONL 流         │
       │          │  events: 事件投影到可序列化结构            │
       │          │  stdin: 管道输入合并                       │
       │          └──────────────────────────────────────────┘
       ▼
┌─────────────────────────────────────────────────────────────┐
│  pi-agent-core (外部依赖，不可修改)                          │
│  AgentHarness (订阅事件流) + NodeExecutionEnv (FS/Process) │
│  + JsonlSessionRepo / Session (分支化 JSONL 持久化)         │
│  + pi-ai Models + builtinModels() (provider/model/getAuth) │
└─────────────────────────────────────────────────────────────┘
```

**依赖方向**：`cli → bootstrap → {tools, resources, settings, credentials, compaction}` 与 `cli → {tui/headless}`。TUI/headless 只通过 `AgentHarness` 公共 API（`subscribe/prompt/steer/abort/compact/...`）与核心交互，绝不直接读写 session JSONL 存储内部。

---

## 3. 启动流程 (cli.ts → bootstrap.ts)

```
cli.ts
 ├─ parseArgs(provider/model/thinking/cwd/resume/print/mode/help)
 ├─ probeProviderConfigured()      ← 凭证探测：合并 settings + 凭证注入 → models.getAuth()
 │    └─ 未配置 & 头less   → 打印指引并 fail
 │    └─ 未配置 & TUI       → renderOnboardingWizard(bootstrapOptions) 引导式写入凭证/settings 后自行 bootstrap
 │    └─ 已配置 / 探测失败  → 继续
 ├─ bootstrap(options)
 │    1. new NodeExecutionEnv({ cwd, shellEnv: process.env })
 │    2. loadCredentials + injectCredentialsIntoEnv  ← 仅填充 env 中 undefined 的键
 │    3. ensureDir(~/.novi, ~/.novi/sessions)
 │    4. loadSettings(env, cwd) → resolveSettings(merged, layers, cliOverrides)
 │    5. new JsonlSessionRepo({ fs, sessionsRoot }) → repo.create() / repo.open(resumePath)
 │    6. builtinModels() → resolveModel(models, provider, modelId)  ← 校验 provider/model/auth
 │    7. makeSystemPromptProvider(cwd)  ← 闭包：base + append + AGENTS.md + skills 块
 │    8. new AgentHarness({ env, session, models, model, systemPrompt, thinkingLevel })
 │    9. setTools(createBuiltinTools(env), 全部 name)
 │   10. setResources({ skills, promptTemplates })  ← loadResources(env, cwd)
 │   11. setStreamOptions(retry.*) ← 仅在 settings.retry 配置存在时透传
 ├─ 返回 BootstrapResult
 └─ 分发：
      - --print         → runPrint(result, prompt)
      - --mode json      → runJson(result, prompt)
      - (default)        → renderApp(result, sessionsDir)
```

**BootstrapResult 的关键契约**：除了 `harness/env/models/model/session/sessionPath`，还回传 `systemPrompt`（重建 harness 时复用）、`resolvedSettings` 与 `cliOverrides`（供 `/settings`、`/reload` 再解析），以及 `env`/`cwd`。这一点很重要 —— `App.tsx` 与 `HarnessHandle.replace()` 都依赖这些闭包原料，而不是再次走 `bootstrap()`。

---

## 4. Backend Core（`src/` 根非 TUI 部分）

### 4.1 config.ts
纯路径解析：`getNoviDir() = ~/.novi`，`getSessionsDir() = ~/.novi/sessions`。无状态、无 IO。

### 4.2 bootstrap.ts
启动装配器（见 §3）。包含 `resolveModel()`（provider/model 校验 + auth 检查，给用户清晰错误）、`makeSystemPromptProvider(cwd)` 与 `replayHarnessState` 所需的 systemPrompt 工厂。

### 4.3 settings.ts
两层 (`~/.novi/settings.json` 全局 + `<cwd>/.novi/settings.json` 项目) 浅合并；失败降级为空层 + stderr 警告，绝不阻塞启动。`resolveSettings` 计算 `_sources` provenance（`global|project|cli|default`），供 `/settings` UI 显示每项来源。

**优先级**：CLI flag > project > global > 内置默认。

### 4.4 credentials.ts
API key 物理隔离于 `~/.novi/credentials.json`（不混进 settings.json，避免误截图泄漏）。
- `loadCredentials`：丢失/损坏 → `{}`，不抛错。
- `writeCredentials`：浅合并 + `chmod 0600`（失败忽略，非致命）。
- `injectCredentialsIntoEnv`：**只填充 env 中 undefined 的键** —— 用户显式 export 的值永远胜出；空串视为已设置（用户明确清空）。

### 4.5 resources.ts
从 `~/.novi` 与 `<cwd>/.novi` 两层加载 skills（`loadSourcedSkills`）与 prompt templates（`loadPromptTemplates`）。skills 按 name 去重，**project 覆盖 user**；prompt templates 不去重。加载器跳过非法文件并收集 diagnostics，绝不抛错。

### 4.6 compaction.ts
`AutoCompactor`：`settled` 事件 → `maybeCompact`（每 3 轮 debounce）→ `decideShouldCompact`(token 估算 vs contextWindow)→ `harness.compact()`。`onStart` 回调让 UI 翻转 phase 为 `compaction`，`session_compact` 事件后翻回 `idle` 并 reload 分支。

### 4.7 tools/
8 个内置工具，每个文件一个 `createXxxTool(env: ExecutionEnv): AgentTool`，全部经由 `tools/index.ts` 的 `createBuiltinTools(env)` 聚合，在 bootstrap 中以全 name 注册。

| tool | 说明 |
| --- | --- |
| `read-file` / `write-file` / `edit-file` | 文件编辑（`shared.ts` 提供 `sliceLines`/`unwrap`/`resolveAbsolutePath`/`walkFiles`/`shellQuote`） |
| `bash` | shell 执行 |
| `ls` / `glob` / `grep` | 文件列举与检索 |
| `todo` | 进程内单例 TODO 存储（**仅同进程生命周期**，无 sessionId 隔离，不持久化） |

工具依赖仅 `ExecutionEnv` 能力 + node stdlib，绝不触及 TUI / harness 内部。

### 4.8 default-system-prompt.ts
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
   ├─ <StatusBar>              phase / model / thinkingLevel / tools / queue / usage
   ├─ <InputBox>               (默认 overlay=null) 编辑器：Emacs 键位 / @file / !bang / Ctrl+G 外部编辑器 / 历史
   └─ Overlay (互斥其一):
        ├─ <SettingsForm>       /settings：编辑 settings.json，支持重解析
        ├─ <FilePicker>         @file 触发：选文件路径插入编辑器
        └─ <SessionPicker>       /resume：列会话 → 替换 harness
   底部：divider + session path + 帮助提示
```

### 6.2 关键抽象：HarnessHandle（`harness-handle.ts`）

`AgentHarness` 无 hot-swap session API，因此 Novi 自建 `HarnessHandle`：

```ts
interface HarnessHandle {
  harness: AgentHarness;
  session: Session<JsonlSessionMetadata>;
  sessionPath: string;
  replace(next: ReplaceOptions): Promise<void>;  // 重建 harness + replay 状态
}
```

`replace` 是一个**递归闭包**模式：每次 `replace` 构造新 `AgentHarness`，调用 `replayHarnessState(newHarness, oldHarness, env, cwd, { reloadResources })` 复刻 tools（含 active names）、model、thinking level、streamOptions、resources（可选重新加载），然后调用 `setHandle(newHandle)`，新 handle 的 `replace` 又闭包到新的 harness。这保证 stale `replace` 总读到自己所属的 handle。

驱动场景：
- `/reload` → `replace({ reloadResources: true })`（复用当前 session）。
- `/new`、`/resume` → `replace({ session, sessionPath, reloadResources: true })`（换 session）。
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

依赖数组 `[harness, session]`，`replace()` 后 handle.harness/session 变化 → 自动 unsubscribe/resubscribe。

`messagesRef`（ref mirror）存在的意义：auto-compact 在 `settled` 触发，发生在同一 tick 的最后一个 `message_end` 之后 —— 必须同步读最新 messages，不能等 React 异步 setState。

### 6.4 App.tsx 输入分发

App 提升 `editorState`（ lifts 到顶层，跨 overlay 不丢）、`toolExpanded`、`inputHistory`、overlay state。键盘流转：
- **Ctrl-C**：overlay 打开则关 overlay；否则 abort 后退出。
- **Ctrl-O**：折叠/展开工具调用块。
- **Enter**：根据 phase 分流 `handlePrompt` (idle) / `handleSteer` (turn) / `handleFollowUp`，slash 行走 `handleCommand`。
- **Escape**：turn 中 abort + 恢复 steer/followUp 队列文本到编辑器（`queue-helpers.ts` 的 `restoreText`）；idle 时清空编辑器。
- **Alt+Up**：预览最后一条队列消息到编辑器（不真出队）。
- **↑/↓**（单行非 slash）：浏览输入历史。

### 6.5 commands.ts（斜杠命令注册表）

`COMMANDS` 注册表（`/help` 顺序展示）+ `runCommand` 分发。支持的命令族：
- 会话：`/new` `/resume` `/name` `/session` `/history` `/tree` `/goto`（分支导航）
- 运行时：`/abort` `/model` `/thinking` `/tools` `/compact` `/queue` `/templates` `/reload` `/settings` `/quit`

未匹配的 `/<name>` 退化为 prompt template（`substituteArgs`）触发 `harness.prompt`。`/resume` 和 `/list` 会扫描会话目录（含 `<sessionsRoot>/<encoded-cwd>/*.jsonl` 子目录结构），`/session` 投影 usage 与 retry/stream 选项。

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
| `SettingsForm.tsx` | `/settings` 编辑表单（含 provenance） |
| `StatusBar.tsx` | phase/model/thinkingLevel/tools/queue/usage |
| `ToolCallBlock.tsx` | 工具调用展示与折叠 |
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
├── SYSTEM.md / system-prompt.md  全局 system prompt（SYSTEM.md 优先）
├── APPEND_SYSTEM.md              全局 system prompt 追加段
├── skills/                       全局 skills
├── prompts/                      全局 prompt templates
├── AGENT/AGENTS.md               全局 context block
└── sessions/                     会话 JSONL 根
      └── <encoded-cwd>/          按工作目录分子目录
            └── <timestamp>_<id>.jsonl
<cwd>/.novi/                      项目级（覆盖全局；同名时 project 优于 user）
├── settings.json                 项目配置
├── SYSTEM.md
├── APPEND_SYSTEM.md
├── skills/
├── prompts/
└── AGENTS.md                     上下文候选之一（父目录链 + cwd 聚合去重）
```

### 凭证探测（onboarding.ts）
`probeProviderConfigured` 是 bootstrap 前的轻量探测：
1. `loadCredentials` + `injectCredentialsIntoEnv`
2. `loadSettings` + `resolveSettings`
3. `builtinModels()` + `resolveCandidateModel`
4. `models.getAuth(model)` —— **无网络调用**，仅检测 key 是否可读

未配置时：headless 打印 `formatHeadlessGuidance(provider)` 并 fail；TUI 触发 `OnboardingWizard`，它会写入凭证/settings，之后**自己调用 bootstrap 并 renderApp**（wizard 内部完成 bootstrap，避免重复装配）。

env key 名通过 `findEnvKeys(provider, ALL_SET_ENV)`（Proxy 报告所有键为 set）枚举出 provider 接受的全部 env-var 名，复用 pi-ai 内部映射而不重复维护。

---

## 9. 关键架构原则

1. **事件边界单一化**：`useHarnessState`（TUI）与 `events.ts`（headless）各自是唯一解析 raw event 的 owner，下游 display 代码只消费投影后的 `HarnessState` / JSONL。禁止在每个消费点重复解析。
2. **HarnessHandle 递归闭包**：stale `replace` 永远读到自己所属的 handle，避免 hot-swap 时的状态漂移；`waitForIdle` gate 防止 turn 中途拆 harness。
3. **凭证物理隔离**：API key 不进 settings.json，避免截图/共享泄漏；注入仅填 undefined 键，用户 export 永远胜出。
4. **失败降级不阻断**：settings 解析失败、resource 加载失败、credentials 损坏均降级为空层 + 警告，启动永不阻塞。launcher 用 stderr 写 warning。
5. **依赖方向单向**：tools/credentials/resources 等只依赖 `ExecutionEnv` + node stdlib，绝不引用 TUI / harness 内部；TUI 仅通过 `AgentHarness` & `Session` 公共 API 交互。
6. **单一真相源**：颜色（theme.ts）、usage 投影（usage.ts）、队列文本解码（queue-helpers.ts）、事件投影（useHarnessState / events.ts）各有唯一 owner。
7. **项目 > 用户 / 项目覆盖**对于 skills、settings、system prompt；prompt templates 不 dedup 透传。
8. **无数据库**：所有持久化基于文件（JSONL session / JSON settings / 文件型资源），通过 `JsonlSessionRepo`/`Session` 公共 API 操作。TODO 进程内单例、不落盘。

---

## 10. 运行模式总览

| 模式 | 触发 | 行为 |
| --- | --- | --- |
| **交互 TUI** | `novi` (默认) | Ink App，支持 `/命令`、多层 overlay、流式 Markdown、工具调用折叠、auto-compaction、输入历史、上下文编辑 |
| **Print** | `novi -p "prompt"` | 单轮 prompt，打印最终 assistant 文本后 exit 0 |
| **JSON 事件流** | `novi --mode json "prompt"` | 把所有 event 投影成 JSONL 流式输出，便于机器消费 |
| **会话续接** | `novi --resume <path>` | 打开既有 JSONL session，恢复分支上下文 |
| **首次引导** | 无凭证且 TUI 模式 | OnboardingWizard 收集 PROVIDER/ENV KEY，写入 credentials.json/settings.json 后 bootstrap 并 render |

---

## 11. 外部依赖边界（不可修改）

`@earendil-works/pi-agent-core` 与 `@earendil-works/pi-ai` 是外部依赖。Novi 通过其公共 API 使用：
- `AgentHarness`：构造 / `subscribe` / `prompt` / `steer` / `followUp` / `abort` / `compact` / `setTools` / `setModel` / `setThinkingLevel` / `setStreamOptions` / `setResources` / `navigateTree` / `getActiveTools` / `getModel` / `getThinkingLevel` / `getStreamOptions` / `getResources` / `waitForIdle`
- `NodeExecutionEnv`：FS / process / cwd / shell env 能力
- `JsonlSessionRepo` / `Session`：会话创建/打开/分支/命名（**不要用内部的 `JsonlSessionStorage`**）
- `builtinModels()`、`Models.getModel/getModels/getAuth`
- `loadSourcedSkills` / `loadPromptTemplates` / `formatSkillsForSystemPrompt` / `AutoCompactor`（参考）/ `estimateContextTokens` / `shouldCompact` / `DEFAULT_COMPACTION_SETTINGS`

任何"绕过公共 API、直读存储内部"都属于禁止模式。

---

## 12. 测试与工程化

- **Vitest**，`*.test.ts` 与源码并置（`tools/` 测试在 `__tests__/`）；`npm test`。
- **typecheck**：`tsc --noEmit`（构建产物 `dist/` 不含 `.test.ts`，因为 `include: ["src"]` 且 tsc 不编译 test 后缀）。
- **lint / format**：ESLint flat config + Prettier。
- **Trellis spec**：`.trellis/spec/{backend,frontend,guides}` 持久化跨 session 的项目约定（目录结构、持久化模式、目录组织、主题禁硬编码等），开发前需读相关 spec。

---

*本文档基于截至 2026-07-02 的源码快照整理。后续 spec 更新以 `.trellis/spec/` 为准。*
