# Implement — Novi agent v2: feature completion referencing pi

> Parent 执行计划。本轮为 parent + 7 child 结构，**parent 不直接实现**——每个 child 独立执行/implement/archive。本文件记录全局执行顺序、child 间交接协议、风险点。

## 执行顺序

严格按依赖顺序，一次一个 child（除非明确标注可并行）：

1. **child 1 `config-personalization`** — 基础设施（settings + overlay + harness holder 雏形 + context files + SYSTEM.md + `/settings` 表单 + `/reload`）。必须最先。
2. **child 2 `editor-capabilities`** — 依赖 child 1 overlay 抽象（@file fuzzy 用 filePicker overlay）。
3. **child 3 `message-queue-ux`** — 依赖 child 2 升级后的 InputBox。
4. **child 4 `session-management`** — 依赖 child 1 的 harness holder + replay 函数 + settings。
5. **child 5 `prompt-template-commands`** — 独立，改 commands.ts + cli fallback。可与 child 2-4 任一并行（但顺序执行更稳，减少 commands.ts 冲突）。
6. **child 6 `noninteractive-modes`** — 独立，改 cli.ts + 新 runHeadless。可与 child 5 并行。
7. **child 7 `observability`** — 依赖 child 1 settings（retry.provider）。最后做。

> 实操：每完成一个 child → check → archive → journal → 回到 parent 推进下一个。parent 的 `task.py start` 不执行（parent 不实现，只做 child 的容器与交叉验收）。

## 交接协议（child 间共享产物）

以下产物在 child 1 产出后，后续 child 直接复用（在 child 1 的 design/implement 里定稿）：

| 产物 | 来源 child | 复用 child |
|------|-----------|-----------|
| `src/settings.ts`（load/merge/settings 类型） | 1 | 4（重放）、7（retry） |
| `HarnessHandle` + `replayHarnessState()` | 1 | 4（session 切换） |
| overlay 抽象（`Overlay` union + App 渲染分支） | 1 | 2（filePicker） |
| `makeSystemPromptProvider` 扩展（contextFiles + SYSTEM.md/APPEND） | 1 | —（无后续依赖，但有 AC） |
| InputBox 升级版（cursor 模型） | 2 | 3（快捷键路由） |

交接时：前一个 child 的 AC 必须验证这些产物可用，否则下一个 child 无法开始。

## 风险点

### R1: harness 重建的订阅泄漏（child 1/4）
重建 harness 时若旧 `subscribe()` 返回的 unsubscribe 未调用，会导致事件监听叠加。实现时：`useHarnessState` 的 `useEffect` cleanup 必须调 unsubscribe，且依赖数组必须含 `handle.harness`（变化触发重订阅）。check 时手动验证：`/new` 后发消息，事件不应触发两次。

### R2: overlay 输入路由与 InputBox 冲突（child 1/2）
overlay 接管输入时，InputBox 的 `useInput` 仍在监听。必须在 `<App>` 层根据 overlay 决定谁处理输入：overlay 非空时 InputBox 不挂载或跳过 `useInput`。否则同一按键被两处处理。

### R3: /settings 表单写入磁盘的并发（child 1）
表单保存时要写 `~/.novi/settings.json`（全局默认）或 `.novi/settings.json`（项目）。需处理：文件不存在时创建；写时原子化（先写 tmp 再 rename，或直接 JSON.stringify + writeFileSync，规模小可接受）。不做文件锁（单进程交互式工具，无并发）。

### R4: JSON 模式事件不可序列化字段（child 6）
harness 事件含 Model 实例、AbortSignal、函数等。`projectEvent` 必须显式映射白名单字段，不能裸 `JSON.stringify`（会丢函数/报错）。child 6 design 里定字段集，check 时验证不会因新事件类型 crash（unknown event type → 输出 `{ type, _raw: "unknown" }`）。

### R5: stdin 合并的阻塞（child 6）
`process.stdin` 在非 TTY 时读流到 EOF。必须用 async 读取 + 处理空 stdin（无内容时不拼接）。不能阻塞整个进程。

### R6: child 间的 commands.ts 冲突
child 5 加 prompt-template fallback 到 `runCommand`；child 1 加 `/settings` `/reload`；child 4 改 `/new` `/resume` 实现；child 7 加 `/session`。都改 `src/tui/commands.ts`。顺序执行（不并行改同一文件）可避免冲突。child 5 的 fallback 逻辑放在 `runCommand` 末尾（在 COMMANDS 查找失败后 fallback 到 promptTemplates），不影响其他 child 加的命令。

## rollback points

- child 1 若 overlay/harness holder 改动过大导致现有功能回归 → 回退到「harness 直接 props」模型，`/settings` 降级为只读展示（但用户已确认要表单，优先修不回退）。
- child 4 若 harness 重建不稳定 → `//new` `/resume` 可降级回 stub（但本轮 AC 要求真正切换，优先修）。

## 全局验证（parent 交叉验收前）

所有 child 完成后，在 parent 这一层做交叉验收（见 prd.md Acceptance Criteria · Parent 交叉验收），跑 `tsc --noEmit` + `eslint` + `vitest` 全绿，并手动跑一遍集成流程：settings 生效 → session 切换 → editor @/! 编辑 → queue steer/followUp → prompt template → -p/json → StatusBar 用量。
