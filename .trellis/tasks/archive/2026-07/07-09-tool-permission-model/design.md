# Design: Tool permission model

## Summary

在 core `tool_call` hook 点插入内置 **PermissionGate**：解析 settings 策略 → 对 `ask` 走 UI/非交互裁决 → 与用户 hooks **deny-sticky compose** → 返回 `{block, reason}`。

## Architecture

```
tool_call (core beforeToolCall)
        │
        ▼
┌───────────────────────┐
│ PermissionGate        │  src/permissions/
│ 1. resolve decision   │  - policy.ts   (defaults + merge + tighten)
│ 2. apply session grant│  - gate.ts     (runtime evaluate + session grants)
│ 3. ask via Approver   │  - types.ts
└───────────┬───────────┘
            │ allow | deny
            ▼
┌───────────────────────┐
│ User tool_call hooks  │  existing src/hooks/ (scripts)
│ (only if not already  │
│  hard-denied? or run  │  compose: final = stickyDeny(perm, user)
│  always then compose) │
└───────────┬───────────┘
            │
            ▼
     { block?, reason? } → core
```

**推荐 compose 顺序（实现）**：
1. 先算 permission decision（含 ask 等待）。
2. 若 permission = deny → 直接返回 block（可仍 fire 用户 hooks 做审计，但 **忽略其 allow**；MVP 为简单可不 fire，文档写明；推荐 **仍 fire 用户 hooks 仅当 permission 非 deny**，对应 D5「allow 后 hook 可再 block」且避免无意义 spawn）。
3. 若 permission = allow → 跑用户 hooks；用户 block 则 block。

这等价于 deny sticky，且用户 hook 不能放行 permission deny。

## Settings contract

```ts
// NoviSettings
permissions?: {
  tools?: Record<string, "allow" | "ask" | "deny">;
};

// Built-in defaults (not written to disk)
const DEFAULT_PERMISSIONS = { tools: { bash: "ask" } };
```

### Resolve algorithm

```
base = DEFAULT_PERMISSIONS.tools          // bash: ask
merge global.permissions.tools (override by tool name)
merge project.permissions.tools with TIGHTEN-ONLY:
  severity: allow=0, ask=1, deny=2
  projectValue accepted only if severity(project) >= severity(current)
apply CLI --yes:
  any tool with effective "ask" becomes "allow"
```

`/reload`：重新 `resolvePermissions(resolvedSettings, { yes })`；**不清空** `SessionPermissionStore`。

Provenance：`_sources["permissions.tools.bash"]` 尽量记录；若现有 settings provenance 只支持叶路径，按现有 pattern 扩展。

## Runtime components

### `src/permissions/types.ts`
- `PermissionLevel = "allow" | "ask" | "deny"`
- `PermissionDecision = { level, source, reason? }`
- `ApprovalChoice = "once" | "session" | "deny"`
- `Approver` interface:  
  `request(req: { toolName, toolCallId, input, summary }): Promise<ApprovalChoice>`
  - TUI 实现：显示 overlay，Promise resolve 用户选择
  - Headless 实现：直接 resolve `"deny"`（或当 yes 时根本不会 ask）

### `src/permissions/policy.ts`
- `DEFAULT_TOOL_PERMISSIONS`
- `resolveToolPermission(toolsMap, toolName): PermissionLevel`
- `mergePermissionsTightenOnly(base, project): map`
- `resolvePermissionsFromSettings(resolved, opts: { yes?: boolean }): ResolvedPermissions`

### `src/permissions/gate.ts`
- `SessionPermissionStore`: `Set<string>` of tool names granted for session
- `PermissionGate` class:
  - `constructor({ permissions, approver, store })`
  - `async onToolCall(event): Promise<{block?, reason?} | undefined>`
  - `setPermissions(next)` for reload
- 逻辑：
  1. if store.has(toolName) → allow
  2. level = resolve(toolName)
  3. deny → `{ block:true, reason }`
  4. allow → undefined (allow)
  5. ask → await approver.request(...)
     - once → allow this call
     - session → store.add + allow
     - deny → block

### Registration

**不要**只靠 `harness.on` 注册顺序赌 last-wins。

两种可选：
- **A（推荐）**：`registerPermissionGate(harness, gate)` 注册内置 `tool_call` handler；改造 `registerHooks` 使 tool_call dispatcher 与 gate **显式 compose**（hooks/registry 增加可选 `composeToolCall?: (event, userResult)=>...` 或 permission 包一层 `registerHooks`）。
- **B**：permission 作为 hooks 系统的「内置 matcher group」插入 — 耦合重，不推荐。

推荐 **A**：
```ts
// bootstrap / createHarnessForSession / replayHarnessState
const gate = new PermissionGate({ permissions, approver, store });
registerHooks(harness, hookConfig, deps, { permissionGate: gate });
```

`registerHooks` 对 `tool_call`：
```
async (event) => {
  const perm = await gate.onToolCall(event);
  if (perm?.block) return perm;           // hard deny, skip user hooks (MVP)
  const user = await runUserToolCallHooks(event);
  if (user?.block) return user;
  return user ?? perm; // both allow → undefined
}
```

若未来要审计「被 permission deny 的调用」，可再加 always-run audit hooks。

## TUI integration

### Approver
- `TuiApprover` 持有 `pending: null | { req, resolve }`
- `request()` 若已有 pending：串行排队（tool calls 可能并行？检查 core）

**并行 tool calls**：需确认 core 是否并行 `beforeToolCall`。若并行，Approver 必须 queue。设计按 **queue** 实现，安全。

### UI
- 新 overlay：`kind: "permission"`（或独立非 overlay 的 sticky panel）
- 显示：
  ```
  Allow tool: bash
  command: git status
  [1] Allow once  [2] Allow for this session  [3] Deny
  ```
- 键位：`1/2/3` 或 ↑↓+Enter；Esc=Deny
- `useHarnessState` / App：phase 可保持 `turn`；额外 `permissionPrompt` state 来自 Approver 订阅，不必新 phase（避免 idle 误判）。  
  若需禁用普通输入：`overlay !== null` 已有互斥。

### Summary 提取
- `summarizeToolInput(toolName, input)`：
  - bash → `command`
  - write/edit → `path`
  - 默认 → JSON 截断

## Headless / gateway

- `NonInteractiveApprover`：`request()` → `"deny"`（防御性；正常路径 ask 已被 `--yes` 变成 allow 或 policy deny）
- bootstrap 根据 `hasUI` 选择 Approver：
  - TUI path: TuiApprover
  - print/json/gateway: NonInteractiveApprover
- `--yes` 在 `resolvePermissionsFromSettings` 阶段处理，不进 Approver

## CLI

```
--yes    Auto-approve tools that would ask (ask→allow). Not project trust.
```

`parseArgs` 增加 `yes: { type: "boolean", default: false }`  
互斥：无（可与 `--approve` 并存）

传入 `BootstrapOptions.yes` → `GatewayEnv` / `BootstrapResult` → gate 构造。

## Harness rebuild

`HarnessHandle.replace` / `replayHarnessState`：
- 重解析 permissions（from resolvedSettings or reload）
- **复用同一 `SessionPermissionStore` 实例**（挂在 handle 或 App 级，不随 harness 重建丢）
- 重新 registerHooks + gate 绑定新 harness
- TuiApprover 可复用（仍绑定 React setState）

## Settings UI

`SettingsForm` 增加可编辑字段（最小）：
- `permissions.tools.bash` select: allow|ask|deny
或通用 text map（MVP 至少一个 bash 字段即可）

## Error / reason strings

| case | reason |
|---|---|
| deny by policy | `permission denied: <tool> (deny)` |
| ask + non-interactive | `permission denied: <tool> (ask, non-interactive; pass --yes to allow)` |
| user deny in TUI | `permission denied: <tool> (blocked by user)` |
| user hook block | 沿用 hook reason |

## Testing strategy

- unit: policy merge + tighten-only + defaults + `--yes`
- unit: gate session store once/session/deny
- unit: registerHooks compose deny sticky
- integration-ish: NonInteractiveApprover auto deny
- TUI Approver 可用 mock promise，不必全 Ink e2e

## Risks

| risk | mitigation |
|---|---|
| core 并行 tool_call | Approver 队列化 |
| last-wins 踩踏用户 hook | 显式 compose，不靠注册顺序 |
| project 放宽权限 | tighten-only merge |
| `/reload` 丢 session grants | store 提升到 handle 外生命周期 |
| turn 中确认时用户 abort | abort 应 reject pending approvals as deny |

## Rollback

整特性开关可用：若 `permissions` 解析失败 → 回退 defaults；极端情况可后续加 `permissions.enabled=false`（**本 MVP 不做**，避免绕过）。
