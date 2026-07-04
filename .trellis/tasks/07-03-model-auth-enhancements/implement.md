# Implement — Model Auth Enhancements

> PRD: `07-03-model-auth-enhancements/prd.md` · Design: 同目录 `design.md`

## Ordered Checklist

### Step 1 — models-loader (backend, 纯函数 + IO)
- [ ] 新建 `src/models-loader.ts`：`loadCustomModels(env, cwd): Promise<{providers: Provider[], diagnostics: string[]}>`
- [ ] schema 解析：`providers` map → 每项 `{id, baseUrl, api, apiKey, name?, models[]}`
- [ ] `apiKey` `$VAR` 插值（缺失→该 provider apiKey=undefined，仍注册但 unconfigured）
- [ ] `api` 字面量 → api 工厂映射（`openai-completions`/`openai-responses`/`anthropic-messages`/`mistral-conversations`/`google-generative-ai`）；未知→diagnostic+skip
- [ ] models[] → `Model<Api>` 对象；缺 id → skip + diagnostic
- [ ] 两层合并：global + project，project 后 `setProvider` 覆盖
- [ ] 降级：文件缺失→空；JSON 非法→ diagnostic + 空；永不 throw
- [ ] 新建 `src/models-loader.test.ts`：覆盖 pi minimal example、`$VAR` 解析、缺字段降级、layer override、api 未知 skip

**验证**：`npm test -- models-loader`

### Step 2 — bootstrap 接入 custom providers
- [ ] `bootstrap.ts`：`builtinModels()` 后 `loadCustomModels` + `models.setProvider` 循环
- [ ] diagnostics → stderr（同 settings/resources）
- [ ] `BootstrapResult` 增字段 `scopedModels?: string[]`（透传 settings 到 App）

**验证**：`npm run typecheck`

### Step 3 — settings 扩展
- [ ] `settings.ts` `NoviSettings` 增字段：`transport`/`steeringMode`/`followUpMode`/`scopedModels`/`defaultProjectTrust`
- [ ] `resolveSettings` 增对应 provenance（顶层 scalar 模式，无嵌套）
- [ ] `SettingsCliOverrides` 增 `transport`/`steeringMode`/`followUpMode`/`scopedModels`
- [ ] `settings.test.ts` 增对应 provenance 用例

**验证**：`npm test -- settings`

### Step 4 — bootstrap 接 transport + queue modes
- [ ] `bootstrap.ts`：扩展现有 retry 块为 `setStreamOptions({transport, ...retry})`
- [ ] 新增 `setSteeringMode` / `setFollowUpMode` 调用（仅 settings 存在时）
- [ ] `probeProviderConfigured` (onboarding.ts) 同步：custom providers 也参与 resolveCandidateModel（复用同一个 models 装配）

**验证**：`npm run typecheck`

### Step 5 — replayHarnessState 复刻 queue modes
- [ ] `src/tui/harness-handle.ts` `replayHarnessState`：在 `setStreamOptions` 后增 `setSteeringMode(old.getSteeringMode())` + `setFollowUpMode(old.getFollowUpMode())`（仅当非 undefined）
- [ ] harness-handle.test.ts 覆盖

**验证**：`npm test -- harness-handle`

### Step 6 — scoped-models (TUI)
- [ ] 新建 `src/tui/scoped-models.ts`：`matchScopedModels(patterns, entries)` + `nextScopedIndex(current, len, reverse)`
- [ ] 新建 scoped-models.test.ts
- [ ] `App.tsx`：`Ctrl+P` / `Shift+Ctrl+P` 绑定 → `matchScopedModels` → `harness.setModel(scoped[next])`；空→notice
- [ ] `BootstrapResult.scopedModels` 传入 App state

**验证**：`npm test -- scoped-models` + `npm run typecheck`

### Step 7 — /scoped-models 命令
- [ ] `commands.ts`：新增 `/scoped-models` + 子命令 add/remove/clear
- [ ] 写入 `scopedModels` 到 settings.json（`writeSettings`）；提示 `/reload` 生效
- [ ] commands.test.ts 覆盖

**验证**：`npm test -- commands`

### Step 8 — SettingsForm 增加 transport/queue/scopedModels
- [ ] `SettingsForm.tsx`：transport select（4 选项）+ steeringMode select + followUpMode select + scopedModels 编辑（逗号分隔或多行）
- [ ] 写入 settings.json 带正确 dot-path

**验证**：`npm run typecheck` + `npm run lint`

### Step 9 — CLI flags + `--list-models`
- [ ] `cli.ts` parseArgs 增：`--transport`/`--steering-mode`/`--follow-up-mode`/`--models`/`--list-models` (boolean+positional) / `--approve`(child2共用) / `--no-approve`
- [ ] `--list-models [search]` 分支：轻量装配 models → 打印已配置 provider 的 model 列表 → exit 0
- [ ] help 文本更新

**验证**：`npm run typecheck`

### Step 10 — 全量验证
- [ ] `npm run lint && npm run typecheck && npm test`
- [ ] 手测：minimal ollama models.json → `/model` 列出 → 切换 → 对话
- [ ] 手测：scopedModels + Ctrl+P 循环
- [ ] 手测：`--list-models sonnet` 过滤
- [ ] 手测：`/reload` 后 custom providers/transport/modes 仍生效

## Risky Files / Rollback Points
- `bootstrap.ts` 启动装配核心；改动追加式，不动现有顺序
- `harness-handle.ts` replay 逻辑；改动追加 setSteeringMode/setFollowUpMode 两行
- `settings.ts` schema 扩展；纯加字段，向后兼容

## Follow-up Before task.py start
- 确认 `Api` 类型 union 在 TS 层能否接受字面量字符串（`api: KnownApi` 映射）；若不能，loader 内用 `as Api` 强转 + runtime diagnostic 双保险
