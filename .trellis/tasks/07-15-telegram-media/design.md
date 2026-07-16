# Design — Telegram inbound media (image/file/voice)

> Child of `07-15-channel-media-feishu-semantics`. P0，执行顺序第二棒。
> 依赖 `07-15-channel-unified-semantics`（已 archive）的 `ChannelMessage.attachments?` / `images?` / `AgentProtocolTurnInput.images?` 契约。

## 1. 架构与边界

本任务只改 `src/gateway/channels/telegram.ts` + 配套下载/落盘工具 + 测试。不改 core 契约（已由 semantics child 落地）。改动分三块：

1. 入站 handler 注册 photo/document/voice，归一化为 `ChannelMessage.attachments`。
2. 图片下载 → base64 → `ChannelMessage.images`（运行时）；文件/语音下载 → 落盘 → `localPath` + turn text 注入。
3. 不支持类型（sticker/animation/video）诊断不崩溃。

`ChannelMessage.images` 由 semantics child 定义，session-lane → `AgentProtocolTurnInput.images` → `NoviAgentAdapter.runTurn` → `harness.prompt(text, images)` 透传链已就绪。本任务只需在 Telegram 入站时填充 `images`。

## 2. 数据流与契约改动

### 2.1 入站 handler 注册（`telegram.ts`）

现有只注册 `message("text")`。新增：

```ts
this.bot.on(message("photo"), async (ctx) => {
  await this.handleMediaMessage(ctx, "image");
});
this.bot.on(message("document"), async (ctx) => {
  await this.handleMediaMessage(ctx, "file");
});
this.bot.on(message("voice"), async (ctx) => {
  await this.handleMediaMessage(ctx, "voice");
});
```

`handleMediaMessage` 统一处理：提取 caption（`ctx.message.caption`）、file_id、file metadata，调 `normalizeMediaMessage` 产出 `ChannelMessage`，再 `emitMessage`。

### 2.2 归一化 `ChannelMessage`

**photo（`PhotoSize[]`）**：取最大尺寸（`photo[photo.length-1]`）的 `file_id` / `file_unique_id` / `file_size`。`kind: "image"`。

**document（`Document`）**：`file_id` / `file_name` / `mime_type` / `file_size`。`kind: "file"`。注意 animation/sticker 也走 document 消息类型，需按 `ctx.message.animation` / `ctx.message.sticker` 排除（见 §2.5）。

**voice（`Voice`）**：`file_id` / `mime_type`（通常 `audio/ogg`）/ `file_size` / `duration`。`kind: "voice"`。

caption 作为 `ChannelMessage.text`；无 caption 时 text 为空串 `""`（不阻塞 agent turn，harness 允许空文本 + images）。

```ts
private normalizeMediaMessage(
  chat: TgChat,
  tgMsg: Message.PhotoMessage | Message.DocumentMessage | Message.VoiceMessage,
  from: TgUser,
  updateId: number,
  kind: ChannelAttachmentKind,
): ChannelMessage {
  const attachment = this.extractAttachment(tgMsg, kind);
  const text = "caption" in tgMsg ? (tgMsg.caption ?? "") : "";
  return {
    ...this.baseMessageFields(chat, tgMsg, from, updateId, text),
    attachments: [attachment],
    images: kind === "image" ? await this.downloadAsImages(attachment) : undefined,
    metadata: { ...baseMetadata, telegramMediaType: kind },
  };
}
```

> 注：`normalizeMediaMessage` 是 async（图片需下载）。现有 `normalizeMessage` 是 sync。`emitMessage` 已是 async，无问题。

### 2.3 下载与落盘

**图片（kind=image，D4 多模态直通）：**
- `bot.telegram.getFile(file_id)` → `file_path`
- 下载为 `Buffer` → base64 → `ImageContent`（复用 `src/images/encode.ts` 的 `encodeImageBytes` 做 mime/size 校验）
- 填 `ChannelMessage.images: ImageContent[]`
- **不落盘**（图片走 base64，不存 localPath；inbox 不持久化 images）

**文件/语音（kind=file/voice，D4 落盘注入）：**
- `bot.telegram.getFile(file_id)` → `file_path` → 下载为 `Buffer`
- 落盘到 `$NOVI_HOME/gateway-media/<route-key-hash>/<file_unique_id>-<filename>`
- 填 `ChannelAttachment.localPath`（相对 `$NOVI_HOME` 的相对路径）
- turn text 注入：session-lane `runTurn` 构造 `AgentProtocolTurnInput` 时，若 `msg.attachments` 含 file/voice 且有 `localPath`，追加说明到 text（见 §2.4）

**下载 API 抽象：** 为可测试性，注入 `downloadFile(fileId): Promise<Buffer>` 接口（类似现有 `pollingApi`）。生产实现用 `bot.telegram.getFile` + HTTP GET `file_path`；测试用 mock。

**落盘路径布局：**
```
$NOVI_HOME/gateway-media/
  <sessionKey-hash-prefix-2>/
    <file_unique_id>-<sanitized-filename>
```
- 按 sessionKey 哈希前两位分片（类似 message store），避免单目录过多文件。
- `localPath` 存相对 `$NOVI_HOME` 的路径（如 `gateway-media/ab/<id>-photo.jpg`），使记录可迁移。
- 文件权限 `0o600`，目录 `0o700`（与 message store 一致）。

**清理：** 本任务实现最小清理——媒体文件随 inbox 记录生命周期。inbox terminal（completed/failed/dismissed）清理时，关联的 media 文件一并删除。若实现复杂度过高，可降级为「仅记录 localPath，清理留后续」并在 design 标注。**决定：降级**——本任务只负责落盘与记录 localPath，不实现自动清理（避免与 message store cleanup 耦合过深）；在 prd/implement 标注为已知 follow-up。

### 2.4 文件/语音 → turn text 注入

session-lane `runTurn` 已透传 `msg.images` 到 `AgentProtocolTurnInput.images`。但文件/语音需要把路径信息注入 text，让 Agent 能「看到」文件。

**注入点：** `session-lane.ts` `runTurn` 构造 `AgentProtocolTurnInput` 时，若 `msg.attachments` 含 file/voice 且有 `localPath`，在 `text` 末尾追加附件说明：

```
<original caption or empty>

[attachment: file "report.pdf" (application/pdf, 12345 bytes) at gateway-media/ab/<id>-report.pdf]
```

**谁注入？** semantics child 的 design §2.3 决定 images 由 session-lane 透传。但 text 注入文件信息是 telegram-media child 的职责（只有它知道 localPath 语义）。**最小改动：在 session-lane `runTurn` 加一个 helper，从 `msg.attachments` 构造附件说明追加到 text。** 这需要改 session-lane，但改动是通用的（不只 Telegram），且飞书未来也可复用。

**替代方案（更干净）：** 在 `GatewayApp.processAccepted` 或 channel 层就把附件说明注入 `msg.text`。但这会改变持久化到 inbox 的 text（包含附件说明），不利于重试。**决定：在 session-lane `runTurn` 注入**——inbox 持久化原始 caption，运行时才追加附件说明，重试时重新构造。

### 2.5 不支持类型诊断

- `message("document")` handler 内检查 `ctx.message.animation` / `ctx.message.sticker` → 这些虽走 document 消息类型，但不是普通文件。
- 若检测到 animation/sticker：不填 `attachments`，`metadata.unsupported = "animation"|"sticker"`，text 可为占位说明（如 `[unsupported media type: animation]`），emitMessage 正常走（Agent 会看到说明）。
- video/video_note 不注册 handler → 走 telegraf 默认（不触发我们的 handler），不会崩溃。
- **不伪造成成功媒体**（不填 attachments）。

### 2.6 polling `allowed_updates` 扩展

现有 `getUpdates` 只请求 `["message"]`。photo/document/voice 仍是 `message` 类型，所以 `allowed_updates: ["message"]` 已覆盖，**无需改动**。

## 3. 兼容性与迁移

- 现有 `message("text")` handler 不变；新增三个 handler 独立注册。
- `normalizeMessage`（text）保持 sync；新增 `normalizeMediaMessage` async。
- `ChannelMessage.attachments` / `images` 已由 semantics child 落地，inbox schema 已兼容。
- `service.accept` 已透传 `attachments`；`images` 不持久化（已由 semantics child 保证）。
- 无 schema version 变化。

## 4. Trade-offs

| 选择 | 理由 | 代价 |
|------|------|------|
| 图片不落盘只走 base64 | 链路最短，复用 TUI vision 路径 | crash 恢复需从 Telegram 重新下载（file_id 有效期内可重下） |
| 文件/语音落盘 + text 注入 | Agent 可操作真实文件路径 | 需管理落盘文件生命周期（本任务降级不清理） |
| 下载抽象为可注入接口 | 可测试（mock 下载） | 多一层接口 |
| 附件说明在 session-lane 注入 | inbox 持久化原始 text，运行时注入 | session-lane 需改（但通用） |

## 5. 回滚

仅 Telegram channel + session-lane 注入 + 测试。revert commit 即可；core 契约不受影响（semantics child 已独立提交）。

## 6. 验证

- `npm run typecheck` / `npm test` / `npm run lint` / `npm run build` 全绿。
- 新增单测：
  - `telegram.test.ts`：photo/document/voice 入站归一化（mock 下载）、不支持类型诊断、caption 透传。
  - `session-lane.test.ts`：文件/语音附件说明注入 text。
  - 落盘工具单测：路径布局、文件权限、sanitized filename。
- 现有 Telegram 文本路径回归无破坏。