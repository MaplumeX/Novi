# 网关可靠性与群组路由实施计划

## 1. 配置与纯领域逻辑

- [ ] 扩展 gateway 配置 schema、默认策略与诊断；保持原 allowlist 行为。
- [ ] 实现 session key、静默标记、群组触发与入站去重的纯函数并编写单测。
- [ ] 实现 pairing store 与审批命令，不记录 code 或 token。
- [ ] 验证：`npm run typecheck && npm run test -- --runInBand`（若 Vitest 不支持该参数则运行 `npm test`）。

## 2. Gateway 编排

- [ ] 在 GatewayApp 中按设计顺序接入去重、授权、群组门控与命令 bypass。
- [ ] 扩展 session manager 的安全统计接口，供 status 使用；不得泄露内部 harness 或秘密。
- [ ] 扩展 commands：pairing 批准、授权身份与增强 status。
- [ ] 验证：gateway core 单测、`npm run typecheck`。

## 3. Telegram adapter 可靠性

- [ ] 接收 private/group/supergroup/topic 文本并填充标准化元数据。
- [ ] 为 Telegram 出站调用实现有限重试、retry-after 与单消息失败隔离。
- [ ] 增加 channel status/probe 合同与 mock adapter 测试。
- [ ] 验证：Telegram adapter 单测、`npm run typecheck`。

## 4. CLI 与重载

- [ ] 实现 `novi --gateway status`、`probe`；明确其不启动 Agent turn。
- [ ] 实现可验证的候选配置加载与原子快照替换；接入常驻 gateway 的 reload 入口。
- [ ] 为成功与失败重载补测试，失败不得破坏旧运行快照。

## 5. 全量质量门与复核

- [ ] 审查差异只覆盖 PRD 范围，未引入新渠道、媒体或远程协议。
- [ ] `npm run typecheck`
- [ ] `npm run lint`
- [ ] `npm run test`
- [ ] `npm run build`
- [ ] 更新相关 backend spec（仅在本次形成可复用的新项目约定时）。
- [ ] 提交前复核 git diff 与 git status。
