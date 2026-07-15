# Skill Lifecycle Management — Technical Design

## 1. 架构边界

新增一个独立模块 `src/skills-hub/`（非 TUI、非 tools），承载生命周期逻辑。
TUI 通过 `commands.ts` 注入调用，不把 HTTP/git 逻辑混进命令文件。

```
src/skills-hub/
├── types.ts           # SourceRef / SkillInstall / SkillEntry / ScanVerdict 类型
├── source-parser.ts   # ref → ParsedSource（skills-sh / git / well-known / url / local）
├── registry-client.ts # skills.sh API 客户端（search + audit）
├── installer.ts       # 各来源 fetch → 写入 ~/.novi/skills/<name>/ + path 安全校验
├── provenance.ts      # lock.json 读写（CRUD + hash 比对 drift 检测）
├── scanner.ts         # skills.sh audit verdict 读取与分级映射
├── compat.ts          # platforms / requires 兼容性校验
└── skills-hub.ts      # 对外门面：search/install/update/uninstall/list，供 commands.ts 调用
```

`commands.ts` 仅做命令解析与 UI 反馈；所有副作用（网络、文件、lock）在 `skills-hub/`。

### 1.1 不改动现有加载路径

`resources.ts` 的 `resolveSkillSources` / `loadResources` **不改动**。
install 落到 `~/.novi/skills/<name>/`，该路径已是 user 层加载源（D4），`loadSourcedSkills` 自动发现。
provenance 清单 `~/.novi/skills/.hub/lock.json` 以 `.` 开头，被 `loadSourcedSkills` 跳过（loader 只认含 `SKILL.md` 的目录）。

## 2. 数据契约

### 2.1 ParsedSource

```ts
type ParsedSource =
  | { type: "skills-sh"; owner: string; repo: string; skillPath?: string; source: string } // owner/repo/skills/name
  | { type: "git"; owner: string; repo: string; ref?: string; skillPath?: string; source: string } // git:owner/repo@ref
  | { type: "well-known"; url: string; source: string } // well-known:https://site/docs
  | { type: "url"; url: string; source: string } // https://.../SKILL.md
  | { type: "local"; path: string; as?: string; source: string }; // ./path --as name
```

解析优先级（按前缀/形态）：`well-known:` / `git:` / `http(s)://` 含 `/SKILL.md` → url；`http(s)://` 其他 → skills-sh owner/repo 解析；`./` 或绝对路径 → local；纯 `owner/repo[/skills/name]` → skills-sh。

### 2.2 SkillEntry（provenance lock.json）

```ts
interface SkillLockEntry {
  name: string;              // skill 名（frontmatter name 或目录名）
  source: string;            // 归一化标识 owner/repo 或 URL
  sourceType: "skills-sh" | "git" | "well-known" | "url" | "local";
  sourceUrl: string;         // 原始 URL（update 时重新拉取）
  ref?: string;              // git ref
  skillPath?: string;        // 仓库内子路径
  version?: string;          // frontmatter version
  contentHash: string;       // sha256(SKILL.md) 或 folder hash
  installedAt: string;       // ISO 时间戳
  updatedAt: string;         // ISO 时间戳
  scan?: ScanRecord | null;  // skills.sh 审计结论（仅 skills.sh 来源）
  platforms?: string[];      // frontmatter platforms
  requires?: { bins?: string[]; env?: string[] }; // 兼容性约束
}

interface SkillLockFile {
  version: number;           // 1
  skills: Record<string, SkillLockEntry>;
}
```

文件路径：`~/.novi/skills/.hub/lock.json`。读写原子化（写临时文件 + rename）。版本不兼容则清空重建（同 skills.sh 的 CURRENT_VERSION 策略）。

### 2.3 ScanRecord（skills.sh audit 映射）

```ts
interface ScanRecord {
  scanner: "skills-sh";      // 扫描来源标识（scanner version 字段）
  scannedAt: string;         // analyzedAt
  verdicts: {
    ath?: { risk: Risk; analyzedAt: string };
    socket?: { risk: Risk; alerts?: number; analyzedAt: string };
    snyk?: { risk: Risk; analyzedAt: string };
  };
}

type Risk = "safe" | "low" | "medium" | "high" | "critical" | "unknown";
```

分级映射（D2 + AC7）：
- `critical` / `high` → **dangerous** → 阻断安装
- `medium` → warn → 可 `--force` 覆盖
- `low` / `safe` → 通过
- 无 scan 数据（git/well-known/url 来源）→ 不阻断，仅信任提示（AC8），明确告知「无安全扫描覆盖」

## 3. 数据流

### 3.1 search

```
/skills search <query>
  → registry-client.searchSkills(query)
  → GET https://skills.sh/api/search?q=<query>&limit=10
  → [{id, name, source, installs}]
  → TUI 打印表格（name | source | installs）
```

无网络/失败 → 空列表 + 提示「搜索失败，检查网络」。不阻断。

### 3.2 install

```
/skills install <ref> [--force]
  → source-parser.parseSource(ref)
  → installer.fetchSkill(parsed) → 临时目录下载（git clone / HTTP fetch）
  → 解析 SKILL.md frontmatter（name/version/platforms/requires）
  → compat.check(platforms, requires) → 不兼容则阻断
  → 若 skills-sh 来源：scanner.fetchVerdict(source, slug)
       → GET https://add-skill.vercel.sh/audit?source=...&skills=...
       → 映射 dangerous/warn/pass
       → dangerous → 阻断（不可 --force）
       → warn 且无 --force → 提示，等待用户重跑加 --force
  → 若 git/well-known/url/local 来源：无 scan，展示信任提示（来源 + "无安全扫描覆盖"）
  → 用户确认（AC8，非内置/官方源首次确认）—— TUI 内 ctx.print + 等待输入 y/n
  → installer.installToSkillsDir(临时目录, ~/.novi/skills/<name>/)
       → path 安全校验（sanitizeName + isPathSafe，防 traversal）
       → 已存在同名 → 提示覆盖确认
  → provenance.addEntry(lockEntry) → 写 lock.json
  → ctx.print 成功 + 触发 reload 提示
```

### 3.3 update

```
/skills update [name]
  → provenance.read()
  → for each entry (或指定 name):
       → installer.fetchSkill(parsedFromEntry) → 临时目录
       → computeHash → 与 entry.contentHash 比对
       → 一致 → skip（up-to-date）
       → 不一致 → 重新走 install 流程（兼容性 + scan + 信任提示）
            → 更新 lock entry（contentHash, updatedAt, scan）
  → 打印 update 摘要
```

仅追踪 lock.json 中的 install（手动放的本地 skill 不在 lock.json 不更新）。

### 3.4 uninstall

```
/skills uninstall <name>
  → provenance.get(name) → 不在 lock → 提示「非 hub 安装，无法 uninstall」
  → 删除 ~/.novi/skills/<name>/ 目录（rm -rf，仅限该 skill 目录）
  → provenance.removeEntry(name)
  → ctx.print 成功
```

安全：删除前校验目标路径在 `~/.novi/skills/` 内且是 `.` 开头过滤后的目录，防误删。

### 3.5 list

```
/skills list
  → provenance.read() → 打印表格（name | source | version | installedAt | scan verdict）
  → 不在 lock 的本地 skill 不展示（它们由 /skill:<name> 调用面覆盖）
```

## 4. 与现有系统的兼容性

### 4.1 trust 门控

install 目标是 user 层 `~/.novi/skills`（D4），**不受 project trust 门控**（user 层从 trust-gated）。这与现有设计一致：`resolveSkillSources` 中 user 层不门控。
install 命令本身在 TUI 运行，不涉及 project trust 决策。

### 4.2 加载不回归

- install 后 skill 出现在 `~/.novi/skills`，`loadSourcedSkills` 自动发现（AC10）
- `/skill:<name>` 调用面不变
- `lock.json` 以 `.` 开头目录 `.hub`，loader 跳过
- `/skills <action>` 复数命令与 `/skill:<name>` 单数调用在 `parseCommand` 层区分：name === "skills" 路由到 `runSkillsCommand`；name.startsWith("skill:") 路由到 `parseSkillCommand`

### 4.3 兼容性校验（AC6）

`compat.ts` 校验 frontmatter：
- `platforms: ["macos","linux"]` → 当前 `process.platform` 不在列 → 不加载 + 提示
- `requires.bins: ["uv"]` → `which uv` 检查；`requires.env: ["API_KEY"]` → `process.env` 检查
- 不兼容时 install 阻断或 warn（由用户决定是否仍装）

注：pi-agent-core 的 `loadSourcedSkills` 已解析部分 frontmatter（`disableModelInvocation`）。本任务的 compat 校验在 install 时做（pre-install gate），不依赖 core loader。

## 5. 安全考量

### 5.1 路径安全

- `sanitizeName`：name 仅允许 `[a-z0-9._-]`，防 `../` traversal（同 skills.sh）
- `isPathSafe(base, target)`：install/delete 目标必须在 `~/.novi/skills` 内
- local 来源：resolved realpath 必须存在，不接受 `..` 越界

### 5.2 扫描门控

- skills.sh 来源：dangerous（critical/high）硬阻断，warn（medium）可 `--force`
- 其他来源：无 scan，install 前强制信任提示（来源 + 「无安全扫描覆盖」+ 需 y/n 确认）
- 扫描失败（网络/超时）：降级为「扫描不可用」+ 信任提示，不阻断（同 skills.sh `fetchAuditData` 返回 null 时不 block）

### 5.3 网络

- 所有 HTTP 经现有 `src/tools/web/network.ts` 的 DNS-pinned fetch（复用 SSRF 防护）
- 超时 3s（audit）、10s（SKILL.md 下载）；git clone 用 child_process `git`
- 无认证需求（skills.sh API 公开）

## 6. tradeoffs

| 决策 | 取舍 |
|---|---|
| 仅 TUI 入口（D5） | 放弃脚本化 CLI；后续增量加 `novi skills` 子命令 |
| 仅 skills.sh 扫描（D2） | git/well-known/url 无安全覆盖；接受，后续本地启发式补齐 |
| install 到 user 层（D4） | 不隔离 managed vs 手动；同名覆盖按现有 `loadSourcedSkills` 后写覆盖规则；若用户手动放了同名 skill，install 前提示覆盖 |
| lock.json 集中清单 | 不分层；项目层 install 留后续。单一文件简单，原子写足够 |

## 7. 回滚

- install 失败中途：删除已创建的 `~/.novi/skills/<name>/`，不写 lock
- lock.json 写失败：保留旧 lock，打印错误
- 整体回滚：删除 `src/skills-hub/` + 还原 `commands.ts` 的 `/skills` 路由 + 还原 COMMANDS 列表，无 DB migration 需回滚（lock.json 可直接删）