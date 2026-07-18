# 完善 MCP 协议能力

## Goal

在已完成的 MCP Tools-first 主链之上，选择并交付下一组高价值 MCP 协议能力，使 Novi 能接入更多真实远程 MCP 服务或消费更丰富的 MCP 上下文，同时继续复用现有配置审批、动态 catalog、权限、runtime 和跨表面事件契约。

## Background / Confirmed Facts

- 2026-07-17 的 `mcp-protocol-tool-discovery` 任务已经完成 Tools 分页、`tools/list_changed`、原子 catalog revision、last-known-good、输入/输出 schema 验证、大目录延迟发现、真实 descriptor 权限委托、result fidelity、progress/cancellation 和 TUI/Headless/Gateway/child-agent 投影。
- 现有 MCP transport 支持 stdio 与 Streamable HTTP；HTTP 只接受静态配置 headers，没有 OAuth discovery、授权码流程、token refresh 或凭据生命周期管理（`src/mcp/transport.ts`、`src/mcp/config.ts`）。
- 当前 client initialization capabilities 保持 `{}`，没有声明或处理 Roots、Sampling、Elicitation；Novi 也不消费 MCP Resources/Prompts。
- 现有 result mapper 能保留 tool result 中的 resource link 和 embedded resource，但不会把它们提升为可发现、可订阅、可主动读取的 Resources 能力。
- MCP OAuth 只适用于 HTTP transport；stdio 应继续通过环境变量或现有配置取得凭据。
- 最新 MCP 授权规范要求 client 支持 `WWW-Authenticate` 与 well-known protected-resource metadata 两种发现路径、RFC 8414 与 OIDC discovery、PKCE S256、`state` 校验以及 authorization/token 请求中的 RFC 8707 `resource` 参数。
- 授权服务器可能提供多个 authorization server；client registration 和 token 必须按 issuer 隔离，不能跨 issuer 或 resource 复用。
- client registration 优先级可能包含预注册、Client ID Metadata Document、Dynamic Client Registration 和用户提供 client 信息；首版必须明确实际支持集合与不支持时的诊断。
- public client 的 refresh token 需要轮换处理；401、403 insufficient scope 和 step-up authorization 不能等同于普通 transport retry。
- Project trust 与 MCP server approval 已经是两条独立安全边界；后续 OAuth 用户授权不能替代 server approval，也不能绕过 `PermissionGate`。
- MCP Tasks 已从早期实验形态继续演进为独立扩展，协议和生态仍在变化，不应仅为“支持矩阵完整”而抢先实现。
- 上一轮已明确把 OAuth、Resources/Prompts、Sampling/Elicitation 和 Tasks 延期；本任务应选择下一阶段，不重写现有 Tools 主链。

## Requirements

- R0: 本阶段主目标是 Remote MCP OAuth，而不是并行实现 Resources/Prompts、Sampling/Elicitation 或 Tasks。
- R0a: 首版只有 TUI 与独立 CLI 可以发起交互式 OAuth；Headless、Gateway 和 child-agent 不打开浏览器、不承载 callback，只使用已经存在的有效授权或显式配置的非交互 `client_credentials`。
- R1: 新能力必须沿用现有 MCP server identity、approval、transport/manager 生命周期、diagnostics 和 fail-soft 边界。
- R2: 新能力不得建立绕过 `PermissionGate`、运行时预算、公共事件安全或 project trust 的平行执行通道。
- R3: 无 MCP 配置、仅 stdio server、旧静态 HTTP headers 和现有 Tools-only server 必须保持兼容。
- R4: 支持矩阵必须区分 supported、explicitly degraded、unsupported 和 experimental，不能把只解析 metadata 描述成完整协议支持。
- R5: 网络授权、用户输入、模型采样、资源读取等不同信任边界必须分别建模，不能共用一个宽泛的“已批准 MCP”状态。
- R6: 最终选定范围必须在 TUI、Headless、Gateway 和 child-agent 中明确支持差异、交互限制与失败行为。
- R7: OAuth 只作用于 HTTP MCP server；不得改变 stdio credential 语义。
- R8: token 和 client registration 状态必须按 MCP resource、authorization-server issuer 与 server identity 正确绑定，禁止 token passthrough 或跨 audience 复用。
- R9: 授权流程必须使用 PKCE S256、严格 `state`、loopback/HTTPS redirect 边界、最小 scope/step-up 和有界重试。
- R10: TUI 提供 `/mcp login <server>`；独立 CLI 提供等价登录入口，供本地使用与 Gateway/Headless 部署前授权。
- R11: 非交互表面可以使用/refresh 已有 token，并可按配置执行 `client_credentials`；authorization-code 授权缺失、失效或需要扩大 scope 时返回稳定 `MCP_AUTH_REQUIRED` 或更精确的结构化错误，并给出 CLI 操作提示，不得等待输入或自动打开浏览器。
- R12: Gateway 对话用户不能直接发起 OAuth，首版不建立聊天身份到第三方 OAuth account 的绑定。
- R13: OAuth client registration 支持三种模式，并按以下优先级选择：配置的预注册 client information；授权服务器支持且配置了 HTTPS `clientMetadataUrl` 时使用 Client ID Metadata Document；否则尝试 Dynamic Client Registration。
- R14: 预注册模式允许从用户配置提供 `clientId`，并通过安全占位符提供可选 `clientSecret`；secret 不得写入 project config、diagnostics、事件或普通 settings projection。
- R15: Novi 不生成或托管公共 CIMD URL；`clientMetadataUrl` 必须由用户、组织或发行方提供并满足 HTTPS/非根路径约束。
- R16: 授权服务器不支持任何可用 registration 模式时，返回稳定且可行动的配置错误，不得静默退回匿名连接或不安全注册。
- R17: 首版 OAuth 持久状态使用独立、版本化的 user-local `McpOAuthStore`，不混入通用 `credentials.json`、project config、session JSONL 或 MCP approval store。
- R18: 默认文件后端位于 `~/.novi/` 的私有路径，目录权限 `0700`、文件权限 `0600`，通过同目录临时文件、flush/sync 和原子 rename 发布更新。
- R19: store 至少按 MCP resource、authorization-server issuer、server identity/fingerprint 隔离 token、过期信息、refresh token、动态 client information 和 discovery cache。
- R20: store 损坏、字段非法或版本不兼容时必须 fail-closed 并保留原文件，不得降级为空后覆盖；公共诊断只能暴露 server、状态和可行动指引。
- R21: token、authorization code、PKCE verifier、client secret 和原始 OAuth response 不得进入日志、tool events、session transcript、Gateway snapshot、普通 settings projection或错误正文。
- R22: `McpOAuthStore` 保持后端抽象，首版不强制 OS keychain；后续可以增加 Keychain/Secret Service 等实现而不改变 manager/transport 契约。
- R23: 一个 MCP server 声明首版只绑定一个 OAuth 身份；token、client registration、scope 与 discovery state 都归属于该声明的稳定 identity。
- R24: 同一远程服务的多账户通过不同 server name 的多个声明表达；不同声明继续拥有独立 source id、approval、权限规则、catalog 和 OAuth state。
- R25: 首版不提供单声明内 account/profile 列表、运行时账户切换、默认账户选择或 Gateway route 到 OAuth account 的绑定。
- R26: 首版支持交互式 OAuth authorization-code flow，并强制 PKCE S256；该流程只能由 TUI/独立 CLI 发起。
- R27: 首版支持预注册 client 的 `client_credentials` flow，供 Gateway、Headless、CI 和服务账户无交互使用。
- R28: 首版 client authentication method 限于 `client_secret_basic`、`client_secret_post` 和 public client `none`，并依据授权服务器 metadata 与 client 配置选择。
- R29: `private_key_jwt`、JWT bearer、自定义 grant、device authorization flow 和私钥生命周期不在首版范围。
- R30: HTTP MCP 默认具备 OAuth discovery 能力，但只有在匿名/静态-header/已有-token 请求收到适用的 Bearer 401/403 challenge 后触发；连接成功时不得产生额外授权交互。
- R31: server config 支持 `oauth: false` 明确禁止 discovery；禁止后认证挑战产生稳定配置错误，不得自动回退 OAuth。
- R32: 静态 headers 保持兼容并先于 challenge 生效；OAuth token 不写回 headers 配置，也不得覆盖非 Authorization headers。
- R33: resource metadata URL、authorization-server issuer、redirect、token endpoint 和 registration endpoint 必须经过协议要求与网络安全校验；OAuth discovery 不得成为访问私网、非 HTTPS 端点或跨 resource token 复用的旁路。
- R34: authorization-code 登录使用只绑定 `127.0.0.1` 的临时 loopback callback server 与系统分配端口；callback path 由 server identity 生成稳定路径，以兼容 DCR client information 复用；state 与 PKCE verifier 每次随机且仅可消费一次。
- R35: TUI/CLI 尝试打开默认浏览器，同时始终显示可复制的 authorization URL；打开失败不终止流程，CLI 支持 `--no-open`。
- R36: 登录默认 5 分钟超时，支持用户取消；成功、失败、取消、超时或 state 不匹配后都关闭 listener 并清除未完成的 state/verifier。
- R37: 同一 server 同时只允许一个登录流程；并发请求必须返回稳定 `MCP_AUTH_IN_PROGRESS`，不得复用或覆盖另一流程的 callback state。
- R38: 首版不实现 device-code flow、粘贴 authorization code 或远程 callback relay；SSH 场景由用户使用 `--no-open` 与端口转发解决。
- R39: 模型触发的 connect/tool/request 路径不得自动打开浏览器、开始 authorization-code flow 或扩大 scope。
- R40: access token 失效时可以先自动 refresh，并在成功后对原操作做有界重试；refresh 失败返回 `MCP_AUTH_REQUIRED`。
- R41: 403 insufficient-scope challenge 记录为当前已请求 scope 与 challenge scope 的并集，但只返回 `MCP_AUTH_SCOPE_REQUIRED`；只有显式 login/reauthorize 操作可以请求扩大后的 scope。
- R42: TUI 提供明确 reauthorize 指引；Headless、Gateway 和 child-agent 返回结构化错误与独立 CLI 指引，不进入等待交互状态。
- R43: 401/403、refresh 和原操作重试都有固定上限，并对同一 operation 防循环；错误必须区分 auth-required、scope-required、transport 和 tool failure。
- R44: TUI 和独立 CLI 都提供 `logout <server>`；若 discovery metadata 提供 revocation endpoint，先尽力撤销 refresh/access token，但服务端失败不得阻止本地 token、verifier 和 pending-scope 清理。
- R45: logout 保留 discovery cache 与预注册/DCR client information；撤销失败必须明确提示“本地已退出，服务端 token 可能仍有效”，且提示中不得包含 token 或原始响应。
- R46: TUI 和独立 CLI 提供 `reset-auth <server>`，在 logout 语义之上清除 discovery cache、issuer/resource 绑定和 DCR client information，使下一次登录执行完整 discovery/registration。
- R47: DCR/native client metadata 使用 `application_type: "native"` 与稳定 loopback path；授权请求可使用系统分配的随机端口，callback 必须验证实际 redirect URI、稳定 path、state 和单次消费状态。
- R48: user-local OAuth store 的读改写和 token refresh 必须具备进程内串行化与跨进程互斥；TUI、独立 CLI、Gateway 或 Headless 同时使用同一 server identity 时，不得因并发 refresh 覆盖轮换后的 refresh token。
- R49: 获取互斥后必须重新读取当前 generation/token；网络 refresh、token rotation 与最终原子提交属于同一 server identity 的 lease。锁等待有界，活跃锁不得被抢占，确认 owner 已退出且超过保守期限后才可恢复 stale lock。
- R50: 显式 login/reauthorize/logout/reset-auth 必须先解析当前 MCP plan；project server 未批准、声明无效、stdio server 或 server identity 已变化时必须在 discovery、浏览器和 token mutation 之前拒绝。
- R51: `connectMcp: false` preflight 不得读取 token、执行 discovery、refresh 或其他 OAuth 网络请求；只有实际连接或显式 auth 命令进入 OAuth runtime。
- R52: OAuth 配置、store 状态与错误必须使用稳定的结构化类型和错误码；auth-required/scope-required/config-invalid 不可标记为普通 transport retry，防止模型侧循环。

## Acceptance Criteria

- [x] AC1: HTTP config 可表达默认 challenge-driven OAuth、`oauth: false`、authorization-code、client_credentials、预注册 client、CIMD 与 DCR；非法组合在 plan/config 阶段产生不含 secret 的稳定诊断，stdio 行为不变。
- [x] AC2: fake protected-resource/authorization server 覆盖 `WWW-Authenticate` 与 well-known discovery、RFC 8414/OIDC fallback、resource/issuer 绑定、PKCE S256、state、CIMD、DCR 和三种 client authentication method；不安全 endpoint、错误 audience 和不可用 registration 均 fail-closed。
- [x] AC3: TUI `/mcp login <server>` 与 `novi mcp login <server>` 能通过 `127.0.0.1` 随机端口、稳定 callback path 完成授权；覆盖浏览器打开失败、`--no-open`、取消、五分钟超时、错误 state、重复 callback 和同 server 并发登录。
- [x] AC4: TUI 与独立 CLI 提供 status、login/reauthorize、logout、reset-auth；project server approval 在任何 discovery/browser 行为前生效，未知、无效和 stdio server 均给出可行动错误。
- [x] AC5: Gateway、Headless、child-agent 与模型触发路径从不打开浏览器或扩大 scope；有效 token 或配置正确的 client_credentials 可无交互连接，authorization-code token 缺失/失效时返回 `MCP_AUTH_REQUIRED`，insufficient scope 返回 `MCP_AUTH_SCOPE_REQUIRED`，提示指向独立 CLI。
- [x] AC6: access token 过期时只进行一次受控 refresh 和一次原操作重试；refresh rotation 被持久化，refresh 失败清理无效 token 并转为 auth-required，401/403 不会形成 reconnect/auth 循环。
- [x] AC7: `McpOAuthStore` 具有版本校验、0700/0600 权限、原子发布、secret redaction、损坏文件保留与 fail-closed 行为；并发 TUI/CLI/Gateway refresh 通过 per-server lease 与 generation re-read 保证不丢失轮换 token。
- [x] AC8: logout 在有/无 revocation endpoint、撤销成功/失败时都清除本地 token 与 pending scope，并保留 discovery/client information；reset-auth 额外清除 issuer/resource/discovery/DCR 状态。
- [x] AC9: 一个声明只使用一个 OAuth identity；同 URL 的不同 server name 拥有独立 approval、catalog、token、scope 和 registration，fingerprint 变化后旧授权不会被复用。
- [x] AC10: 现有静态 HTTP headers、无 OAuth HTTP server、所有 stdio server、动态 Tools catalog、权限委托、result lifecycle、builtin-only 与 `connectMcp: false` preflight 全部保持回归覆盖。
- [x] AC11: README/工具系统设计文档给出 supported/degraded/unsupported 矩阵、配置示例、交互/非交互流程、错误码、存储与威胁边界；token、code、verifier、secret 和原始响应不进入日志、事件、session 或 snapshot。
- [x] AC12: MCP 聚焦测试、相关 TUI/CLI/Headless/Gateway/child-agent 回归、typecheck、lint、完整测试、build 和 `git diff --check` 全部通过。

## Out of Scope

- 重写已经完成的 Tools catalog/search/invoke/result 主链。
- MCP server implementation 或把 Novi 暴露为 MCP server。
- 与 MCP 无关的 OS sandbox、浏览器自动化或通用 DAG。
- MCP Resources、Prompts、Roots、Sampling、Elicitation 与 Tasks。
- device authorization、粘贴 authorization code、远程 callback relay、私钥/JWT grant、自定义 grant 与单声明多账户切换。
- 操作系统 Keychain/Secret Service 后端、在 project config 中保存明文 client secret、由 Novi 托管公共 CIMD 文档。
- Gateway 聊天用户到第三方 OAuth account 的身份绑定，或允许模型自行登录、重新授权和扩大 scope。
