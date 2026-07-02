# Implement: novi first-run provider onboarding

## Execution checklist

### Phase A: 凭证存储层（后端基础）

- [x] A1 新建 `src/credentials.ts`
- [x] A2 新建 `src/credentials.test.ts`
- [x] A3 `npm run typecheck && npm test`

### Phase B: bootstrap 注入凭证

- [x] B1 `src/bootstrap.ts` `bootstrap()` 开头调用 `loadCredentials` + `injectCredentialsIntoEnv`（在构造 `NodeExecutionEnv` 之后、`resolveModel` 之前）
- [x] B2 typecheck

### Phase C: 启动分流（cli.ts）

- [x] C1 `src/cli.ts`：把现有 try/catch 改造，在 TUI 模式下做凭证预检（提取到 `src/onboarding.ts`：`probeProviderConfigured`/`formatHeadlessGuidance`）
- [x] C2 typecheck

### Phase D: 引导向导组件

- [x] D1 新建 `src/tui/OnboardingWizard.tsx`
- [x] D2 `renderOnboardingWizard` 函数
- [x] D3 typecheck

### Phase E: /settings 只读脱敏展示

- [x] E1 `src/tui/SettingsForm.tsx` 追加 Credentials 只读区域
- [x] E2 typecheck + 现有 settings 测试通过

### Phase F: 验证

- [x] F1 `npm run typecheck`
- [x] F2 `npm test` (221 passed)
- [x] F3 `npm run lint`
- [x] F4 手动场景验证：
  - 全新环境启动 → wizard（renders）
  - 已配 ANTHROPIC_API_KEY → 不触发（probe passes through to bootstrap）
  - headless 无凭证 → 友好退出（exit 1 + guidance）

## Validation commands

```bash
npm run typecheck
npm test
npm run lint
```

## Risky points / rollback

- `cli.ts` 启动流程改动：若 wizard 路径有 bug，用户仍可通过 `ANTHROPIC_API_KEY=xxx novi` 启动绕过。
- `bootstrap.ts` 注入点：在 `resolveModel` 之前注入，若注入逻辑出错会导致 `getAuth` 仍失败，但退化到现有报错行为，不会造成新问题。
- credentials.json 权限：部分文件系统不支持 chmod，`writeCredentials` 应 try/catch chmod 失败（不阻断写入）。
