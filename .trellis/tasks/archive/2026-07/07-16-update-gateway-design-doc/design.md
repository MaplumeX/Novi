# 设计：更新网关设计讲解文档

> 本任务只改 `docs/gateway-design.md`，不改源码。design.md 描述"怎么写这份文档"，而不是"怎么改代码"。

## 文档定位与边界

- `docs/gateway-design.md` 是**设计讲解**（explain-code-design 技能），不是 API 参考、不是运维手册。
- 已有分工：`gateway-messaging-semantics.md` 是跨渠道语义契约参考；`.trellis/spec/backend/*` 是可执行契约。本文不重复它们的内容，只在需要时链接。
- 范围（选项 A）：只补 Telegram 入站媒体 + Feishu channel 两块增量；migrations / runtime 保持现有"未展开"标注。

## 增量在现有文档结构中的落点

现有文档结构（保持不变）：整体概览 → 要解决的问题 → 核心抽象 → 运行机制 → 关键设计 → 异常与边界 → 设计权衡 → 小结。

两块增量各自落在多个章节，而不是各开一个独立大章。理由：explain-code-design 要求"围绕问题组织，不按文件/提交顺序"，增量应融入对应的问题线索。

### 增量 1：Telegram 入站媒体

| 章节 | 改动 | 要回答的问题 |
|------|------|-------------|
| 整体概览 | 补一句：channel 还要把平台媒体差异收敛成统一附件模型 | channel 职责边界扩展 |
| 要解决的问题 §3 平台差异 | 补：Telegram photo/document/voice/sticker 是异构的，且 image 要进多模态、file/voice 要持久化引用 | 媒体归一化的约束 |
| 核心抽象 §ChannelAdapter | 补 `ChannelAttachment` / `ChannelAttachmentKind` 与 `ChannelMessage.attachments?` / `images?` 双字段模型；说明 `ChannelCapabilities.media` 是声明位 | 附件模型是什么、为什么是双字段 |
| 运行机制 §1 Channel 入站归一化 | 在 Telegram text 归一化后，新增一段媒体归一化流程：handler 分发 → `extractAttachment` → image 走 download→base64→`images`、file/voice 走 download→`saveAttachmentFile`→`localPath` | 媒体消息怎么穿过 channel |
| 关键设计 | 新增一小节"image 走多模态、file/voice 落盘"：为什么两种路径不同（agent 消费方式不同：image 要进 `harness.prompt(text, { images })`，file/voice 只需可引用的本地路径）；双字段为什么 attachments 持久化而 images 不持久化（base64 体积、inbox 是文本记录） | 为什么分两条路径、为什么双字段 |
| 异常与边界 | 补：animation/sticker 诊断占位、download/encode 失败降级文本、`gateway-media/` 目录权限 0o700/0o600、`sanitizeFilename` 防穿越 | 媒体处理的失败边界 |
| 设计权衡 | 补：media 是 channel 能力声明位但目前只有 Telegram 实现，Feishu `media:false` 明确不支持；image 不落盘意味着崩溃恢复后多模态上下文丢失（由 media 子任务的重建责任覆盖，见 semantics 文档） | 媒体设计的代价 |

### 增量 2：Feishu channel 适配器

| 章节 | 改动 | 要回答的问题 |
|------|------|-------------|
| 整体概览 | "多种 IM channel" 从"Telegram"扩展为"Telegram + Feishu"；分层解耦的第 1 条补 Feishu 作为第二实例 | channel 不止 Telegram |
| 核心抽象 §ChannelAdapter | 用 Feishu 作为**能力受限 channel**的对比锚点：`edit:false`→无 `sendEvent`、`threads:false`→安全忽略 threadId、`media:false`、WebSocket long-connection、3 秒回执→fire-and-forget 入站 + durable inbox 兜底 | 抽象如何容纳一个"少能力"的实现 |
| 关键设计 §1 授权在队列之前 | 补一句：Feishu SDK policy 层禁用，授权统一在 GatewayApp，证明"channel 不实现半套 ACL"的设计在第二实例上成立 | 第二实例验证了授权边界 |
| 异常与边界 | 补：Feishu 无 edit-stream 时 session-lane 通过 `?.` 静默跳过 `sendEvent`；3 秒回执约束的 fire-and-forget 设计；非 text 内容降级 | 能力缺失如何降级 |
| 设计权衡 | 补：Feishu 证明 channel 抽象的"少能力"路径可行，但也说明 edit-stream 体验不是所有渠道都有 | 抽象的收益与代价 |

## 叙事原则（来自 explain-code-design）

- 主路径（运行机制）保持 Telegram 为唯一示例；Feishu 作为对比锚点出现在核心抽象/关键设计/异常边界，不另起一条并行主路径。
- 引用源码只引用能证明结论的少量符号（如 `ChannelAttachment` 接口、`handleMediaMessage` 的分支条件、`capabilities` 声明），不粘贴大段代码。
- 区分源码事实与合理推断。Feishu 的"3 秒回执"是源码注释事实；"验证了抽象边界"是合理推断，用"这表明"标记。
- 不逐行翻译 `handleMediaMessage` / `normalizeMediaMessage`；讲清 image vs file/voice 的分叉原因和失败降级策略。

## 不改动的内容

- 现有"运行机制（主路径）"步骤 0–6 的 Telegram text 消息叙事保持不变，只在步骤 1 后新增媒体归一化段。
- migrations / runtime 的"未展开"标注保持不变。
- `gateway-messaging-semantics.md` 不改写，只在 attachments 双字段模型处补一个指向它的链接（如果现有链接已覆盖则不动）。

## 验证方式

- 文档写完后，逐项对照 explain-code-design 的"输出前检查"清单。
- 逐项对照 prd.md 的 Acceptance Criteria。
- grep 检查文档中提到的文件路径/符号是否与当前源码一致。