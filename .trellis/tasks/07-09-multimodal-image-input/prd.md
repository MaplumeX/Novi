# Multimodal image input for Novi harness

## Goal

打通 Novi TUI 的**图片 → user message** 多模态输入链路，使 vision-capable 模型能收到 `ImageContent`，而不是只能发纯文本。

## Background（已确认事实）

- **pi-agent-core 已支持 images**：
  - `harness.prompt(text, { images? })`
  - `steer` / `followUp` / `nextTurn` 同样接受 `{ images?: ImageContent[] }`
  - `createUserMessage` 允许空文本 + images（text part 仍会写入，可为空串）
- **`ImageContent`**：`{ type: "image"; data: string /* base64 */; mimeType: string }`
- **非 vision 模型**：pi-ai `transform-messages` 将 image 替换为  
  `(image omitted: model does not support images)`，不抛错
- **Novi 现状**：TUI/headless/gateway 全部 `prompt(text)` 纯文本；`MessageList` 对 user 只 `collectText`
- **Ink**：`usePaste` 仅 bracketed **文本** paste；位图需平台剪贴板 API
- 历史任务多次将图片粘贴 / gateway 媒体后置

## Requirements

### R1 共享 pending 附件模型
- TUI 维护 pending image 列表（label + `ImageContent`）。
- 可叠加多张；可清空；提交成功后清空。
- 附件编码失败（mime/大小/IO）→ 不加入 pending，print 错误，不崩溃。

### R2 本地文件附加
- `/image <path>`：读本地文件 → encode → pending（可多次）。
- `/image` 无参：打开**仅图片扩展名**的 file picker；选中后附加，**不**插入路径文本。
- `@` 保持「插入路径」语义，不改为 attach。
- `/image clear`：清空 pending。

### R3 剪贴板附加
- `Ctrl+I` 与 `/paste-image` 等价：读系统剪贴板图片 → pending。
- 不拦截终端原生文本粘贴。
- 平台：macOS 优先实现；Linux 尽力；不支持平台 print 明确提示。

### R4 提交路径
- idle `prompt`、turn `steer`、turn `followUp` 均传 `{ images }`（有 pending 时）。
- 提交时若有图且 `model.input` 不含 `"image"`：print 警告一次，**仍提交**（依赖 core 降级）。
- 允许「仅图、无文本」提交（text 可为 `""`）。
- Escape abort 只 restore 文本；未提交 pending 图保留在编辑器状态。
- 队列文本预览不回灌图片；可选 `+N images` 标注不作为硬要求（pending 在编辑器侧已可见）。

### R5 展示
- 输入区上方显示 pending 列表（label + mime/简短尺寸信息可选）。
- 历史 user 消息：若 content 含 image parts，显示 `[image ×N]` 类标记（不渲染像素）。

### R6 限制（硬编码常量，非 settings）
- mime 白名单：`image/png`、`image/jpeg`、`image/gif`、`image/webp`
- 单张原始字节 ≤ **10 MiB**
- pending 最多 **8** 张
- 超限拒绝加入 pending 并 print 原因；本任务不做缩放/压缩

## Acceptance Criteria

- [ ] AC1: `/image path/to.png` 将图片加入 pending；输入区可见附件条目
- [ ] AC2: `/image` 无参打开图片过滤 picker；选择后附加且不插入路径
- [ ] AC3: `/image clear` 清空 pending
- [ ] AC4: `Ctrl+I` 与 `/paste-image` 在有剪贴板图时加入 pending；失败有可读错误
- [ ] AC5: idle 提交走 `prompt(text, { images })`；turn 中 Enter / Meta+Enter 分别 `steer`/`followUp` 带 images
- [ ] AC6: 提交成功后 pending 清空
- [ ] AC7: 非 vision 模型带图提交时出现警告 notice，且请求仍发出
- [ ] AC8: 非法 mime / 超大 / 超过 8 张时拒绝附加并提示
- [ ] AC9: MessageList 对含 image 的 user 消息显示 image 计数标记
- [ ] AC10: `@` 行为不变（仍插入路径）
- [ ] AC11: headless / gateway 行为不变（仍纯文本）
- [ ] AC12: `npm test` + `npm run typecheck` + `npm run lint` 全绿

## Out of Scope

- headless / `--mode json` / gateway 图片入参与媒体收发
- 视频 / PDF / 音频 / 远程 URL 抓取为 image
- 工具结果返回图片（toolResult images）
- 图片缩放压缩、缩略图真渲染
- settings 可配置限制
- Windows 剪贴板（可降级提示；不阻塞验收）
- 抢占终端原生 Ctrl+V 文本粘贴

## Decisions

| # | 决策 |
|---|---|
| 1 | 入口 = 文件 + 剪贴板，共享 pending |
| 2 | 提交 = prompt + steer + followUp 全支持 |
| 3 | 仅 TUI；headless/json/gateway 后置 |
| 4 | 限制 = mime 四类 / 10MiB / 最多 8 张，硬编码 |
| 5 | 非 vision = 警告后仍提交 |
| 6 | 文件 UX = `/image [path]` + 无参图片 picker；`@` 不变 |
| 7 | 剪贴板 UX = `Ctrl+I` + `/paste-image` |

## Notes

- 复杂任务：需 `design.md` + `implement.md`，审核通过后再 `task.py start`。
- 单任务交付（附件管线耦合紧，不拆 parent/child）。
