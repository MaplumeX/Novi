# E: non-interactive modes (print + stdin + json)

## Goal

使 Novi 可脚本化/headless：`-p`/`--print` 模式发一次 prompt 打印 assistant 最终文本退出；`--mode json` 模式输出全事件 JSONL 到 stdout；stdin 合并（`!isTTY` 时 piped stdin 内容拼到 prompt 前）。

**依赖关系**：无前置依赖（独立，绕过 Ink TUI）。

## Background — 已确认事实

### 当前 cli.ts
- `parseArgs` 解析 `--provider`/`--model`/`--cwd`/`--resume`/`--help`。
- 无 `--print` / `--mode`。
- 总是调 `renderApp`（Ink TUI）。

### harness 事件（见 spec/backend/pi-agent-core-api.md）
- `subscribe(fn)` 收 `AgentHarnessEvent` 联合。
- `message_end` { message } 含 assistant 最终文本。
- `agent_end` { messages } 标志完成。
- 事件含 Model 实例、AgentMessage（content 可能含非序列化字段）——需投影函数剔除。

## Requirements

### R1 print 模式 (`-p`/`--print`)
- `novi -p "prompt"` → 不启 TUI → `harness.prompt("prompt")` → 等 `agent_end` → 取最后 assistant message 的 plain text → stdout.write → exit 0。
- 失败（harness error）：stderr + exit 1。
- 无 prompt 参数 + stdin 有内容：stdin 作为 prompt。

### R2 stdin 合并
- `!process.stdin.isTTY` 时，读 stdin 到 EOF → 拼到 prompt 前：`<stdin>\n\n<prompt>`（若 prompt 为空则仅 stdin）。
- TTY 时不读 stdin（交互模式不受影响）。

### R3 JSON 模式 (`--mode json`)
- `novi --mode json "prompt"` → 不启 TUI → subscribe 全事件 → 投影为 plain object → stdout.write(JSON.stringify + "\n") → `harness.prompt` → `agent_end` 后 exit 0。
- 投影函数 `projectEvent(event)`：白名单字段，剔除函数/Model 实例/AbortSignal。未知事件 → `{ type, _raw: "unknown" }`。
- 失败：stderr + exit 1（尽量在 exit 前输出 error 事件 JSON）。

### R4 print 与 json 互斥
- `-p` 与 `--mode json` 同时给 → 报错（mutually exclusive）或 json 优先。定为：同时给 → stderr error + exit 1。

## Acceptance Criteria

- [ ] `novi -p "hello"` 打印 assistant 文本 + exit 0（无 TUI 启动）。
- [ ] `echo "content" | novi -p "summarize"` stdin 内容拼到 prompt 前。
- [ ] `novi --mode json "hello"` 输出全事件 JSONL 到 stdout + exit 0。
- [ ] JSON 事件含 type 字段，不含函数/Model 实例（可 JSON.stringify）。
- [ ] `-p` 与 `--mode json` 同时用 → stderr error + exit 1。
- [ ] harness 失败时 stderr + exit 1。
- [ ] `tsc --noEmit` + `eslint` + `vitest` 全绿。

## Out of Scope

- RPC 模式（stdin/stdout 双向 JSON-RPC）——后置。
- 交互模式下的 stdin 合并——只 print/json 模式读 stdin。

## Technical Notes

- 详细设计见 child 6 的 `design.md`：projectEvent 字段白名单 + runHeadless 流程。
- 本 child 的 `implement.md` 给出文件改动清单。
