# Design — Multimodal image input

## Overview

在 **不改 pi-agent-core** 的前提下，为 Novi TUI 增加 pending image 附件层：

1. **编码层**（纯 backend 可测）：文件 / 字节 → 校验 → `ImageContent`
2. **剪贴板适配器**：平台读图 → 字节 + mime
3. **TUI 状态 + 命令/快捷键**：pending 列表、附加/清空、提交时注入 `options.images`
4. **展示**：pending 条 + MessageList user 消息 image 计数

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│ TUI                                                      │
│  pending: PendingImage[]  (App or lifted state)          │
│  /image [path] | /image clear | /paste-image | Ctrl+I    │
│  submit → harness.prompt|steer|followUp(text, {images})  │
│  MessageList: user content image count badge             │
└───────────────────────┬─────────────────────────────────┘
                        │
        ┌───────────────┼────────────────┐
        ▼               ▼                ▼
  image-encode.ts   clipboard.ts    file-picker (image filter)
  (bytes→ImageContent) (platform)   (reuse + ext filter)
```

依赖方向：`clipboard` / `image-encode` 只依赖 node stdlib + `ExecutionEnv`（文件读）；TUI 依赖二者；**不**引入 sharp/jimp。

## Data model

```ts
// src/images/types.ts (or image-encode.ts)
export interface PendingImage {
  id: string;           // uuid or incremental
  label: string;        // basename or "clipboard-1.png"
  image: ImageContent;  // { type:"image", data: base64, mimeType }
  byteLength: number;   // raw bytes before base64
}

export const IMAGE_MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export const ALLOWED_IMAGE_MIMES = new Set(Object.values(IMAGE_MIME_BY_EXT));
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MiB
export const MAX_PENDING_IMAGES = 8;
```

## Component design

### 1. `src/images/encode.ts` — 纯函数 + env 读文件

```ts
encodeImageBytes(bytes: Uint8Array, mimeType: string, label: string): Result<PendingImage, string>
loadImageFile(env: ExecutionEnv, path: string): Promise<Result<PendingImage, string>>
```

规则：
- mime 不在白名单 → error
- `bytes.byteLength > MAX_IMAGE_BYTES` → error
- 文件：扩展名 → mime；未知扩展名 → error（不靠 magic bytes MVP）
- base64：`Buffer.from(bytes).toString("base64")`
- 调用方负责 pending 数量上限（或 `appendPending(list, item)` helper 统一检查）

### 2. `src/images/clipboard.ts` — 平台适配

```ts
export interface ClipboardImageReader {
  readImage(): Promise<Result<{ bytes: Uint8Array; mimeType: string }, string>>;
}

export function createClipboardImageReader(): ClipboardImageReader
```

- **darwin**：优先 `osascript` 写临时 PNG，或探测 `pngpaste`；失败返回可读 reason  
  推荐实现：`osascript` + 临时文件（无额外依赖）：
  - 检查 clipboard 是否有图片
  - 写到 `os.tmpdir()/novi-clipboard-<pid>.png`
  - 读字节后 unlink
- **linux**：尝试 `wl-paste -t image/png` / `xclip -selection clipboard -t image/png -o`
- **其他**：固定 error `"clipboard images not supported on this platform"`

所有 spawn 带 timeout；失败不抛到 harness。

测试：注入 fake reader；不在 CI 真读系统剪贴板。

### 3. Pending 状态归属

**`App.tsx` 持有 `pendingImages` state**（与 `editorState` 同级），原因：
- 提交路径在 App（`handlePrompt/Steer/FollowUp`）
- 命令在 `runCommand` 需 `ctx` 回调增删 pending
- InputBox 只负责展示条 + 转发 Ctrl+I

`CommandContext` 扩展：
```ts
pendingImages: PendingImage[];
addPendingImages: (items: PendingImage[]) => void; // 内部 enforce max 8
clearPendingImages: () => void;
```

### 4. 命令

| 命令 | 行为 |
|---|---|
| `/image <path>` | resolve path（相对 cwd）→ `loadImageFile` → add |
| `/image` | `setOverlay({ kind: "imagePicker" })` 或复用 filePicker + `mode: "image"` |
| `/image clear` | clear pending |
| `/paste-image` | clipboard reader → encode → add |

`COMMAND_HINT` 追加 `/image` `/paste-image`。

**image picker**：扩展 `file-picker.tsx` 接受可选 `extensions?: string[]` 或 `filter?: (path)=>boolean`；`/image` 打开时只列 png/jpg/gif/webp。选中回调改为 `onAttachImage(path)` 而非 `onInsertPath`。

Overlay 类型：
```ts
| { kind: "filePicker" }           // 现有 @ 
| { kind: "imagePicker" }          // /image 无参
```

### 5. 提交

```ts
function submitOptions(pending: PendingImage[]): { images?: ImageContent[] } {
  if (pending.length === 0) return {};
  return { images: pending.map(p => p.image) };
}

function handlePrompt(text: string) {
  maybeWarnNonVision(pending);
  const opts = submitOptions(pending);
  recordHistory(text);
  setPending([]);
  harness.prompt(text, opts).catch(...);
}
// steer / followUp 同理
```

`maybeWarnNonVision`：
```ts
const model = harness.getModel();
const vision = Array.isArray(model.input) && model.input.includes("image");
if (!vision && pending.length > 0) {
  print(`warning: model ${model.provider}/${model.id} does not advertise image input; images may be omitted`);
}
```

空文本 + 有图：允许提交（不因 `text.trim()===''` 拦截）。若 **无图且空文本**，保持现有行为（通常不提交 / no-op——与现 InputBox 一致）。

### 6. Ctrl+I

在 `InputBox` 或 `App` 的 `useInput`：
- `key.ctrl && value === "i"`（且非 meta）→ 调用与 `/paste-image` 相同的 handler
- 不与现有 Ctrl+O / Ctrl+P / Ctrl+C / Ctrl+G 冲突（当前无 Ctrl+I）

### 7. MessageList

user 消息渲染：
```ts
const imageCount = Array.isArray(content)
  ? content.filter(c => c.type === "image").length
  : 0;
// 文本 collectText 后，若 imageCount>0 追加 dim 行：`[image ×${imageCount}]`
```

不渲染 base64，不依赖终端图片协议。

### 8. Pending UI

输入框上方一行（theme.dim / accent）：
```
attachments (2/8): screenshot.png · clipboard-1.png
```
可选：无独立 remove-by-index MVP；清空用 `/image clear`。

## Error handling

| 失败 | 行为 |
|---|---|
| 文件不存在 / 不可读 | print，不改 pending |
| 坏扩展名 / mime | print |
| 超 10MiB | print |
| pending 已满 | print `pending full (8/8)` |
| 剪贴板无图 / 超时 / 不支持 | print |
| harness.prompt reject | print；pending 已 clear（接受：与文本提交失败一致不回滚附件） |

**取舍**：提交后先 clear 再 prompt；若 prompt 同步 throw 极少见。与当前文本路径一致（text 也已清空）。

## Testing strategy

| 层 | 测试 |
|---|---|
| encode | mime/size/base64/file load 用 temp files |
| clipboard | fake reader + createClipboard factory 分支（mock process.platform） |
| commands | `/image` path/clear/paste 通过 CommandContext mock |
| MessageList / collect | image count 纯函数可抽测 |
| App 提交 | 尽量单测 `submitOptions` + warn helper；全 App 不强 e2e |

## Spec / docs touchpoints

- `ARCHITECTURE.md` §6 命令与输入附件
- `.trellis/spec/backend/directory-structure.md` 若新增 `src/images/`
- `.trellis/spec/frontend/state-management.md` pending 归属
- `.trellis/spec/backend/pi-agent-core-api.md` 补 `prompt/steer/followUp` images 选项

## Risks

| 风险 | 缓解 |
|---|---|
| 剪贴板在 CI/无 GUI 失败 | 适配器可注入；slash 可测；平台失败仅 notice |
| 大 base64 进 session JSONL | 10MiB×8 上限；接受 session 变大 |
| Ctrl+I 终端冲突 | 少见；文档写明；另有 `/paste-image` |
| file picker 过滤漏网 | 附加时再 encode 校验一层 |
