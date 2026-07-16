# 执行计划：更新网关设计讲解文档

> 本任务只改 `docs/gateway-design.md` 一个文件。执行顺序按文档章节自上而下，避免来回跳。

## 前置：再读一遍现有文档与源码

- [ ] 完整重读 `docs/gateway-design.md`，标记所有需要插入增量的位置
- [ ] 确认 `src/gateway/core/types.ts` 中 `ChannelAttachment` / `ChannelAttachmentKind` / `ChannelMessage.attachments` / `ChannelMessage.images` / `ChannelCapabilities.media` 的当前定义
- [ ] 确认 `src/gateway/channels/telegram.ts` 媒体相关方法与 `src/gateway/channels/telegram-media.ts` 的当前实现
- [ ] 确认 `src/gateway/channels/feishu.ts` 的能力声明与入站/出站路径

## 步骤 1：整体概览

- [ ] 把"挂着一个或多个 IM channel"附近的表述补成 Telegram + Feishu 两实例
- [ ] 分层解耦第 1 条补一句：channel 还要把平台媒体差异收敛成统一附件模型
- [ ] 不动已有的 harness/编排/lane/bridge 分层描述

## 步骤 2：要解决的问题 §3 平台差异

- [ ] 在现有 Telegram 4096/FloodWait/edit-stream/forum topic 约束后，补媒体归一化约束：photo/document/voice/sticker 异构、image 进多模态 vs file/voice 持久化引用

## 步骤 3：核心抽象 §ChannelAdapter

- [ ] 新增 `ChannelAttachment` / `ChannelAttachmentKind` 与 `ChannelMessage.attachments?` / `images?` 双字段模型说明
- [ ] 说明 `attachments` 持久化、`images` 运行时 base64 不持久化的原因
- [ ] 说明 `ChannelCapabilities.media` 是能力声明位
- [ ] 用 Feishu 作为能力受限 channel 的对比锚点（edit:false / threads:false / media:false / WebSocket / 3 秒回执）

## 步骤 4：运行机制 §1 Channel 入站归一化

- [ ] 在 Telegram text 归一化段之后，新增"媒体消息归一化"段
- [ ] 讲 handler 分发 → `extractAttachment` → image 走 download→base64→`images`、file/voice 走 download→`saveAttachmentFile`→`localPath`
- [ ] 不逐行翻译，讲分叉原因与数据流

## 步骤 5：关键设计

- [ ] 新增小节"image 走多模态、file/voice 落盘：两条附件路径"（或融入现有关键设计编号）
- [ ] 在"授权在队列之前"补 Feishu SDK policy 禁用、授权统一在 GatewayApp 的验证
- [ ] 说明 Feishu 作为第二实例如何验证 channel 抽象边界

## 步骤 6：异常与边界

- [ ] 补 Telegram 媒体失败边界：animation/sticker 诊断占位、download/encode 失败降级、`gateway-media/` 权限、`sanitizeFilename`
- [ ] 补 Feishu 能力缺失降级：无 edit-stream 时 `?.` 静默跳过、3 秒回执 fire-and-forget、非 text 降级

## 步骤 7：设计权衡

- [ ] 补媒体设计代价：media 声明位但仅 Telegram 实现；image 不落盘→崩溃恢复多模态上下文丢失
- [ ] 补 Feishu 代价：证明少能力路径可行，但 edit-stream 体验非所有渠道都有

## 步骤 8：自检

- [ ] 对照 explain-code-design "输出前检查"清单逐项验证
- [ ] 对照 prd.md Acceptance Criteria 逐项验证
- [ ] grep 文档中提到的文件路径/符号，确认与源码一致
- [ ] 确认未引入与当前源码矛盾的事实
- [ ] 确认未改动 migrations / runtime 的"未展开"标注

## 验证命令

```bash
# 确认文档中引用的符号在源码中存在
rg -n "ChannelAttachment|ChannelAttachmentKind|saveAttachmentFile|sanitizeFilename" src/gateway/
rg -n "class FeishuChannel|LarkChannelFactory|FEISHU_TEXT_LIMIT" src/gateway/channels/feishu.ts
# 确认文档没有遗留与源码矛盾的描述
```

## 风险与回滚

- 本任务只改一个文档文件，无源码风险。
- 回滚：`git checkout docs/gateway-design.md`。
- 主要风险是文档与源码不一致；靠步骤 8 的 grep 自检兜底。