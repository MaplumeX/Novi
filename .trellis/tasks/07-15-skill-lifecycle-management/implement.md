# Skill Lifecycle Management — Implementation Plan

## 执行顺序（有序 checklist）

### Phase A: 基础类型与解析层
- [ ] A1 `src/skills-hub/types.ts`：ParsedSource / SkillLockEntry / SkillLockFile / ScanRecord / Risk 类型
- [ ] A2 `src/skills-hub/source-parser.ts`：parseSource(ref) → ParsedSource
  - 前缀识别：`well-known:` / `git:` / `http(s)://` / `./` / `owner/repo`
  - 纯函数，单测 `source-parser.test.ts`（各来源形态 + 边界 + traversal 拒绝）

### Phase B: provenance 与扫描
- [ ] B1 `src/skills-hub/provenance.ts`：read/write/add/remove/get lock.json
  - 原子写（临时文件 + rename）
  - 版本不兼容清空重建
  - 单测 `provenance.test.ts`（CRUD + 原子 + 版本迁移）
- [ ] B2 `src/skills-hub/registry-client.ts`：searchSkills(query) + fetchAudit(source, slugs)
  - `GET https://skills.sh/api/search` / `GET https://add-skill.vercel.sh/audit`
  - 走 web/network.ts 的安全 fetch；3s/10s 超时；失败返回 null 不抛
  - 单测 mock fetch

### Phase C: installer 与兼容性
- [ ] C1 `src/skills-hub/compat.ts`：checkCompat(platforms, requires) → {ok, reasons}
  - platforms vs process.platform；bins via which；env via process.env
  - 单测
- [ ] C2 `src/skills-hub/installer.ts`：
  - fetchSkill(parsed) → 临时目录（git clone / HTTP fetch SKILL.md + 引用文件）
  - installToSkillsDir(临时目录, name) → sanitizeName + isPathSafe + copy
  - computeHash（sha256）
  - deleteSkillDir(name) → 路径校验 + rm -rf
  - 单测 mock fs

### Phase D: 扫描分级与门面
- [ ] D1 `src/skills-hub/scanner.ts`：mapVerdict(auditData) → ScanRecord + 分级 dangerous/warn/pass
  - skills.sh 来源 → fetchAudit；其他来源 → null（无覆盖）
  - 单测
- [ ] D2 `src/skills-hub/skills-hub.ts`：门面 export search/install/update/uninstall/list
  - 组合 A-D 的函数，纯逻辑（不碰 ctx.print）
  - 返回结构化结果供 commands.ts 格式化
  - 单测集成

### Phase E: TUI 命令接入
- [ ] E1 `src/tui/commands.ts`：
  - COMMANDS 加 `skills` 项（name:"skills", description）
  - `runSkillsCommand(ctx, args)`：子命令分发 search/install/update/uninstall/list
  - parseCommand 路由：name === "skills" → runSkillsCommand（在 skill: 前缀检查之前，避免与 skill: 冲突——"skills" 无冒号前缀）
  - 信任提示 UI：ctx.print + 等待确认（复用现有输入机制或简化为提示重跑）
  - COMMAND_HINT 加 `/skills`
- [ ] E2 slash 补全：`/skills` 出现在补全列表
- [ ] E3 `commands.test.ts`：/skills 各子命令 + 路由 + 错误语义

### Phase F: 集成与回归
- [ ] F1 端到端单测：install skills-sh 来源 → lock.json 写入 → reload 后 /skill:name 可调用
- [ ] F2 回归：现有 `/skill:name`、loadResources、trust 门控单测全绿
- [ ] F3 `npm run typecheck` / `npm run lint` / `npm test` 通过

## 验证命令

```bash
npm test
npm run typecheck
npm run lint
```

## 风险点 / 回滚锚点

| 风险 | 回滚 |
|---|---|
| skills.sh API 变更/不可用 | search/audit 降级为空/null，不阻断核心；不影响本地 skill |
| git clone 在受限环境失败 | install 报清晰错误；不影响 TUI 其余功能 |
| lock.json 损坏 | 版本校验清空重建；不阻塞启动 |
| `/skills` 路由与未来命令冲突 | name === "skills" 精确匹配，不前缀匹配 |

## review gate

- E1 前提：A-D 单测全绿
- F3 前提：E1-E3 完成
- task.py archive 前：所有 AC 对照验证