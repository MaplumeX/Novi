# 统一工具资源治理

## Goal

为所有工具建立一致、可配置、可观测的资源预算和背压机制，避免大输出、深目录与持久缓存拖垮 harness。

## Requirements

- 定义统一 ToolExecutionBudget，覆盖 timeout、模型可见输出、内部缓冲、partial update、并发和遍历限制。
- 预算解析遵循内置默认 ← global 可放宽/收紧 ← project 只收紧 ← CLI 当前运行可显式放宽/收紧。
- TUI、Headless、Gateway 和 resume/rebuild 必须消费同一份最终预算。
- `bash` 使用有界缓冲，partial update 只发送带 sequence 的有界增量，异常与 details 同样受限。
- `glob` / fallback `grep` 遵循默认 ignore，并支持最大结果数、文件数、深度和提前终止。
- Web 缓存支持容量/条目/年龄上限及安全清理，不影响正在读取的条目。
- 超出内存或模型可见预算的完整输出默认流式写入 `~/.novi/artifacts/<sessionId>/<toolCallId>/`，内存、事件和会话历史只保留有界尾部。
- artifact 使用 `0600` 权限，受每会话和全局容量/年龄上限约束，按最旧优先安全清理。
- 用户可在 global settings 关闭 artifact 持久化；project settings 不得强制开启或放宽配额。
- 权限拒绝与其他敏感 gate 内容不得写入 artifact。
- 截断与预算终止必须进入结构化 metrics/details，区分成功截断与执行失败。
- 所有长任务响应 AbortSignal。

## Default Budgets

| Budget | Default |
| --- | ---: |
| Model-visible output per tool call | 50 KiB / 2,000 lines |
| In-memory tool buffer | 256 KiB |
| Partial delta | 16 KiB |
| Partial update rate | 10 per second |
| Bash timeout | 120 seconds |
| Traversed files per call | 50,000 |
| Traversal depth | 64 |
| Structured glob/grep results | 10,000 |
| Artifact quota per session | 256 MiB |
| Artifact global quota | 1 GiB |
| Artifact maximum age | 7 days |
| Web cache global quota | 512 MiB |
| Web cache maximum age | 30 days |

达到遍历、结果、模型可见输出等软上限时返回成功但明确标记截断；timeout、硬内存预算或磁盘配额导致无法完成时返回结构化失败。

## Acceptance Criteria

- [ ] 超大 bash 输出的进程内存和事件体保持在配置预算内。
- [ ] 大型目录遍历达到上限后确定性停止并报告原因。
- [ ] Web 缓存不会无限增长，清理行为有并发与损坏回归测试。
- [ ] 超额工具输出返回 artifactPath、完整字节数和截断原因，且不会在 details/history 中保留无界副本。
- [ ] artifact 权限、关闭开关、会话/全局配额与清理有测试覆盖。
- [ ] 默认预算不破坏现有常规工具调用。
- [ ] project settings 不能提高任何资源上限；global 与 CLI 的显式放宽有来源诊断和测试。
- [ ] 压力/边界测试、lint、typecheck 通过。

## Decisions

- 预算配置采用 global 可调、project 只收紧、CLI 可临时放宽；各运行模式不设隐式差异。
- 超额输出默认本地落盘并受配额/年龄治理，global 可关闭，project 不可强制开启。
- 首版默认预算采用上表“常规项目”档位。
