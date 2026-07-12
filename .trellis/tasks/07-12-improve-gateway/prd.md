# 完善 Novi agent 网关层

## Goal

将现有 Telegram 私聊 MVP 网关提升为可安全、稳定地用于长期运行的基础网关：
支持受控的私聊接入、群聊/话题路由、可靠投递，以及可诊断的运行状态。

## Requirements

- **R1 访问策略**：将当前单一 sender allowlist 扩展为 DM 与群聊独立策略。
  - DM 支持 `pairing`、`allowlist`、`open`、`disabled`。
  - 群聊支持 `allowlist`、`open`、`disabled`，默认拒绝。
  - pairing 请求必须有过期时间与待审批上限；批准后持久化为该 Telegram bot 实例的授权用户。
- **R2 群聊与话题**：Telegram 接收私聊、群、超级群及 forum topic 文本消息；会话键必须隔离渠道实例、聊天类型、聊天 ID 和话题 ID。
- **R3 触发门控**：群聊默认仅在命令、回复机器人、@机器人或配置的唤醒正则命中时执行；可配置允许自由响应、忽略指定话题、仅允许指定群与用户。
- **R4 入站可靠性**：同一渠道实例的重复 Telegram update 不得重复执行 Agent turn；入站处理失败必须可诊断且不应使 polling 进程退出。
- **R5 出站可靠性**：发送、编辑和 typing 的暂时性 Telegram API 失败必须在有限次数内重试；限流等待应遵从 API 提供的 retry-after；最终失败写入 stderr 且不会使其他会话停止。
- **R6 投递语义**：最终文本为明确静默标记时不得发出消息；`/status` 应报告当前渠道、会话键、排队状态、模型和授权状态，且不暴露凭证。
- **R7 运行诊断**：新增网关状态与渠道 probe CLI 路径，输出每个渠道的配置状态、连接/探测结果和活跃会话数；支持在不中断既有运行的前提下显式重载访问策略与群路由快照。渠道实例、bot token 和流式参数变更必须重启网关后生效。
- **R8 配置与兼容**：保留现有 `gateway.json` 的 Telegram 私聊配置兼容性；新增字段均有安全默认值，配置无效时给出 actionable warning。

## Acceptance Criteria

- [ ] 未知私聊用户会收到一次性 pairing 指引；过期、超限和未批准 pairing 不可访问 Agent。
- [ ] 已授权私聊用户仍可像当前版本一样获得流式回复，现有 `allowlist` 配置无需迁移。
- [ ] 群聊仅在允许的群、用户与触发条件同时满足时创建/继续 Agent 会话；不同 topic 不共享 session。
- [ ] 重复 update 只触发一次 Agent run；模拟的暂时性发送失败会重试，而最终失败只影响该次投递。
- [ ] 静默标记不产生出站文本；`/status` 输出不含 token 或其他秘密。
- [ ] `novi --gateway status` 与 `novi --gateway probe` 可在未配置真实 Telegram 凭证的测试环境中通过 mock adapter 验证。
- [ ] 策略重载失败保留最后一次有效策略快照；成功重载原子替换新快照，且明确提示渠道实例、bot token 与流式参数需要重启才会生效。
- [ ] 新增逻辑有单元测试；`npm run typecheck`、`npm run lint`、`npm run test` 和 `npm run build` 通过。

## Notes

- 不在本任务范围：新增非 Telegram 渠道、图片/文件/语音消息、远程 Agent RPC、跨渠道后台任务投递、通用插件市场。
- 参考结论保存在 `research/openclaw-hermes-baseline.md`。
