# Implement — E: non-interactive modes

## 文件改动清单

| 文件 | 动作 | 内容 |
|------|------|------|
| `src/headless/events.ts` | 新增 | `projectEvent` 投影函数 + `extractText` helper |
| `src/headless/events.test.ts` | 新增 | projectEvent 各 event type 单测 |
| `src/headless/stdin.ts` | 新增 | `readStdinIfPiped` |
| `src/headless/run.ts` | 新增 | `runPrint` + `runJson` |
| `src/cli.ts` | 改 | 加 `--print`/`-p` `--mode` flags + 互斥校验 + 分流 |

## 执行步骤

### 1. events.ts + 单测
- `extractText(content)`: string | ContentPart[] → text 拼接。
- `projectEvent(event)`: 白名单字段投影，unknown → { type, _raw:"unknown" }。
- 单测覆盖每种已知 event type + unknown + 验证可 JSON.stringify（无函数/Model 实例）。
- **validation**: `npx vitest run src/headless/events.test.ts` 绿。

### 2. stdin.ts
- `readStdinIfPiped()`: TTY → null；否则读流。
- **validation**: `tsc --noEmit` 绿。

### 3. run.ts
- `runPrint`: subscribe 抓 message_end assistant text → prompt → stdout → exit 0。
- `runJson`: subscribe 全事件 → projectEvent → JSONL → stdout → prompt → agent_end → exit 0。
- 失败 → stderr + exit 1。
- **validation**: `tsc --noEmit` 绿。

### 4. cli.ts 分流
- 加 `print`/`mode` options；互斥校验；分流 runPrint/runJson/renderApp。
- allowPositionals 取 prompt 文本。
- **validation**: 手测 `tsx src/cli.ts -p "hello"` + `--mode json "hello"` + `echo | -p`。

### 5. 全量验证
- `npx tsc --noEmit` / `npx eslint .` / `npx vitest run`。
- 手测集成：-p + stdin + --mode json + 互斥报错 + 失败 exit 1。

## 完成判据（见 prd AC）

全部 AC 勾选 + tsc/eslint/vitest 三绿。
