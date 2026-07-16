# Implement — Feishu (Lark) channel adapter

> P1，执行顺序第三棒。依赖 `channel-unified-semantics`（已 archive）。

## 前置条件

- [x] `channel-unified-semantics` 已完成并 archive
- [ ] prd.md / design.md 已 review
- [ ] 当前 active task = `07-15-feishu-adapter`，status = planning

## 执行清单（按顺序）

### A. 依赖安装
1. [ ] `npm install @larksuiteoapi/node-sdk`（确认版本 1.71.x）。

### B. 配置（`src/gateway/config.ts`）
2. [ ] 新增 `FeishuChannelConfig` 接口（type/id/appId/appSecret/domain?）。
3. [ ] `ChannelConfig` 联合扩展为 `TelegramChannelConfig | FeishuChannelConfig`。
4. [ ] `validateChannels` 识别 `type: "feishu"`，缺 appId/appSecret 时跳过并告警。
5. [ ] 单测 `config.test.ts`：飞书配置校验（有效/缺字段/未知 type）。

### C. 工厂（`src/gateway/channels/index.ts`）
6. [ ] `createChannel` 识别 `"feishu"` → `createFeishuChannel(config, options)`。
7. [ ] `createFeishuChannel` 构造 `FeishuChannel`。

### D. FeishuChannel（`src/gateway/channels/feishu.ts` 新文件）
8. [ ] `FeishuChannel extends AbstractChannel`，`type: "feishu"`。
9. [ ] `capabilities`：`edit: false, threads: false, media: false, markdown: true`。
10. [ ] `textChunkLimit = 4000`。
11. [ ] 可注入 `LarkChannelFactory`（默认 `createLarkChannel`，测试用 mock）。
12. [ ] `start()`：createLarkChannel → `on('message')` → connect → 记录 botIdentity。
13. [ ] `stop()`：disconnect。
14. [ ] `probe()`：返回 botIdentity 状态。
15. [ ] `getFailure()`：暴露 WS 致命错误。
16. [ ] `normalizeMessage(msg)`：NormalizedMessage → ChannelMessage（text/chatType/sender/reply/mention metadata）。
17. [ ] 非文本消息：`metadata.unsupported`，不崩溃。
18. [ ] `send(target, text)`：chunk + reply（`target.replyToMessageId` 存在时用 `replyTo` 选项）。
19. [ ] `sendFinalChunk(target, text, ordinal)`：支持 durable 分 chunk。
20. [ ] `handleMessage` fire-and-forget（emitMessage 不阻塞）。

### E. 测试（`src/gateway/channels/feishu.test.ts` 新文件）
21. [ ] 配置校验单测（已在 B.5）。
22. [ ] 归一化单测：text/p2p→direct/group→group/reply/mention/非文本诊断。
23. [ ] send + reply 单测（mock LarkChannel）。
24. [ ] 生命周期单测：start/stop/probe（mock）。
25. [ ] 能力声明断言：edit=false, threads=false, media=false。

### F. 验证
26. [ ] `npm run typecheck && npm test && npm run lint && npm run build` 全绿。
27. [ ] 现有 Telegram/gateway 测试回归无破坏。

## 验证命令

```bash
npm run typecheck
npm test
npm run lint
npm run build
```

## 风险点 / 回滚

- 风险：SDK `Channel` 模块的 policy 层与 GatewayApp auth 冲突 → 禁用 policy（requireMention=false, dmMode='open'），GatewayApp 统一 auth。
- 风险：SDK send 不返回 messageId → 需从 API 响应提取或用底层 `client.im.message.create` 拿 message_id。
- 风险：SDK 版本 API 形态变化 → 锁定版本，在 design 标注已验证版本。
- 回滚：revert commit + `npm uninstall @larksuiteoapi/node-sdk`；core 契约不受影响。

## 审查门

- [ ] typecheck + test + lint + build 全绿
- [ ] 飞书配置/归一化/send/reply/生命周期单测覆盖
- [ ] 能力声明与 Telegram 有真实差异（edit/threads/media）
- [ ] 现有 Telegram/gateway 测试回归无破坏
- [ ] 不出现飞书媒体 / 出站强制 reply / reaction / quote 独立模型

## 后续

完成后 archive。parent `07-15-channel-media-feishu-semantics` 进度 3/3，做最终集成评审。