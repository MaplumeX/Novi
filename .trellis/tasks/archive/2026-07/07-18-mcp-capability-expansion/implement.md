# Remote MCP OAuth 实施计划

本任务按契约依赖顺序实施。每个阶段完成聚焦测试和 diff 审查后再进入下一阶段；不得在 TUI、CLI、manager 中各自创建 token/discovery 状态。

## 1. 配置、领域类型与错误契约

- [x] 在 `src/mcp/types.ts` 增加 OAuth config、grant、client auth、binding/status 类型，保持 stdio union 收窄正确。
- [x] 在 `src/mcp/config.ts` 校验 `oauth`、client metadata URL、scope、secret placeholder 和非法组合；把非 secret OAuth shape 纳入 fingerprint。
- [x] 增加集中式 `src/mcp/oauth/errors.ts` 与 sanitizer，定义稳定 auth error code、public guidance 和 retryability。
- [x] 扩展 `src/tools/events.ts`，确保 auth-required/scope-required/config/store 类错误均为 non-retryable。
- [x] 为 config overlay、fingerprint、placeholder、redaction 和事件解码增加聚焦测试。

阶段检查：旧 HTTP headers/stdio 配置测试全部通过；明文 secret 和非法 grant 在任何网络调用前拒绝。

## 2. OAuth store 与并发控制

- [x] 新建 `src/mcp/oauth/types.ts`、`store.ts` 与 `locks.ts`，实现 V1 schema、binding key、generation 和严格读取。
- [x] 实现 0700/0600、同目录 temp、file sync、atomic rename、directory sync；损坏/版本不兼容保留原文件并 fail-closed。
- [x] 实现进程内 keyed lane、per-binding auth lease 和 global write lock，固定锁顺序、等待上限与保守 stale recovery。
- [x] 提供 `inspect/withBindingLease/patchRecord/clearTokens/resetRecord`，所有 mutation 在锁内重新读取并合并。
- [x] 测试同 binding 双 refresh 只发送一次、不同 binding 并行写不丢记录、generation 变化跳过陈旧 refresh、owner 存活不抢锁、stale lock 可恢复。

阶段检查：store 单测覆盖 crash-safe 写入、权限和 secret-free diagnostics；不得复用 approval store 的 corrupt-as-empty 语义。

## 3. Provider、discovery、注册与 callback

- [x] 新建 `src/mcp/oauth/provider.ts`，实现 SDK `OAuthClientProvider` 的 pre-register、CIMD、DCR、discovery cache、tokens、client auth 和 client_credentials。
- [x] 新建 `src/mcp/oauth/network.ts`，统一校验 HTTPS、resource/issuer/endpoints、redirect hop、DNS trust class 与 response bounds。
- [x] 新建 `src/mcp/oauth/coordinator.ts`，在 binding lease 中封装 SDK `auth()`，实现 passive refresh/client-credentials、显式 login/reauthorize、pending scope 和恢复 budget。
- [x] 新建 `src/mcp/oauth/callback.ts`，实现 127.0.0.1 随机端口、稳定 path、state/redirect/单次 callback 校验、五分钟 timeout 和清理。
- [x] 新建 `src/mcp/oauth/browser.ts`，以可注入、无 shell、best-effort 方式打开 URL，并始终返回可打印 URL。
- [x] 实现 revocation、logout 与 reset-auth，保证撤销失败不阻止本地清理。
- [x] 使用 fake PRM/AS fixture 覆盖 challenge/well-known、RFC 8414/OIDC、PKCE、CIMD/DCR、basic/post/none、rotation、unsafe endpoint、取消/超时/错误 state。

阶段检查：authorization code/verifier/token/secret/raw OAuth body 不出现在 snapshot、诊断或测试快照；reauthorize 失败保留旧 token。

## 4. Transport 与 manager 恢复主链

- [x] 扩展 `src/mcp/transport.ts`，合并静态 headers 与 credential snapshot，注入 challenge recorder，不在 config 中写回 Authorization。
- [x] 扩展 `McpClientManagerOptions` 与 connection state，接入 coordinator 和每 operation auth recovery budget。
- [x] 修改 `connectEntry`：先正常连接，Bearer 401 后最多一次 passive auth/transport rebuild；auth-required 进入 fail-soft unavailable/degraded。
- [x] 修改 `callTool`：运行期 401 最多一次 refresh/reconnect/retry；403 insufficient_scope 只记录 pending scope并返回稳定错误。
- [x] 保证 `connectMcp: false`、builtin-only、stdio、anonymous HTTP 和 static-header HTTP 不读 store、不 discovery。
- [x] 扩展 `McpRuntimeHandle`，集中暴露 status/login/reauthorize/cancel/logout/resetAuth 和 reconnect，不让 surface 访问 store。
- [x] 增加 manager/assembly 组合测试，覆盖 LKG catalog、listChanged、tool retry、另一个 server fail-soft 和 child source allowlist。

阶段检查：同一 operation 的 refresh/rebuild/original retry 计数可证明有界；现有 catalog、permission、result/progress 测试无回归。

## 5. 独立 CLI 与 TUI 体验

- [x] 在 `src/cli.ts` 模型 onboarding/bootstrap 之前增加 `novi mcp` dispatcher 与 `--no-open` 校验；不要求 LLM provider 配置。
- [x] 新建可测试的 MCP CLI action 模块，支持 status/login/reauthorize/logout/reset-auth、human/JSON 输出、SIGINT 取消和稳定 exit code。
- [x] 扩展 `src/tui/commands.ts` 的 `/mcp` 子命令；login/reauthorize 使用后台 operation，增加 cancel，并在成功 mutation 后 `refreshTools()`。
- [x] 更新 `/mcp list/status` 格式，显示 registration mode、issuer/resource、scope、过期/auth-required 状态，但不显示 secret 或完整敏感 URL。
- [x] 验证 Gateway/Headless/child 只消费 token；公共错误给出 `novi mcp login|reauthorize` 指引，不增加浏览器/callback 路径。
- [x] 增加 CLI/TUI/Headless/Gateway/child-agent 聚焦测试，覆盖 approval-before-network、browser failure/no-open、取消/超时和结构化错误投影。

阶段检查：交互表面行为一致，非交互表面在测试中以 browser/listener spy 证明零交互副作用。

## 6. 文档、规范与支持矩阵

- [x] 更新 `README.md`：配置示例、CLI/TUI 命令、client_credentials、CIMD/DCR、SSH `--no-open`、logout/reset 指引。
- [x] 更新 `docs/tool-system-design.md`：OAuth 数据流、支持矩阵、信任边界、store/lock、跨表面行为和错误码。
- [x] 使用 `trellis-update-spec` 更新 `.trellis/spec/backend/tool-runtime-contracts.md`、目录结构、错误处理和必要的 CLI/TUI 规范。
- [x] 复核官方 MCP OAuth、RFC 8252/9728/8414/8707 与实际 SDK 1.29.x 公开接口，不把 unsupported 能力标成 supported。

## 7. 最终验收与质量门

- [x] 对照 PRD AC1-AC12 逐项记录测试或代码证据。
- [x] 运行所有 MCP、permission、runtime、events、assembly、TUI、CLI、Headless、Gateway 和 agent 聚焦测试。
- [x] 运行 `npm run typecheck`。
- [x] 运行 `npm run lint`。
- [x] 运行 `npm run test`。
- [x] 运行 `npm run build`。
- [x] 运行 `git diff --check` 并审查 `git status --short`，确认无 token、临时 lock/store 或测试 secret 泄漏。
- [x] 使用 `trellis-check` 完成 spec compliance、cross-layer、reuse 和 context-drift 复核。

## 最终验收证据

- PRD `AC1`–`AC12` 已逐项关闭；对应配置、store/lock、provider、transport/manager、CLI/TUI 与跨表面行为均有聚焦回归。
- `npm test -- --reporter=dot`：147 个测试文件、1276 项测试全部通过。
- `npm run build`、`npm run lint`、`npm run typecheck`、`git diff --check`：全部通过。
- 已完成 Trellis spec compliance、跨层数据流、复用、上下文漂移与重复缺陷预防复核。

## 风险与回滚点

- store/lock 是最高数据安全风险：未证明 rotation 并发正确前，不把 token 接入 Gateway 长驻路径。
- transport/manager auth retry 是最高循环风险：所有 retry 必须由同一 operation budget 驱动，不能借 reconnect 重置。
- callback/browser 是最高交互风险：listener 必须先启动、始终 finally 关闭，非交互模式不得构造它。
- project approval 是最早安全门：任何重构都不能让 discovery、CIMD/DCR 或浏览器先于 approval。
- 若交互 UX 延期，可保留 config/store/passive client_credentials 的独立实现，但不得把 authorization-code 标记为 supported；若 OAuth 整体回滚，`oauth: false`/旧 headers/stdio 主链仍可独立工作。
