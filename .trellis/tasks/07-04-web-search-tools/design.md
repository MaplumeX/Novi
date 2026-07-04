# Design: Web search and fetch tools

## Architecture

两个新工具文件 + 一个 provider 子目录，挂在现有 `src/tools/` 下。不改 bootstrap，
改一处 `tools/index.ts` 注册，改一处 `settings.ts` 加可选字段，新增两个依赖。

```
src/tools/
├── index.ts                  # +2 个 .add() 调用
├── shared.ts                  # 不改
├── web-search.ts              # 新增：createWebSearchTool(env)
├── fetch-content.ts           # 新增：createFetchContentTool(env)
├── web-search/
│   ├── provider.ts            # SearchProvider 接口 + resolveProvider()
│   ├── duckduckgo.ts          # DuckDuckGo provider
│   ├── ssrf.ts                # isPrivateUrl(url) 检查
│   └── __tests__/
│       ├── duckduckgo.test.ts
│       ├── provider.test.ts
│       └── ssrf.test.ts
└── __tests__/
    ├── web-search.test.ts
    └── fetch-content.test.ts
```

## Data Flow

### web_search

```
model 调用 web_search({ query, limit? })
  → createWebSearchTool.execute
    → resolveProvider(settings.webSearch?.provider)
      → 读 settings.webSearch.provider（若显式配置）
      → 否则遍历已注册 providers，取第一个 isAvailable()=true 的
    → provider.search(query, { limit, signal })
      → DuckDuckGo: fetch("https://html.duckduckgo.com/html/", POST form: q=, signal)
      → 解析返回 HTML，提取 .result__a 链接 + .result__snippet
      → uddg= 参数 URL-decode 得真实 URL
      → 返回 SearchResult[]
    → 格式化为 markdown 文本返回给模型
    → details 含 { provider, query, results: SearchResult[] }
  → throw on failure (harness 转 isError)
```

### fetch_content

```
model 调用 fetch_content({ url, format?, char_limit? })
  → createFetchContentTool.execute
    → 校验 url 是 http/https
    → isPrivateUrl(url) → throw 若内网
    → fetch(url, { signal, headers: { "User-Agent": "Novi/0.0.0" } })
    → 检查 content-type + content-length
    → 非 HTML → 原样文本返回（截断到 char_limit）
    → HTML → parseHTML(html) → Readability(document).parse()
      → article.content (HTML) 或 article.textContent
      → format=markdown: 用 Readability 的 article.content（已是 cleaned HTML）
        转 markdown（简单处理：去 script/style，保留 a/img/h1-h6/p/ul/ol/pre/code）
      → format=text: article.textContent
    → replaceBase64Images(text) → [IMAGE: alt] 占位
    → truncateWithFooter(text, url, char_limit)
      → 若 ≤ char_limit：直接返回
      → 若 > char_limit：head 75% + tail 25%（行边界对齐）
        → storeFullText(url, text) → ~/.novi/cache/web/<host>-<hash>.md（2MB 上限）
        → footer: "Full text saved to: <path>\nTo read omitted middle: read_file path=\"...\" offset=N limit=200"
    → 返回 textResult(body, { url, truncated, storedPath, ... })
  → throw on HTTP 4xx/5xx / SSRF / 非 http/https
```

## Contracts

### SearchProvider 接口（`web-search/provider.ts`）

```ts
export interface SearchProvider {
  /** 稳定 id，用于 settings.webSearch.provider 配置匹配。 */
  name: string;
  /** 检查是否可用（读 env var，不发网络请求）。DuckDuckGo 永远 true。 */
  isAvailable(): boolean;
  /** 执行搜索，返回结构化结果。throw on failure。 */
  search(query: string, opts: SearchOpts): Promise<SearchResult[]>;
}

export interface SearchOpts {
  limit?: number;       // 1-20，默认 5
  signal?: AbortSignal;
}

export interface SearchResult {
  title: string;
  url: string;
  description: string;
}

/** 已注册的 provider 列表（按优先级顺序）。 */
export const PROVIDERS: SearchProvider[] = [duckDuckGoProvider /*, braveProvider, ... */];

/** 解析当前应使用的 provider。 */
export function resolveProvider(configured?: string): SearchProvider;
// - configured 显式指定且在 PROVIDERS 中找到 → 返回它（即使 isAvailable=false，调用时会抛错）
// - 否则遍历 PROVIDERS，取第一个 isAvailable()=true 的
// - 都不可用 → throw "No web search provider configured. DuckDuckGo is always available; if it failed, check network."
```

### SSRF 检查（`web-search/ssrf.ts`）

```ts
/** 拒绝私有/内网/回环 URL。返回 true 表示 URL 应被拒绝。 */
export function isPrivateUrl(url: string): boolean;
```

检查范围：
- 协议非 http/https → 不由此函数管（fetch_content 入口先校验协议）
- hostname === "localhost" 或以 "." 结尾的 localhost
- IPv4: `127.x`、`10.x`、`172.16-31.x`、`192.168.x`、`169.254.x`、`0.x`
- IPv6: `::1`、`::`（全零）、`fc00::`-`fdff:...`（unique local）
- 主机名解析为内网 IP 的不检查（不做 DNS lookup，只做字面解析——避免 DNS rebinding 的
  复杂度，且 Novi 是本地工具，bash 能直接 curl 内网，SSRF 防护主要是防模型被诱导
  fetch 内网且把结果发给第三方搜索 API）

### fetch_content 截断与存储

```ts
function truncateWithFooter(content: string, url: string, charLimit: number): {
  text: string;
  truncated: boolean;
  storedPath?: string;
};
```

- `content.length <= charLimit` → `{ text: content, truncated: false }`
- 否则 head 75% + tail 25%，行边界对齐（head 在最后一个 `\n` 截断，tail 在第一个
  `\n` 后开始）
- 全量存 `~/.novi/cache/web/<host>-<sha256(url)[:10]>.md`，上限 2MB（超出截断并标注）
- footer 包含：`Full text saved to: <path>` + `read_file path="..." offset=<head行数+2> limit=200`
- 存储失败不阻塞（best-effort，footer 改为"Full text could not be stored; re-run on a more specific URL"）

## Compatibility & Migration

- 纯新增，无破坏性改动。
- 新增依赖 `@mozilla/readability@^0.6.0`、`linkedom@^0.18.12`。
- `NoviSettings` 加可选字段 `webSearch?: { provider?: string }`——向后兼容（缺省即
  auto-detect，DuckDuckGo 永远可用，所以用户不配置也开箱即用）。
- `~/.novi/cache/web/` 目录按需创建（首次 fetch_content 截断时），不影响现有目录。

## Trade-offs

| 决策 | 选择 | 理由 |
|------|------|------|
| 起始 provider | DuckDuckGo（无 key） | 用户要求零配置开箱即用 |
| Provider 抽象程度 | 接口 + 数组 + resolver 函数 | 比 Hermes 的插件系统简单 10 倍，比硬编码可扩展 |
| HTML 解析库 | linkedom（非 jsdom） | pi-web-access 和 jeeves 都用它，比 jsdom 轻 96 个依赖 |
| 正文提取 | Readability | 业界标准，Firefox reader mode 同源 |
| 长内容策略 | 截断+存全量+footer | Hermes 模式，完美契合 Novi 已有的 read_file 分页 |
| SSRF 范围 | 仅字面解析，不 DNS lookup | bash 能直连内网，SSRF 主要防"模型把内网内容发给搜索 API"；DNS rebinding 超出范围 |
| User-Agent | 诚实 `Novi/0.0.0` | 不伪装浏览器；被 Cloudflare 拦就 throw（模型可换 URL 或提示用户） |
| base64 图片 | 替换为 `[IMAGE: alt]` | Hermes 模式，防 token 爆炸 |
| 错误表达 | throw | 遵循 error-handling.md，harness 转 isError |
| 无独立 `web-search/markdown.ts` | Readability 已返回 cleaned HTML，直接用简单正则转 MD | 避免 turndown 额外依赖；Readability 输出已足够干净 |

## Operational Notes

- DuckDuckGo `html.duckduckgo.com/html/` 端点：POST 表单 `q=<query>`，返回纯 HTML
  （无 JS），result 链接在 `.result__a`，snippet 在 `.result__snippet`，真实 URL
  在 `uddg=` query 参数（需 URL-decode）。
- DuckDuckGo 无官方速率限制文档，但高频请求可能被临时封 IP（Hermes 的 ddgs
  provider 也走非官方端点）。模型应被引导：搜索失败时换关键词或稍后重试。
- `~/.novi/cache/web/` 无自动清理机制（同 Hermes）。用户可手动清空。未来可加
  LRU/TTL 清理——本轮不做。
- DuckDuckGo 结果质量不如 Brave/Tavily（无 AI 摘要、snippet 较短），但零配置。
  未来加 key-gated provider 时，用户可在 settings 配 `webSearch.provider: "brave"`
  切换。