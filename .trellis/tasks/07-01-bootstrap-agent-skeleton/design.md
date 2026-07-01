# Design: Bootstrap pi-agent TUI skeleton (parent)

本文档是 parent task 的技术设计，定义整体架构与边界。各 child 的 `design.md` 在此基础上细化本 child 范围内的设计。

## 架构总览

```
novi CLI (bin/novi -> dist/cli.js)
  └─ bootstrap()
       ├─ parse CLI flags (--provider, --model, --cwd, --resume?)
       ├─ resolve config (env keys, ~/.novi, .novi/)
       ├─ build env   : NodeExecutionEnv({ cwd, shellEnv })
       ├─ build session: JsonlSessionStorage.create() + toSession()
       ├─ build models : createModels()  (pi-ai env-api-keys)
       ├─ build harness: new AgentHarness({ env, session, models, model, systemPrompt, streamOptions })
       │                 + subscribe(event => tui.onHarnessEvent(event))
       ├─ (child 3) setTools([...8 tools]); setActiveTools(all)
       ├─ (child 4) setResources({ skills, promptTemplates })
       └─ render <App/> (Ink)
              ├─ useHarnessState(harness)  // useEffect subscribe + setState
              ├─ <MessageList/>            // message_start/update/end → 流式 + Markdown
              ├─ <InputBox/>               // onSubmit → harness.prompt/steer/followUp
              ├─ <CommandBar/>             // /compact /tree ... → 调度 harness
              └─ <StatusBar/>              // phase / model / thinking / queue 长度
```

## 分层与依赖方向

- `cli`（入口）→ 组装 → `tui` + `harness` + `tools` + `resources`。
- TUI 层**只**通过 harness 公共 API 与订阅事件读写状态，不直达 session/storage。
- tools 层只依赖 `AgentHarness.env`（`ExecutionEnv`）与 Node 标准库，不依赖 TUI。
- resources 加载层（skills/prompts）依赖 harness 的 `loadSkills`/`loadPromptTemplates`/`loadSourcedSkills` + `formatSkillsForSystemPrompt`，不依赖 TUI。
- compaction/tree-nav 触发层在 TUI 的 CommandBar 里实现，调用 `harness.compact()`/`navigateTree()`，受其 phase 约束。

## 核心契约

### harness 事件 → TUI state

| harness 事件 | TUI 处理 |
|---|---|
| `message_start` (user) | 追加 user 气泡 |
| `message_start` (assistant) | 开一个 streaming 气泡 |
| `message_update` (text_delta) | 追加到 streaming 气泡；经 Markdown 渲染器增量渲染 |
| `message_end` | 冻结该气泡 |
| `tool_execution_start/update/end` | 渲染工具调用行（折叠 details） |
| `turn_end` | 分隔 turn |
| `queue_update` | StatusBar 显示 steering/followUp/nextTurn 长度 |
| `model_update`/`tools_update`/`resources_update` | StatusBar / `/tools` 反映 |
| `session_compact`/`session_tree` | 刷新历史视图 |
| `settled` | 检查 `shouldCompact()` → 自动 `compact()` |

### harness phase 约束

- `prompt`/`skill`/`promptFromTemplate`/`compact`/`navigateTree` 需 `phase === "idle"`；TUI 在 phase 非idle 时禁用对应命令 UI。
- `steer`/`followUp`/`nextTurn`/`abort`/runtime setters 可在 turn 中用。
- 自动 compaction 在 `settled`（idle 恢复后）检查触发，避免 phase 冲突。

### session 路径

- `~/.novi/sessions/<uuidv7>.jsonl`，用 `JsonlSessionStorage.create()` 新建；`/resume <id>` 用 `JsonlSessionStorage.open()` 打开已存在文件。
- session id 由 storage 元数据提供，喂给 `AgentHarnessOptions`（model 缓存键）。

### system prompt 解析顺序

`[.novi/system-prompt.md] → [~/.novi/system-prompt.md] → [内置默认]`。第一个存在的文件内容 + `formatSkillsForSystemPrompt(resources.skills)` 拼成最终 system prompt，通过 `systemPrompt` provider 回调注入 harness。

## 兼容性 / 版本

- pinpoint `@earendil-works/pi-agent-core` / `pi-ai` 的 `^0.80.3` 版本族（engines node>=22.19.0）。
- Ink 版本需与 React 18+ ESM 兼容（child 1 锁定具体版本）。

## 关键 trade-offs

- **不复用 pi-tui**：失去成熟差分渲染/粘贴/图片；换来与 Ink/React 生态对齐、自定义空间。需自处理 Markdown 渲染器，但可渐进。
- **parent 不直接实现**：parent 只盯总体验收，避免 4 个 child 共享文件冲突；代价是 5 套规划文档。
- **compaction 自动触发放 `settled`**：简单但若 `shouldCompact` 误判会反复 compact；接受，必要时加最小间隔保护。

## 回滚 / 运维

- 每个 child 独立 branch/commit；child 1 出问题不影响决策文档。
- 配置/数据全在 `~/.novi`，删除即清空，无外部副作用。
- 任何 child 失败可 `git revert` 该 child 的 commit 而不影响其他 child 产物。
