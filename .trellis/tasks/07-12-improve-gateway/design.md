# 网关可靠性与群组路由设计

## 边界与取舍

本任务只扩展现有 Telegram adapter 与 gateway core，不引入新渠道或外部服务。
将访问控制与消息路由留在 gateway 层，AgentHarness 仍只处理已授权、已标准化的文本 turn。
这是与现有 `AgentProtocolAdapter` 边界一致的最小改动。

## 配置模型

`gateway.json` 在现有 `security.allowlist` 兼容保留的基础上增加：

```json
{
  "security": {
    "allowlist": ["123"],
    "dmPolicy": "pairing",
    "groupPolicy": "allowlist",
    "pairing": { "ttlMs": 3600000, "maxPending": 3 }
  },
  "telegram": {
    "groups": {
      "allowlist": ["-100123"],
      "requireMention": true,
      "mentionPatterns": ["^\\s*novi\\b"],
      "ignoredThreadIds": ["42"]
    }
  }
}
```

- 缺省 DM 策略：若已有 allowlist 则 `allowlist`，否则 `pairing`。
- 缺省群策略：`disabled`，以避免现有私聊 bot 意外进入群聊。
- pairing 授权按 `channel.id + senderId` 持久化；pairing code 不写入日志。
- 配置解析负责类型验证和安全默认值；运行时只消费 resolved config。

## 入站处理顺序

```text
Telegram update
  -> adapter 标准化 ChannelMessage（含 chatType/threadId/updateId）
  -> 去重存储（短 TTL、每 adapter 实例）
  -> GatewayApp 授权策略
  -> 群聊触发门控
  -> slash 命令（inline bypass）
  -> SessionManager.enqueue
  -> AgentHarness
```

会话键改为由纯函数构造：`<channelId>:<chatType>:<chatId>[:thread:<threadId>]`。
既有私聊 session 不需要迁移；新格式仅影响之后创建的网关会话。

## 授权与群聊触发

- 私聊 pairing：未知用户得到验证码；管理员通过网关命令批准；未通过时不进入 lane。
- 群聊：先验证 group policy/群 allowlist，再验证 sender allowlist（当配置要求时），最后执行触发判定。
- 触发判定接受 `/command`、回复机器人的消息、提及机器人用户名或正则命中；任一失败均静默忽略。
- topic 是 session 隔离的一部分，也可在触发前通过 ignoredThreadIds 忽略。

## 可靠性与投递

- `TelegramChannel` 集中处理 API 调用，以共享有限重试和 retry-after 解析。
- 只对网络错误、429 和 Telegram 明确的暂时性 5xx 重试；鉴权/参数错误直接失败。
- `GatewayApp` 捕获单条入站异常，写 stderr warning，继续运行。
- 短 TTL 去重使用有界 Map；清理过期记录，防止常驻进程无界增长。
- 最终投递前判断完整文本是否为 `SILENT`、`[SILENT]`、`NO_REPLY` 或 `NO REPLY`（忽略大小写与首尾空白）；静默 turn 仍写入 Agent session。

## 运行控制

- `novi --gateway status` 读取并输出安全的配置摘要、渠道状态和 session manager 统计。
- `novi --gateway probe` 对每个渠道调用可选 `probe()`，失败不影响其他渠道。
- 常驻 gateway 通过 `SIGHUP` 触发策略重载：先解析候选配置；只有策略字段有效时才原子替换运行快照。Telegram long-polling 不允许同一 token 并行运行两个实例，因此渠道实例、bot token、渠道增删和流式参数不热替换，变更时必须重启；失败时保留旧策略快照。

## 测试与回滚

- 对 pairing、门控、session key、去重、静默标记和 retry 做纯函数/adapter 单测。
- 对 status/probe/reload 使用 mock channel 与 mock agent 的集成测试。
- 每个切片后运行 typecheck；最后运行 lint、test 与 build。
- 回滚点：配置兼容层独立；移除新字段后，既有 Telegram 私聊路径仍可由原 adapter 配置运行。
