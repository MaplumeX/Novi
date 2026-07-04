# Web search and fetch tools

## Goal

为 Novi 内置工具集补充网络能力：`web_search`（搜索网页，返回链接元数据）和
`fetch_content`（抓取 URL 正文，转 markdown）。让模型能自主检索最新信息并读取
网页内容，无需用户手动 `bash` curl。

## Background

Novi 目前内置工具仅覆盖本地文件系统操作（read/write/edit/ls/glob/grep）、bash
与 todo，无任何网络工具。参考实现：

- **Hermes Agent** — `web_search`/`web_extract` 分离 + `WebSearchProvider` ABC +
  env-var 自动探测 + 固定响应信封 `{success, data:{web:[{title,url,description,position}]}}` +
  长内容截断+存全量到 cache+footer 指向 read_file
- **pi-web-access** — readability+linkedom 提取 + Gemini 回退 + curator 浏览器
  + 7 provider + YouTube/视频/PDF
- **opencode `webfetch`** — turndown 转 markdown + 5MB 硬上限 + Cloudflare 重试
- **pi-brave-search-extension** — shell 到 `bx` CLI（引入外部二进制依赖，不采纳）

Novi 采纳：search/fetch 分离、provider 抽象、固定信封、readability+linkedom、
截断+存全量+footer 模式。**不**采纳：插件系统、curator 浏览器、summary 生成、
activity widget、YouTube/视频/PDF、Gemini 回退、shell 到 CLI。

## Confirmed Facts

- 工具基线：`AgentTool<TParameters>` 契约（见 `pi-agent-core-api.md`），参数用
  typebox，execute 内部 throw 表达错误（harness 转 `isError`），返回
  `AgentToolResult`（`textResult` helper 已存在 `src/tools/shared.ts`）。
- 工具注册：`BuiltinToolRegistry.add(name, factory)` 在 `src/tools/index.ts`，
  每个工具文件导出 `createXxxTool(env): AgentTool`。无数组字面量需改。
- 工具测试：`tools/__tests__/helpers.ts` 提供 `setupEnv()`/`getTool(env, name)`/
  `writeFixture(dir, rel, content)`，`finally` 清理，测错误路径。
- 凭证机制：`~/.novi/credentials.json`（0600）+ env var，`loadCredentials(env)` +
  `injectCredentialsIntoEnv`（env 已设的 key 不被覆盖）。bootstrap 在 resolveModel
  之前注入。
- settings 机制：`~/.novi/settings.json` + `<cwd>/.novi/settings.json`，
  `NoviSettings` 接口在 `src/settings.ts`，`resolveSettings` 做合并 + 来源追踪。
- 路径：`getNoviDir()` 返回 `~/.novi`（`src/config.ts`）。
- 错误处理：throw-on-failure，无自定义 Error 子类，`textResult("error:…")` 禁用于
  真失败（见 `error-handling.md`）。
- `read_file` 工具支持 `path`/`offset`/`limit` 1-based 分页——footer 指向它即可。
- ESM + Node16：相对 import 用 `.js` 扩展名。typebox 导入为 `* as Type`。
- DuckDuckGo 无 key 方案：`https://html.duckduckgo.com/html/` 端点返回可解析 HTML
  （result 链接为 `uddg=` 参数需 URL-decode），零配置开箱即用。

## Requirements

### R1: `web_search` 工具

- **R1.1** 参数：`query: string`（必填）、`limit?: number`（1-20，默认 5）。
- **R1.2** 返回：`{title, url, description}` 列表（markdown 格式的文本返回给模型，
  details 含结构化数组）。
- **R1.3** provider 抽象：`SearchProvider` 接口（`name`、`isAvailable()`、
  `search(query, opts)`），`resolveProvider()` 读配置 → env-var 探测 → 第一个
  available 的。
- **R1.4** 起始 provider：**DuckDuckGo**（无需 key，fetch `html.duckduckgo.com/html/`
  端点，解析 HTML）。结构上新增 provider 只需新增一个文件 + 注册一行。
- **R1.5** provider 未配置/不可用：throw 清晰错误提示如何配置（DuckDuckGo 不适用，
  此分支主要留给未来 key-gated provider）。
- **R1.6** AbortSignal 透传到 fetch 调用，Ctrl-C 可中断。
- **R1.7** 无网络调用时不阻塞工具注册（`isAvailable()` 只读 env，不发网络请求）。

### R2: `fetch_content` 工具

- **R2.1** 参数：`url: string`（必填，必须 http/https）、`format?:
  "markdown"|"text"`（默认 markdown）、`char_limit?: number`（≥2000，默认 15000）。
- **R2.2** 行为：fetch URL → 用 `@mozilla/readability` + `linkedom` 提取正文 →
  markdown（或 text）。非 HTML 内容原样返回。
- **R2.3** 长内容截断：超过 `char_limit` 时 head 75% + tail 25%（行边界对齐），
  全量存到 `~/.novi/cache/web/<host>-<hash>.md`（上限 2MB，超出截断并标注），
  footer 指向 `read_file path="..." offset=N limit=200` 翻页。
- **R2.4** base64 内联图片 → `[IMAGE: alt]` 占位（保留 alt 文本，丢弃 blob），
  真实 http/https 图片 URL 保留。
- **R2.5** **SSRF 防护**：拒绝私有/内网 URL（`127.0.0.1`、`10.x`、`172.16-31.x`、
  `192.168.x`、`169.254.x`、`::1`、`fc00::/7`、`localhost` 等）。被拒时 throw
  清晰错误。
- **R2.6** AbortSignal 透传。HTTP 错误（4xx/5xx）throw（含状态码 + URL）。
- **R2.7** User-Agent：用诚实标识（`Novi/0.0.0`），不伪装浏览器。

### R3: 配置与凭证

- **R3.1** `NoviSettings` 新增可选 `webSearch?: { provider?: string }`（缺省
  auto-detect）。`src/settings.ts` 接口 + `resolveSettings` 透传。
- **R3.2** 未来 key-gated provider 的 API key 走 `BRAVE_SEARCH_API_KEY` 之类的
  env var（复用 `credentials.ts` 注入机制）。DuckDuckGo 起步无需任何 key。
- **R3.3** `~/.novi/cache/web/` 目录按需创建（fetch_content 首次存储时）。

### R4: 注册与构建

- **R4.1** `src/tools/index.ts` 新增 `.add("web_search", ...)` 和
  `.add("fetch_content", ...)`。
- **R4.2** 新增依赖：`@mozilla/readability`、`linkedom`。
- **R4.3** 无需改 `bootstrap.ts`（工具注册已由 `createBuiltinTools` 统一处理）。

### R5: 测试

- **R5.1** DuckDuckGo provider：mock global `fetch`，测请求构造 + HTML 解析 +
  `uddg=` URL decode + 空结果。
- **R5.2** `resolveProvider`：测配置优先、env-var 探测、无可用 provider 抛错。
- **R5.3** `fetch_content`：HTML fixture 测 readability 提取、截断+存储+footer、
  base64 图片替换、SSRF 拒绝、非 HTML 透传、HTTP 错误 throw。
- **R5.4** 用 `setupEnv()`/`getTool()` 现有 helper，mock `fetch` 用 vitest
  `vi.spyOn(globalThis, "fetch")` 或 `vi.stubGlobal`。
- **R5.5** 不发真实网络请求（测试隔离）。

## Acceptance Criteria

- [ ] `web_search({ query: "..." })` 返回 DuckDuckGo 结果（mock 验证请求格式）
- [ ] `web_search` 无可用 provider 时 throw 清晰错误
- [ ] `fetch_content({ url: "https://example.com" })` 返回 readability 提取的
      markdown（mock fetch 返回 HTML fixture）
- [ ] 超长页面被截断，全量存到 `~/.novi/cache/web/`，footer 指向 read_file
- [ ] base64 图片被替换为 `[IMAGE: alt]`
- [ ] SSRF：`fetch_content({ url: "http://127.0.0.1" })` throw 拒绝错误
- [ ] `fetch_content({ url: "ftp://..." })` throw 非 http/https 错误
- [ ] HTTP 4xx/5xx throw（含状态码）
- [ ] `npm run typecheck && npm run lint && npm run test && npm run build` 全绿
- [ ] `NoviSettings.webSearch` 字段在 `src/settings.ts` 定义且 `resolveSettings`
      正确透传
- [ ] `ARCHITECTURE.md` 更新（新增工具 + 新增依赖 + cache 目录约定）
- [ ] spec 更新：directory-structure.md 新增 `web-search/` 子目录说明，
      pi-agent-core-api.md 或新文件记录工具契约（若产生新模式）

## Out of Scope

- 多 provider 并发探测 / 自动 fallback 链（仅单 provider 解析，结构预留）
- curator 浏览器 / summary 生成 / activity widget / Glimpse 窗口
- YouTube / GitHub clone / PDF / 本地视频 / 图片搜索
- Gemini LLM 回退提取
- Brave/Tavily/Exa 的实际实现（仅留 provider 接口结构，不实现）
- Cloudflare 反爬重试（诚实 UA，被拒就 throw）
- 自定义 provider 注册（类似 models.json 的用户自定义）——未来工作
- provider 切换的 TUI 命令——未来工作

## Open Questions

（无——所有决策已在规划前与用户确认）