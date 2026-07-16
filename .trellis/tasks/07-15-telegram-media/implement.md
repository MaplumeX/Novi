# Implement — Telegram inbound media (image/file/voice)

> P0，执行顺序第二棒。依赖 `channel-unified-semantics`（已 archive）。

## 前置条件

- [x] `channel-unified-semantics` 已完成并 archive（契约已落地）
- [ ] prd.md / design.md 已 review
- [ ] 当前 active task = `07-15-telegram-media`，status = planning

## 执行清单（按顺序）

### A. 下载/落盘工具（`src/gateway/channels/telegram-media.ts` 新文件）
1. [ ] `DownloadResult` 类型 + `MediaDownloader` 接口（`download(fileId): Promise<Buffer>`）。
2. [ ] `saveAttachmentFile(noviDir, sessionKey, fileUniqueId, filename, bytes): Promise<string>` —— 落盘到 `$NOVI_HOME/gateway-media/<hash-prefix-2>/<id>-<filename>`，权限 0o600/0o700，返回相对 `$NOVI_HOME` 路径。
3. [ ] `sanitizeFilename(name): string` —— 防路径穿越。
4. [ ] `attachmentDescription(attachments): string` —— 从 attachments 构造 `[attachment: ...]` 说明文本。
5. [ ] 单测 `telegram-media.test.ts`：落盘路径、权限、sanitized filename、attachmentDescription。

### B. Telegram handler 注册（`src/gateway/channels/telegram.ts`）
6. [ ] 新增 `MediaDownloader` 可注入字段（类似 `pollingApi`）。
7. [ ] 注册 `message("photo")` / `message("document")` / `message("voice")` handler。
8. [ ] `handleMediaMessage(ctx, kind)`：提取 caption + file_id + metadata → `normalizeMediaMessage` → `emitMessage`。
9. [ ] `normalizeMediaMessage`（async）：构造 `ChannelAttachment`（kind/mimeType/size/filename/remoteFileId）。
10. [ ] 图片：下载 → `encodeImageBytes` → `ChannelMessage.images`（不落盘）。
11. [ ] 文件/语音：下载 → `saveAttachmentFile` → `ChannelAttachment.localPath`。
12. [ ] document handler 内排除 animation/sticker（`metadata.unsupported`，不填 attachments）。
13. [ ] 无 caption 时 text = `""`。
14. [ ] 单测 `telegram.test.ts`：photo/document/voice 归一化（mock downloader）、不支持类型、caption 透传、images 填充。

### C. session-lane 附件说明注入（`src/gateway/core/session-lane.ts`）
15. [ ] `runTurn`：构造 `AgentProtocolTurnInput` 时，若 `msg.attachments` 含 file/voice 且有 `localPath`，追加 `attachmentDescription` 到 text。
16. [ ] 单测 `session-lane.test.ts`：文件附件说明注入 text；图片不注入 text（走 images）。

### D. 验证
17. [ ] `npm run typecheck && npm test && npm run lint && npm run build` 全绿。
18. [ ] 现有 Telegram 文本路径回归无破坏。

## 验证命令

```bash
npm run typecheck
npm test
npm run lint
npm run build
```

## 风险点 / 回滚

- 风险：图片下载超时/失败阻塞 emitMessage → 3 秒时限。缓解：下载失败时降级（不填 images，text 注入说明「图片下载失败」），不阻塞 emitMessage。
- 风险：大文件下载超时。缓解：文件/语音下载失败同样降级（不填 localPath，text 注入说明）。
- 风险：落盘文件无限增长。本任务降级不清理，标注为 follow-up。
- 回滚：revert commit；core 契约不受影响。

## 审查门

- [ ] typecheck + test + lint + build 全绿
- [ ] photo/document/voice 入站单测覆盖（含 mock 下载）
- [ ] 不支持类型诊断单测
- [ ] session-lane 附件说明注入单测
- [ ] 现有 Telegram 文本路径回归无破坏
- [ ] 不出现出站媒体 / 出站强制 reply / 飞书

## 后续

完成后 archive 或保持 in_progress 等待 parent 集成。下游 `07-15-feishu-adapter` 可在本任务完成后启动。