# Implementation Plan: Web search and fetch tools

## Checklist (ordered)

### Phase A: 基础设施

- [ ] **A1** 安装依赖：`npm install @mozilla/readability linkedom`
  - 验证：`node -e "import('@mozilla/readability').then(m=>console.log(typeof m.Readability))"`
  - 验证：`node --input-type=module -e "import {parseHTML} from 'linkedom'; console.log(typeof parseHTML)"`

- [ ] **A2** 创建 `src/tools/web-search/ssrf.ts`
  - `isPrivateUrl(url: string): boolean`
  - IPv4/IPv6/localhost 字面检查（不做 DNS lookup）
  - 单测 `__tests__/ssrf.test.ts`：覆盖各内网段、`localhost`、`::1`、公网不拒

- [ ] **A3** 创建 `src/tools/web-search/provider.ts`
  - `SearchProvider` / `SearchOpts` / `SearchResult` 接口
  - `PROVIDERS` 数组（先只含 duckDuckGo）
  - `resolveProvider(configured?)` 函数
  - 单测 `__tests__/provider.test.ts`：测显式配置、auto-detect、无可用抛错

### Phase B: DuckDuckGo provider + web_search 工具

- [ ] **B1** 创建 `src/tools/web-search/duckduckgo.ts`
  - `duckDuckGoProvider: SearchProvider`
  - `isAvailable()` 永远 true（无 key 需求）
  - `search(query, { limit, signal })`：
    - POST `https://html.duckduckgo.com/html/`，form body `q=<query>`
    - User-Agent: `Novi/0.0.0`
    - 解析返回 HTML：`.result__a`（title + href 的 `uddg=` 参数 URL-decode）
      + `.result__snippet`（description）
    - 截断到 limit
  - 单测 `__tests__/duckduckgo.test.ts`：mock `fetch`，测请求构造、HTML 解析、
    `uddg=` decode、空结果、limit 截断、fetch 失败 throw

- [ ] **B2** 创建 `src/tools/web-search.ts`（`createWebSearchTool`）
  - 参数 schema：`query: string`, `limit?: number(1-20, default 5)`
  - execute：resolveProvider → search → 格式化 markdown
  - 格式化：`## Results for "<query>"\n\n1. **<title>**\n   <url>\n   <description>\n\n...`
  - details: `{ provider, query, results }`
  - 单测 `__tests__/web-search.test.ts`（用 `getTool(env, "web_search")`）

- [ ] **B3** 注册：`src/tools/index.ts` 加 `.add("web_search", (env) => createWebSearchTool(env))`

### Phase C: fetch_content 工具

- [ ] **C1** 创建 `src/tools/fetch-content.ts`（`createFetchContentTool`）
  - 参数 schema：`url: string`, `format?: "markdown"|"text"(default markdown)`,
    `char_limit?: number(min 2000, default 15000)`
  - execute:
    1. 校验 url 以 http/https 开头，否则 throw
    2. `isPrivateUrl(url)` → throw "Blocked: URL targets a private/internal network address"
    3. `fetch(url, { signal, headers })`，User-Agent `Novi/0.0.0`
    4. `!response.ok` → throw `HTTP <status>: <url>`
    5. content-type 非 html → `response.text()` 截断到 char_limit 返回
    6. html → `parseHTML(html)` → `new Readability(document).parse()`
    7. `article?.content`（cleaned HTML）→ 转 markdown（简单正则去 script/style，
       保留 a/img/h1-6/p/ul/ol/pre/code 的语义文本）
    8. `article` 为 null → fallback `document.body?.textContent`
    9. `replaceBase64Images(text)` → `[IMAGE: alt]`
    10. `truncateWithFooter(text, url, char_limit)` → 最终文本
    11. `textResult(body, { url, truncated, storedPath, format, originalLength })`
  - 辅助函数（文件内私有）：
    - `convertHtmlToMarkdown(html: string): string`（Readability 输出已是 cleaned HTML，
      用简单正则转 MD；保留 a 的 href、img 的 src+alt、code 块）
    - `replaceBase64Images(text: string): string`（Hermes 的三步正则）
    - `truncateWithFooter(content, url, charLimit): { text, truncated, storedPath? }`
    - `storeFullText(url, content): string | undefined`（best-effort，2MB 上限）

- [ ] **C2** 单测 `__tests__/fetch-content.test.ts`：
  - mock `fetch` 返回 HTML fixture（用 `writeFixture` 或内联字符串）
  - 测：readability 提取、markdown 输出、非 HTML 透传、HTTP 404 throw、
    SSRF 拒绝、非 http/https throw、截断+footer+存储、base64 替换、
    char_limit 边界、format=text

- [ ] **C3** 注册：`src/tools/index.ts` 加 `.add("fetch_content", (env) => createFetchContentTool(env))`

### Phase D: settings + 文档

- [ ] **D1** `src/settings.ts`：`NoviSettings` 加 `webSearch?: { provider?: string }`
  - `resolveSettings` 透传（无需特殊逻辑，浅合并即可）
  - 单测：测 settings 含 webSearch.provider 时 resolveProvider 用它

- [ ] **D2** `ARCHITECTURE.md` 更新：
  - 技术栈表加 `@mozilla/readability` / `linkedom`
  - 工具集列表加 web_search / fetch_content
  - 持久化表加 `~/.novi/cache/web/`
  - 依赖方向说明 web-search/ 子目录只依赖 ExecutionEnv + node stdlib + readability/linkedom

- [ ] **D3** spec 更新（Phase 3.3 spec-update 时定稿，此处先记候选）：
  - `directory-structure.md` 加 `web-search/` 子目录说明
  - 若产生新模式（provider 抽象、SSRF 检查）记录到 `error-handling.md` 或新建文件

### Phase E: 验证

- [ ] **E1** `npm run typecheck`
- [ ] **E2** `npm run lint`
- [ ] **E3** `npm run test`（所有新旧测试）
- [ ] **E4** `npm run build`（tsc 无错）

## Validation Commands

```bash
npm run typecheck && npm run lint && npm run test && npm run build
```

## Risky Points / Rollback

| 风险 | 缓解 |
|------|------|
| Readability + linkedom 兼容性（PR #677 提到的 live collection 问题） | Readability 0.6.0 已合并该 fix；若仍报错，fallback 用 `document.body.textContent` |
| DuckDuckGo HTML 结构变化 | 解析容错：找不到 `.result__a` 时返回空结果而非抛错 |
| `~/.novi/cache/web/` 写入权限 | storeFullText try/catch，失败不阻塞，footer 改提示 |
| fetch 在测试中发真实请求 | 全程 `vi.spyOn(globalThis, "fetch")` mock，零网络 |
| linkedom 的 `document` 类型与 Readability 期望的 `Document` 不完全匹配 | `new Readability(document as unknown as Document)`（jeeves 同款 cast） |

## Review Gates

- Phase B 完成后：跑 `npm run typecheck && npm run test` 确认 web_search 绿
- Phase C 完成后：同上确认 fetch_content 绿
- Phase E：全量四件套绿后才算完成