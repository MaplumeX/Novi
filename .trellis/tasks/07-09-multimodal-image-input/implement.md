# Implement — Multimodal image input

## Execution Order

### 1. Encode + limits (backend)

1. 新增 `src/images/encode.ts`（+ `types` 可同文件）
   - 常量：`ALLOWED_IMAGE_MIMES` / `MAX_IMAGE_BYTES` / `MAX_PENDING_IMAGES` / ext→mime
   - `encodeImageBytes` / `loadImageFile` / `appendPending(list, item)`
2. `src/images/encode.test.ts`：合法 png 小文件、坏扩展名、超大、满 8 张
3. **Gate**: `npm test -- src/images/encode.test.ts`

### 2. Clipboard adapter

1. `src/images/clipboard.ts`：`ClipboardImageReader` + `createClipboardImageReader()`
   - darwin / linux / fallback
   - spawn + timeout + temp file cleanup
2. `src/images/clipboard.test.ts`：用可注入 reader 测 encode 集成；platform fallback 返回错误字符串
3. **Gate**: `npm test -- src/images`

### 3. File picker image mode

1. `src/tui/file-picker.tsx`：可选 `acceptExtensions?: string[]`（或 filter）
2. `App.tsx` overlay：`imagePicker` 分支；选中 → loadImageFile → addPending
3. 测试：filter 纯函数若可抽则单测
4. **Gate**: `npm test -- src/tui/file-picker.test.ts`（若有；否则随 commands）

### 4. Commands + pending context

1. `src/tui/commands.ts`
   - `CommandContext` 加 pending API
   - `/image`、`/image clear`、`/paste-image`
   - 更新 `COMMAND_HINT` / `/help` 描述
2. `src/tui/commands.test.ts`：path attach、clear、paste 用 fake reader 注入（若 paste 走 ctx 方法则 mock addPending）
3. **Gate**: `npm test -- src/tui/commands.test.ts`

### 5. App submit + Ctrl+I + pending UI

1. `src/tui/App.tsx`
   - `pendingImages` state
   - `handlePrompt/Steer/FollowUp` 传 images + non-vision warn + clear
   - pending 展示条
   - 组装 CommandContext
   - Ctrl+I 或经 InputBox 回调
2. `src/tui/InputBox.tsx`：Ctrl+I → `onPasteImage?.()`；可选展示 props
3. 抽 `maybeWarnNonVision` / `toPromptImages` 便于单测（可放 `src/tui/image-submit.ts`）
4. **Gate**: 相关 unit tests + `npm run typecheck`

### 6. MessageList badge

1. `src/tui/MessageList.tsx`：user 消息 image count
2. 若抽 `countImages(content)` 单测
3. **Gate**: `npm test -- src/tui`

### 7. Spec / ARCHITECTURE

1. 更新 `ARCHITECTURE.md`：images 模块、命令、提交 options
2. 更新 `.trellis/spec/backend/directory-structure.md`（`src/images/`）
3. 更新 `.trellis/spec/backend/pi-agent-core-api.md`（images options）
4. 更新 frontend state-management 若写 pending 归属
5. **Gate**: `npm test && npm run typecheck && npm run lint`

## Validation Commands

```bash
npm test
npm run typecheck
npm run lint
```

## Rollback Points

| 步骤 | 回滚 |
|---|---|
| 1–2 | 删 `src/images/` 即可 |
| 3–5 | 恢复 commands/App/InputBox；overlay 类型回退 |
| 6 | MessageList 单文件回退 |

## Out of Scope Reminders

- headless/gateway images
- Windows clipboard hard requirement
- image resize/compress
- `@` 语义变更
