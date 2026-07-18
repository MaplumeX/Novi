# Remote MCP OAuth 技术设计

## 1. 目标与非目标

本设计在现有 `McpPlan -> McpClientManager -> StreamableHTTPClientTransport -> catalog/runtime` 主链中加入 Remote MCP OAuth。OAuth 只负责 HTTP transport 的身份获取和生命周期，不替代 project trust、MCP server approval、`PermissionGate`、tool budget 或 catalog revision。

本期支持 authorization code + PKCE、预注册 client、CIMD、DCR、client credentials、refresh/rotation、显式 reauthorize/logout/reset-auth，以及交互和非交互表面的稳定失败语义。Resources/Prompts/Roots、Sampling/Elicitation、Tasks、device flow、JWT/private-key grant 和单声明多账户均不进入本设计。

## 2. 总体架构与唯一授权入口

```text
user/project mcp.json
  -> config validation + fingerprint + project approval
  -> McpPlan (只有 connectable HTTP entry 可进入 OAuth)
  -> McpOAuthCoordinator
       -> McpOAuthStore（版本化状态、binding/global locks）
       -> SDK auth()（discovery、CIMD/DCR、PKCE、token/refresh）
       -> loopback callback / browser（仅显式 TUI/CLI 操作）
  -> McpClientManager
       -> 带 credential snapshot + challenge capture 的 HTTP transport
       -> 连接、catalog、tools/call

显式入口：TUI /mcp login|reauthorize|logout|reset-auth
          CLI novi mcp login|reauthorize|logout|reset-auth|status
被动入口：connect/tool 收到 Bearer challenge -> refresh 或结构化 auth error
```

`McpOAuthCoordinator` 是 SDK OAuth orchestration 的唯一调用者。manager、TUI、CLI 和 Gateway 不直接读写 token，也不自行实现 discovery/token request。transport 只使用 coordinator 生成的不可变 credential snapshot，并通过注入的 fetch 捕获最近一次 Bearer challenge；这样模型触发路径不会因 SDK callback 自动进入浏览器流程。

## 3. 配置契约与 fingerprint

扩展 `src/mcp/types.ts` 和 `src/mcp/config.ts`：

```ts
type McpOAuthGrantType = "authorization_code" | "client_credentials";
type McpOAuthClientAuthMethod = "client_secret_basic" | "client_secret_post" | "none";

interface McpOAuthConfig {
  grantType?: McpOAuthGrantType; // default authorization_code
  clientId?: string;
  clientSecret?: string;         // 只允许完整 ${ENV_VAR} 占位符
  clientMetadataUrl?: string;    // HTTPS 且 pathname 不能为 /
  scopes?: string[];
  tokenEndpointAuthMethod?: McpOAuthClientAuthMethod;
}

interface McpHttpServerConfig {
  url: string;
  headers?: Record<string, string>;
  oauth?: false | McpOAuthConfig;
}
```

- `oauth === undefined`：默认 challenge-driven authorization-code；未预注册时按 CIMD、DCR 顺序注册。
- `oauth === false`：保留匿名/静态 headers，但收到 Bearer challenge 后返回 `MCP_AUTH_DISABLED`。
- `clientId` 表示预注册 client；其可选 secret 必须是完整环境变量占位符，不能是混合字符串或明文。
- `client_credentials` 必须有 `clientId` 和 secret，并禁止 `none`；它在首次 Bearer challenge 后无交互取 token。
- `clientMetadataUrl` 仅在授权服务器声明支持 CIMD 时使用，否则回落 DCR；Novi 不托管该 URL。
- scopes 去重并稳定排序；空字符串、重复项、未知字段和非法组合在 config 阶段拒绝。
- fingerprint 加入 grant、clientId/clientMetadataUrl、scope、auth method 与 secret 占位符哈希，不包含解析后的 secret。配置变化产生新的 approval/OAuth binding，旧 token 不复用。

project 层继续按 server name 覆盖 user 层。任何显式 auth 命令先解析 plan；pending/denied/invalid project server、stdio server 和未知 server 在网络访问前拒绝。

## 4. OAuth binding 与持久模型

一个声明对应一个稳定 binding：

```ts
interface McpOAuthBindingIdentity {
  origin: "user" | "project";
  projectRoot?: string;
  serverName: string;
  serverFingerprint: string;
}

interface McpOAuthRecordV1 {
  binding: McpOAuthBindingIdentity;
  resource?: string;
  issuer?: string;
  grantType: McpOAuthGrantType;
  registrationMode?: "pre_registered" | "cimd" | "dcr";
  discovery?: OAuthDiscoveryState;
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  tokenObtainedAt?: string;
  grantedScopes: string[];
  pendingScopes: string[];
  generation: number;
  updatedAt: string;
}

interface McpOAuthFileV1 {
  version: 1;
  records: Record<string, McpOAuthRecordV1>;
}
```

record key 是 binding canonical JSON 的 SHA-256；record 内再次保存 binding 以检测碰撞和错误复用。resource 与 issuer 在 discovery 后写入，并在每次使用时与当前 server/challenge 严格比较。一个相同 URL 的不同 server name 会产生完全独立的 token、registration、scope 和 catalog。

state、authorization code 和 PKCE verifier 只保存在当前登录操作的内存对象中，不写入 store。DCR 返回的 `client_secret` 属于 store secret，采用与 token 相同的 redaction 和文件权限边界。预注册 client secret始终在使用时从环境变量解析，不落盘。

## 5. Store、原子写入与跨进程并发

新增 `src/mcp/oauth/store.ts`，默认路径 `~/.novi/mcp-oauth.json`。目录强制 `0700`，文件和临时文件强制 `0600`；写入流程为同目录临时文件、文件 sync、atomic rename、目录 sync。schema、version 或任意 secret-bearing record 非法时返回 `MCP_AUTH_STORE_INVALID`，保留原文件且禁止用空 store 覆盖。

并发采用两层 lease：

1. per-binding auth lease：覆盖同一 binding 的 refresh、client-credentials token request、login start、code exchange、logout 和 reset，避免两个进程同时使用轮换 refresh token。
2. global store write lock：只覆盖“重新读取完整文件 -> 合并一个 record patch -> 原子发布”，避免不同 binding 并行修改时互相覆盖。

固定加锁顺序为 binding lease 后 global write lock。每次获得 binding lease 后必须重新加载 record/generation；如果等待期间已有进程刷新成功，当前调用直接使用新 generation，不再发送第二次 refresh。网络请求不持有 global write lock，但 refresh/token exchange 在 binding lease 内完成。

lock 文件使用独占创建，包含 PID、nonce、createdAt 和 binding hash；等待和重试有界。只有 owner PID 已不存在且锁龄超过保守阈值时才能恢复 stale lock，活跃锁永不抢占。进程内再用 keyed promise lane 串行化，减少不必要的文件锁竞争。

store 暴露接口而不是直接暴露 JSON：`inspect`、`withBindingLease`、`patchRecord`、`clearTokens`、`resetRecord`。后续 Keychain/Secret Service 后端实现相同接口，不改变 coordinator/manager。

## 6. Challenge-driven 连接与静态 headers 兼容

`src/mcp/transport.ts` 为 HTTP transport 接受 `McpHttpAuthSnapshot` 与 challenge recorder：

- 没有 OAuth token 时原样发送现有 headers，包括用户配置的 Authorization。
- 有已保存 OAuth access token 时，仅在本次 transport request 中设置 Bearer Authorization；不修改 config，所有非 Authorization headers 原样保留。
- 注入 fetch 观察 401/403 的 `WWW-Authenticate`，只保存解析后的 `resource_metadata`、scope、error、status 和 operation generation；不保存响应正文或 Authorization。
- 没有适用 Bearer challenge 时按现有 transport/protocol failure 处理。

实际连接流程：

1. 使用匿名、静态 Authorization 或已保存 access token 发起正常 MCP 请求，不预先 discovery。
2. 成功则不产生 OAuth 网络请求。
3. 401 Bearer challenge 且 `oauth !== false` 时，manager 调用 coordinator。
4. 有 refresh token、client_credentials 配置或等待期间出现了更新 generation 时，coordinator 在 lease 内完成恢复，manager 重建 transport 并只重试一次。
5. 需要 authorization code 时，被动路径返回 `MCP_AUTH_REQUIRED`；绝不启动 listener 或浏览器。
6. 403 insufficient_scope 只合并 pending scope 并返回 `MCP_AUTH_SCOPE_REQUIRED`，不自动 reauthorize 或重试。

`connectMcp: false` 只解析 plan，不构造 coordinator/store snapshot、不 discovery、不 refresh。

## 7. SDK provider 与 registration

新增 `src/mcp/oauth/provider.ts` 实现 SDK `OAuthClientProvider`，并只使用 `@modelcontextprotocol/sdk/client/auth` 的公开 `auth()`、discovery types 和 client-auth hook。

- pre-registered：`clientInformation()` 直接返回配置 clientId/解析后的 secret。
- CIMD：无预注册 client 且 AS 声明 `client_id_metadata_document_supported`、配置了合法 URL 时，把 URL 作为 client_id 并保存 registration mode。
- DCR：其余情况让 SDK 通过 `saveClientInformation()` 注册并持久化返回信息；缺少 registration endpoint 时映射为可行动 `MCP_AUTH_REGISTRATION_UNAVAILABLE`。
- client_credentials 只接受 pre-registered client，不进入 CIMD/DCR 分支。
- client metadata 使用 `application_type: "native"`、`response_types: ["code"]`、`grant_types` 与配置一致、稳定 loopback path 和本次随机端口 URI。
- client authentication 默认依据 metadata 与 client information 选择 basic > post > none；显式方法必须同时满足 client 配置与 AS metadata，否则拒绝。
- `prepareTokenRequest()` 为 client_credentials 生成标准 grant/scope；authorization code 使用 SDK 默认 code、verifier、redirect URI。
- `validateResourceURL()` 只接受与当前 approved MCP resource 正确绑定的 audience。

provider 的 store save 方法在当前 binding lease 内提交，token 保存时递增 generation，并将 `expires_in` 与 `tokenObtainedAt` 组合为过期判断依据。refresh response 未返回新 refresh token 时保留旧 token；返回新 token 时原子替换。

## 8. Discovery 与网络安全

discovery 优先使用 challenge 给出的 protected-resource metadata URL，否则使用 RFC 9728 well-known；authorization-server metadata 使用 RFC 8414，失败后按 SDK 公开流程尝试 OIDC discovery。cache 命中时避免重复 discovery；连续 issuer/resource/auth 失败会使 cache 失效并要求显式重试，不能静默切换 issuer 后复用旧 token。

所有 OAuth URL 都通过 host-side validator：禁止 userinfo、fragment、非 HTTPS（loopback redirect 是唯一 HTTP 例外）、无界 redirect 和 scheme downgrade；每个 HTTP redirect hop 重新验证。resource metadata URL 必须与 MCP resource 满足协议绑定，issuer 必须来自已验证 PRM，token/registration/revocation endpoint 必须属于该 issuer metadata。

网络地址按 trust class 校验：公开 MCP resource 不能通过 metadata 跳到 loopback、link-local 或私网；显式配置为本地/私网的 MCP resource 只能访问同等 trust class 且由 PRM 明确声明的 issuer。DNS 解析结果和连接目标都检查，防止 DNS rebinding。安全校验失败使用 `MCP_AUTH_ENDPOINT_UNSAFE`，不回落到弱校验。

## 9. 交互式 callback 与流程状态机

authorization-code 流程使用 `McpInteractiveLogin`：

```text
idle -> preparing -> awaiting_callback -> exchanging -> authorized
                    -> cancelled | timed_out | failed
```

- listener 只绑定 `127.0.0.1`，端口传 `0` 由系统分配。
- callback path 为 `/oauth/callback/<sha256(binding).slice(...)>`，同一 fingerprint 稳定；query 只接受一次。
- 每次生成新的高熵 state 和 PKCE verifier；验证实际 host、port、path、state、code/error，拒绝重复 callback。
- listener 启动后再生成 client metadata/authorization URL，确保 redirect URI 精确一致。
- 始终打印 URL；默认以无 shell 的平台适配器 best-effort 打开浏览器，`--no-open` 跳过。
- 五分钟超时；成功、错误、取消、超时和异常都在 `finally` 中关闭 listener、擦除 verifier/state。

CLI 登录前台等待 callback，SIGINT 取消。TUI 登录作为 runtime handle 持有的后台 operation 启动，立即打印 URL；`/mcp cancel <server>` 可取消，完成后打印结果并刷新工具。跨进程 flow lock 使第二个 login/reauthorize 返回 `MCP_AUTH_IN_PROGRESS`。

`login` 在无有效授权时发起授权；已有有效授权时显示状态并要求使用 `reauthorize`。`reauthorize` 强制 authorization prompt，scope 为配置 scope、granted scope 与 pending scope 的并集；旧 token 在新流程成功前保留，失败不破坏当前可用授权。

## 10. 被动 refresh、scope 与重试上限

连接前若 store 显示 token 已过期且已有 discovery/refresh token，可在实际连接路径做一次 refresh；没有已建立 OAuth 状态时仍先发送普通请求，只有 challenge 后 discovery。

同一 connect/tool operation 的 auth recovery budget 固定为：最多一次 refresh/client-credentials token request、最多一次 transport rebuild、最多一次原操作重试。manager 以 operation id 记录 budget，reconnect 不能重置同一调用的计数。

403 challenge 的 scope 先规范化，再与 `pendingScopes` 做集合并集。`MCP_AUTH_SCOPE_REQUIRED` 和 `MCP_AUTH_REQUIRED` 都是 terminal/non-retryable model errors；提示只含 server name、所需操作和可公开 scope，不含 URL query、token 或原始响应。只有显式 reauthorize 消费 pending scopes。

## 11. logout、reset-auth 与 revocation

`logout` 在 binding lease 内读取 discovery/client auth，若存在 revocation endpoint，依次 best-effort 撤销 refresh token 与 access token；随后无条件清除 tokens、token timestamps、pending scopes 和任何内存 flow/verifier，保留 issuer/resource、discovery 与 client information。

revocation 失败时命令仍成功完成本地退出，但返回 warning：本地已退出、服务端 token 可能仍有效。`reset-auth` 先执行相同本地清理，再删除 discovery、issuer/resource、DCR/CIMD client information 和 registration mode；预注册 client 信息来自 config，不在 store 中删除。下一次登录必须完整 discovery/registration。

## 12. manager、runtime 与跨表面集成

`McpClientManagerOptions` 增加可注入 coordinator/transport auth context，`connectEntry` 和 `callTool` 统一调用 auth recovery helper。auth-required 等状态继续遵守 per-server fail-soft：该 server unavailable/degraded，但 builtin 和其他 MCP server 正常。

`McpRuntimeHandle` 增加 `oauth` controller，提供 status/login/reauthorize/cancel/logout/resetAuth；TUI command 不直接接触 store。成功 login/logout/reset 后通过现有 `refreshTools()`/reconnect 重建 transport 和 catalog projection。

独立 CLI 的 `mcp` positional dispatcher 在模型 provider probe、bootstrap 和 TUI 创建之前执行，只加载 cwd、MCP plan 与 OAuth service，因此服务器授权不要求配置 LLM provider。支持：

```text
novi mcp status [server] [--cwd <dir>] [--json]
novi mcp login <server> [--cwd <dir>] [--no-open]
novi mcp reauthorize <server> [--cwd <dir>] [--no-open]
novi mcp logout <server> [--cwd <dir>]
novi mcp reset-auth <server> [--cwd <dir>]
```

TUI 对应 `/mcp status|login|reauthorize|cancel|logout|reset-auth`。Headless、Gateway 和 child-agent 不公开交互入口，只被动使用/refresh 已有 token 或执行配置的 client_credentials；它们的公共 event/snapshot 仅投影 redacted error code、server 和 guidance。child-agent 仍先受 `mcpSourceAllowlist` 过滤，不得借 OAuth 发现被排除 source。

## 13. 错误码与 redaction

新增稳定码：

- `MCP_AUTH_REQUIRED`
- `MCP_AUTH_SCOPE_REQUIRED`
- `MCP_AUTH_DISABLED`
- `MCP_AUTH_IN_PROGRESS`
- `MCP_AUTH_CONFIG_INVALID`
- `MCP_AUTH_STORE_INVALID`
- `MCP_AUTH_DISCOVERY_FAILED`
- `MCP_AUTH_REGISTRATION_UNAVAILABLE`
- `MCP_AUTH_ENDPOINT_UNSAFE`
- `MCP_AUTH_CALLBACK_INVALID`
- `MCP_AUTH_TIMEOUT`
- `MCP_AUTH_REVOKE_FAILED`（仅 warning projection）

扩展 `src/tools/events.ts` 的 retry 分类：上述 auth-required/scope/config/store/callback 错误均为 `retryable: false`；只有底层短暂 network/transport 仍按既有规则 retryable。统一 sanitizer 清理 Bearer/Basic、client_secret、code、refresh/access token、URL query/fragment 和 OAuth JSON 字段，错误正文单行且有界。

## 14. 支持矩阵

| 能力 | TUI | 独立 CLI | Headless/Gateway/child | 状态 |
| --- | --- | --- | --- | --- |
| 已有 token 使用与有界 refresh | 支持 | 支持 | 支持 | supported |
| authorization code + PKCE | 支持 | 支持 | 不发起；返回 guidance | supported |
| client credentials | 支持 | 支持 | 支持 | supported |
| pre-register / CIMD / DCR | 支持 | 支持 | 只使用已有 registration；client_credentials 仅 pre-register | supported |
| insufficient-scope step-up | 显式 reauthorize | 显式 reauthorize | 只返回错误 | supported |
| device flow / remote relay | 不支持 | 不支持 | 不支持 | unsupported |
| 多账户单声明切换 | 不支持 | 不支持 | 不支持 | unsupported |
| OS keychain 后端 | 文件后端 | 文件后端 | 文件后端 | explicitly degraded |

## 15. 兼容、回滚与迁移

- 无 MCP、stdio-only、HTTP 成功匿名连接和旧静态 headers 不创建 OAuth 持久状态。
- 没有旧 OAuth store，无需数据迁移；新文件首次成功 mutation 时创建。
- `oauth: false` 可对单 server 立即回滚自动 discovery；完整代码回滚只留下未被旧版本读取的私有 store 文件，不影响 `mcp.json` 和 approval store。
- OAuth 失败不清空 last-known-good catalog；server 可显示 degraded/auth-required，重新授权后沿用既有 catalog refresh 流程。
- 任务采用一个主任务、四个核心实现工作包加文档与最终验收，因为 config/store/provider/manager 的 binding 与错误契约高度耦合；每个工作包都设独立测试检查点，避免并行形成两套 auth 真相。

## 16. 验证重点

- config/fingerprint：所有合法模式、明文 secret 拒绝、placeholder、overlay、project approval-before-network。
- store：权限、atomic fsync/rename、corrupt/version fail-closed、redaction、global write race、same-binding refresh race、stale lock。
- protocol：challenge/well-known、RFC 8414/OIDC、resource/issuer、CIMD/DCR、basic/post/none、PKCE/state、rotation。
- interaction：随机端口稳定 path、browser failure、no-open、cancel/timeout、duplicate callback、并发 flow、reauthorize 保留旧 token。
- runtime：anonymous success 无 discovery、401 单 refresh/重试、403 只记录 scope、Gateway/Headless/child 不交互、preflight 零 OAuth I/O。
- cleanup：revocation success/failure、logout 保留 registration、reset-auth 清除 registration/discovery、所有公共事件/日志无 secret。

## 17. 协议依据

- MCP Authorization：<https://modelcontextprotocol.io/specification/draft/basic/authorization>
- OAuth 2.0 for Native Apps（RFC 8252）：<https://www.rfc-editor.org/rfc/rfc8252>
- OAuth 2.0 Protected Resource Metadata（RFC 9728）：<https://www.rfc-editor.org/rfc/rfc9728>
- OAuth 2.0 Authorization Server Metadata（RFC 8414）：<https://www.rfc-editor.org/rfc/rfc8414>
- Resource Indicators（RFC 8707）：<https://www.rfc-editor.org/rfc/rfc8707>
