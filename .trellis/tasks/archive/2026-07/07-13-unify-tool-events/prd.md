# 统一工具事件与展示协议

## Goal

统一工具执行结果、错误、流式事件与 TUI/Headless 展示协议，让模型、用户和外部客户端看到一致且可关联的信息。

## Requirements

- 定义 JSON-safe 工具结果 envelope，包含 status/data/error/metrics/truncation/artifacts。
- final envelope 对超额输出只包含有界预览与 artifact 元数据，不嵌入完整副本。
- 保留模型友好的文本 content，同时避免 details 保存未经预算控制的全量副本。
- Headless 投影开始、partial、结束、错误和权限拒绝，均携带 toolCallId。
- partial 采用带单调 sequence 的 delta；final 事件提供受预算约束的完整结果 envelope。
- 客户端可按 toolCallId + sequence 累积增量并检测重复、丢失或乱序事件。
- TUI 与 Headless 使用共享规范化层，未知工具安全降级。
- `edit_file.edits[]` 的单项/多项 diff 与摘要正确。
- 明确事件协议的兼容与版本策略。
- 本轮采用完整替换，不保留旧 Headless 工具事件字段的兼容、双写或迁移适配层；所有仓库内消费者同步切换。

## Acceptance Criteria

- [x] JSON 客户端能仅凭事件流重建工具调用状态与最终结果。
- [x] partial update 包含有界增量或快照，不再只报告工具名。
- [x] 同一调用的 partial sequence 单调递增，final result 有界且可独立消费。
- [x] 错误码、retryable、权限拒绝和截断信息可机器读取。
- [x] 规范 `edit_file.edits[]` 在 TUI 中显示正确 diff。
- [x] 所有事件均可 JSON.stringify，敏感字段不泄漏。
- [x] TUI、Headless 和持久化恢复测试通过。
- [x] 仓库内不残留旧工具事件字段的兼容分支或双重解析。

## Decisions

- Headless 流式协议采用 `delta + sequence + bounded final result`，不重复发送累计 snapshot。
- 当前 Novi 尚无稳定协议承诺，本次允许完整 breaking change；不考虑外部旧客户端迁移。
