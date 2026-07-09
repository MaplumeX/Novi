# Implement: Tool permission model

## Checklist

### 1. Policy core（无 UI）
- [ ] `src/permissions/types.ts` — levels, decision, Approver, store types
- [ ] `src/permissions/policy.ts` — defaults, tighten-only merge, resolve + `--yes`
- [ ] `src/permissions/policy.test.ts` — AC7–AC10 对应的解析行为
- [ ] `src/permissions/gate.ts` — PermissionGate + SessionPermissionStore
- [ ] `src/permissions/gate.test.ts` — once / session / deny / store
- [ ] `src/permissions/index.ts` — public exports

### 2. Settings 接入
- [ ] `NoviSettings.permissions?: { tools?: Record<string, PermissionLevel> }`
- [ ] `resolveSettings` / provenance 支持 `permissions.tools.*`（至少 bash）
- [ ] 若 mergeSettings 浅合并会抹掉 tools map：对 `permissions` 做正确一层 merge
- [ ] `SettingsForm` 增加 bash permission 字段（最小）

### 3. Hooks compose
- [ ] 扩展 `registerHooks(..., options?: { permissionGate?: PermissionGate })`
- [ ] `tool_call` dispatcher：gate deny → return；else user hooks；deny sticky
- [ ] 更新 `registry.test.ts`

### 4. Bootstrap / CLI / headless
- [ ] CLI `--yes` flag + help 文案（与 `--approve` 区分）
- [ ] `BootstrapOptions.yes` → `GatewayEnv` / result
- [ ] `createHarnessForSession` / `bootstrap` / resume 路径构造 gate + NonInteractiveApprover（非 TUI）
- [ ] TUI 路径注入 TuiApprover（下一步）
- [ ] `replayHarnessState`：重绑 gate、复用 store、重解析 permissions

### 5. TUI 确认
- [ ] `src/tui/permission-approver.ts`（或 `permissions/tui-approver.ts`）— 队列化 request
- [ ] Overlay / panel 组件：工具名 + summary + 三选项 + Esc=deny
- [ ] `App.tsx` 接线：创建 store+approver 生命周期跨 replace
- [ ] abort 时 resolve 所有 pending 为 deny
- [ ] `summarizeToolInput` helper + 单测

### 6. Docs / spec
- [ ] ARCHITECTURE.md：permissions 模块、D1–D6 行为、CLI `--yes`
- [ ] `.trellis/spec/backend/directory-structure.md`：`src/permissions/`
- [ ] `.trellis/spec/backend/pi-agent-core-api.md`：tool_call compose 约定（如需）

### 7. Validation
- [ ] `npm test`
- [ ] `npm run typecheck`
- [ ] 手工：TUI bash 确认；`--print` 无 `--yes` deny；`--yes` 放行

## Order rationale

policy/gate 先纯函数可测 → settings → hooks 接线 → CLI/bootstrap → TUI 最后（依赖 Approver 接口已稳定）。

## Risky files

| file | risk |
|---|---|
| `src/hooks/registry.ts` | 改变 tool_call 语义，破坏现有 hook 测试 |
| `src/bootstrap.ts` | 多路径装配（tui/print/json/gateway/resume）易漏 |
| `src/tui/harness-handle.ts` | replace 时 store/gate 生命周期 |
| `src/tui/App.tsx` | overlay 互斥 + abort 竞态 |
| `src/settings.ts` | nested merge / provenance 回归 |

## Rollback points

1. 合并前：仅 `permissions/` + tests，未接线 → 零行为变化
2. hooks compose 接线后：可用 settings `bash=allow` 临时恢复旧体验
3. TUI 未完成时：NonInteractive 路径已 fail-closed（行为更严，可接受）

## Validation commands

```bash
npm test
npm run typecheck
# manual
novi -p "run echo hi with bash"          # expect deny
novi --yes -p "run echo hi with bash"    # expect run
# TUI: ask bash → once / session / deny
```

## Context for sub-agents（JSONL 待 curation）

实现前向 `implement.jsonl` / `check.jsonl` 写入至少：
- `.trellis/spec/backend/directory-structure.md`
- `.trellis/spec/backend/pi-agent-core-api.md`
- `.trellis/spec/backend/error-handling.md`（若有降级约定）
- 本任务 `design.md` / `prd.md`
