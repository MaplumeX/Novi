# Design: novi first-run provider onboarding

## Scope recap

新增首次启动引导向导（independent wizard），并在启动前持久化 API key 到 `~/.novi/credentials.json`。headless 模式不走向导，给指引退出。

## Architecture & boundaries

### 新增模块

1. **`src/credentials.ts`**（新文件）——凭证存储层
   - `getCredentialsPath()`: `~/.novi/credentials.json`
   - `loadCredentials(env): Promise<Record<string,string>>` 读 JSON（缺失返回 `{}`）
   - `writeCredentials(env, patch)` 浅合并写入，`chmod 0600`
   - `injectCredentialsIntoEnv(creds, env)`：把存储的 key 注入 `process.env`（仅注入未设置项，避免覆盖用户已显式设置的环境变量）
   - 仅存 `{ "ANTHROPIC_API_KEY": "sk-..." }` 形式的明文键值对；key 名来自 `findEnvKeys(provider)`

2. **`src/tui/OnboardingWizard.tsx`**（新文件）——引导向导组件
   - 步骤型 wizard：provider 选择 → API key 录入 → model 选择 → 完成
   - 步骤 1：`getBuiltinProviders()` 列表，字母排序，上下选择，回车确认
   - 步骤 2：`findEnvKeys(provider)` 查询所需 env var 名，提示用户输入对应 key（支持多个 env var 的 provider 也依次录入）
   - 步骤 3：`getBuiltinModels(provider)` 列表，默认高亮 `DEFAULT_MODEL_ID`（anthropic）或 candidates[0]，回车确认
   - 完成回调 → 写 credentials.json + 写 settings.json(provider/model) → `onComplete()`
   - Esc 在任意步返回上一步；第一步 Esc → `onCancel()`（退出）

3. **`src/tui/App.tsx`** modifications ——初始 overlay 支持 `onboarding`
   - 新增 `Overlay` variant: `{ kind: "onboarding" }`
   - 但 onboarding 在 bootstrap 成功后启动，不走现有 overlay 机制（见下「启动流程变更」）

### 修改的现有模块

4. **`src/cli.ts`** ——启动流程分支
   - 在调用 `bootstrap()` 之前，先做「凭证检测」：
     - load settings → resolve provider/model
     - `builtinModels()` + `getAuth(model)` 检查是否有可用凭证
     - **TUI 模式 + 无凭证**：进入 onboarding flow（先渲染 wizard，wizard 完成后调 `bootstrap()` 继续正常启动）
     - **headless 模式 + 无凭证**：stderr 输出友好指引 + exit 1
     - **有凭证**：直接 `bootstrap()`（现有路径不变）
   - 注意：`bootstrap()` 里的 `resolveModel()` 仍保留作为最终防御，但 cli 层提前分流后不会触发它抛错

5. **`src/bootstrap.ts`** ——启动时注入凭证
   - `bootstrap()` 开始处调用 `loadCredentials()` + `injectCredentialsIntoEnv()`，让 pi-ai 的 `getAuth` 能读到存储的 key
   - 这保证无论凭证来自环境变量还是 credentials.json，`resolveModel` 都能正常工作

6. **`src/tui/SettingsForm.tsx`** ——AC5：只读脱敏展示 credentials
   - 在现有字段列表后追加「Credentials（只读）」区域，展示 `~/.novi/credentials.json` 的键名 + 脱敏值（`sk-...xxxx`，只显示前 3 后 4 字符）
   - 不提供编辑（编辑 credentials.json 需用户手动操作或未来 `/setup`）

## Data flow

```
cli.ts 启动
  ├─ load settings, resolve provider (settings 或默认 anthropic)
  ├─ injectCredentialsIntoEnv (basin: 把 credentials.json 注入 process.env)
  ├─ 检测 getAuth(model)
  │   ├─ 有凭证 → bootstrap() → 正常 TUI/headless (现有路径)
  │   ├─ 无凭证 + TUI → renderOnboardingWizard()
  │   │     ├─ provider 选完 → 录入 key → model 选完
  │   │     ├─ writeCredentials() + writeSettings()
  │   │     └─ onComplete → injectCredentialsIntoEnv (新 key 入 env) → bootstrap() → 正常 TUI
  │   └─ 无凭证 + headless → stderr 指引 + exit 1
```

## Contracts

- `~/.novi/credentials.json` 格式：`{ "<ENV_VAR_NAME>": "<api_key>" }`，JSON 对象，扁平 key→string。
- 文件权限：`0600`（`writeCredentials` 后立即 `fs.chmod`）。
- 启动时 injection 仅注入 `process.env` 中**未定义**的变量，避免覆盖用户显式设置的环境变量。
- wizard 写入 settings.json 用现有 `writeSettings()`，写入 provider/model 两个键。

## Compatibility & migration

- 全新用户：无 settings.json、无 credentials.json、无环境变量 → 触发 wizard。
- 已配 `ANTHROPIC_API_KEY` 环境变量的现有用户：`getAuth` 成功，不触发 wizard，直接 bootstrap。credentials.json 不存在也不影响。
- 已有 credentials.json 的用户：injection 后 `getAuth` 成功，正常启动。

## Security considerations

- credentials.json 明文存储，0600 权限，位于 `~/.novi/`（项目无关）。
- `/settings` 只读脱敏展示，不回显完整 key。
- 不写入项目目录，避免被 git 提交（现有 `.gitignore` 已 ignore `.novi/`，但这是用户目录不在仓库内）。

## Trade-offs

- 明文 key 存储 vs 加密存储：选明文（0600 + 用户目录），与大多数 CLI 工具一致（gh、npm 等）。加密会引入 master key 管理复杂度，收益不大。
- onboarding 在 `cli.ts` 里做检测而不是在 `bootstrap.ts`：为了让 wizard 能在 bootstrap 完成前运行（wizard 需要写入 settings 和 credentials，然后调 bootstrap 把新配置加载进来），避免「bootstrap 失败 → catch → wizard → 重启 bootstrap」的循环。

## Rollback

- 若 wizard 出问题，用户仍可通过环境变量启动 Novi（injection 不覆盖已设环境变量），现有路径完全不受影响。
- credentials.json 可直接删除，不影响已有环境变量配置的用户。
