# Skill lifecycle management (search/install/update/uninstall + provenance + security)

## Goal

让 Novi agent 具备第三方 Skill 的完整生命周期管理能力，对标 OpenClaw / Hermes：
搜索、安装、更新、卸载；记录来源、版本、兼容性、完整性；对第三方 Skill 做安全扫描与信任提示。
用户可在 TUI 内像管理 npm 包一样发现、安装、审查、移除第三方 skills，并在安装/加载前获得安全提示。

## Background

Novi 已有 skill 加载与调用面（07-09-skills-first-class）：
- 从 `~/.agents/skills`、`~/.novi/skills`、项目 `.agents/skills`（git root→cwd）、`<cwd>/.novi/skills` 加载
- 项目层 trust 门控（`/trust`），user 层不门控
- TUI `/skill:name [args]` 调用 + slash 补全
- `loadSourcedSkills`（来自 pi-agent-core）解析 SKILL.md frontmatter
- 加载失败非致命 diagnostics

**缺口（本任务范围）**：
1. 无 registry / 来源概念：只能手动放文件到 skills 目录
2. 无生命周期命令：无 search / install / update / uninstall
3. 无 provenance：不记录来源 URL、版本、content hash、安装时间
4. 无安全扫描 / 信任提示：第三方 skill 直接进入加载路径，无审查门
5. 无兼容性记录：不记录 skill 声明的平台/依赖/agent-core 版本约束

## Confirmed Facts (from research)

### OpenClaw (`openclaw skills`)
- `install @owner/<slug>`（ClawHub registry）/ `git:owner/repo@ref` / `./local --as name`；`--global` 装共享目录
- `update --all` / `update @owner/<slug> --global`（仅追踪 ClawHub installs）
- `verify @owner/<slug>` → ClawHub trust envelope（版本+registry 记录于 `.clawhub/origin.json`）
- Skill Workshop：agent 起草提案 → 人工 approve → 落盘
- 安全：realpath 约束防越界；`security.installPolicy` 可配本地策略命令（ClawHub/upload/git/local/update/dep 全路径）；ClawHub 页面暴露 VirusTotal/ClawScan/静态分析
- gating：`metadata.openclaw.requires.bins/env/config`、`platforms`
- provenance 文件：`.clawhub/origin.json`

### Hermes (`hermes skills`)
- 多来源 install：`official` / `skills-sh` / `well-known` / `github` / `clawhub` / `lobehub` / `browse-sh` / `url`
- `check`（检测 upstream 变更）/ `update` / `uninstall` / `audit`（重扫所有 hub skill 安全）
- provenance：`~/.hermes/skills/.hub/lock.json` 记录 source URL、content hash、scanner version、findings、timestamp、fresh-or-cached
- trust levels：`builtin` / `official` / `trusted` / `community`（不同来源不同策略）
- 安全扫描：data exfiltration / prompt injection / destructive commands / supply-chain signals；`--force` 覆盖 caution/warn，**不可**覆盖 `dangerous`
- `/skills` slash 命令在 TUI + gateway 内可用
- `tap add/remove/list`：自定义 GitHub tap 作为 registry 源
- bundled skill：`.bundled_manifest` 记录 origin hash，用户改动后 `reset` 回退

### 共同模式
- 单一 provenance 清单文件（origin.json / lock.json）记录 source + version + hash + 时间戳
- install 时强制安全扫描，dangerous 硬阻断，warn 可 `--force` 覆盖
- trust 分级：内置/官方/受信仓库/社区
- update 基于 provenance 重新拉取上游并比对 hash 检测 drift
- TUI slash 命令 + CLI 子命令双入口

## Requirements

- **R1 搜索**：可按关键词搜索 skills.sh marketplace 上的可安装 skills
- **R2 安装**：从来源安装 skill 到本地 skills 目录，生成 provenance 记录
- **R3 更新**：检测已安装 skill 的 upstream 变更并更新（基于 provenance + content hash 比对）
- **R4 卸载**：移除已安装 skill 及其 provenance 记录
- **R5 Provenance**：记录来源、版本、content hash、安装时间、scanner 版本/结果
- **R6 兼容性记录**：记录/校验 skill 声明的平台、依赖、agent-core 版本约束
- **R7 安全扫描**：install skills.sh 来源 skill 前读取其扫描结论并分级展示；git/well-known/url 来源无扫描覆盖，以信任提示门控（见 D2）
- **R8 信任提示**：首次加载/安装第三方 skill 时向用户提示来源与风险；dangerous 硬阻断
- **R9 TUI 入口**：通过 slash 命令操作生命周期（非仅 CLI）
- **R10 不破坏现有**：现有本地 skill 加载、`/skill:name` 调用、trust 门控不受影响

## Acceptance Criteria

- [ ] AC1: `/skills search <query>` 返回匹配的可用 skills 列表（名称、描述、来源、版本）
- [ ] AC2: `/skills install <ref>` 将 skill 装入本地目录并写入 provenance（来源、版本、hash、时间戳）
- [ ] AC3: `/skills update [name]` 基于 provenance 检测并更新有 upstream 变更的 skill
- [ ] AC4: `/skills uninstall <name>` 移除 skill 文件与 provenance 记录
- [ ] AC5: provenance 记录含来源、版本、content hash、安装时间、scanner 版本与结果
- [ ] AC6: skill 声明的 platforms / requires 与当前环境不兼容时给出明确提示，不加载
- [ ] AC7: install skills.sh 来源 skill 前读取其安全扫描结论；findings 分级展示；skills.sh 判定为 dangerous 的阻断安装；git/well-known/url 来源仅展示信任提示，无 scan 结论时明确告知无覆盖
- [ ] AC8: 首次安装/加载第三方 skill 时展示来源与信任提示，需用户确认（非内置/官方源）
- [ ] AC9: 生命周期命令在 TUI slash 中可用
- [ ] AC10: 现有 `/skill:name` 调用、本地加载、trust 门控行为不回归
- [ ] AC11: `npm test` / `npm run typecheck` / `npm run lint` 通过

## Decisions

| ID | 决策 |
|---|---|
| D1 | 来源范围 = C：git (`git:owner/repo@ref`) + 本地目录 (`./path --as name`) + well-known (`well-known:<url>`) + 直接 URL (`https://.../SKILL.md`) + skills.sh marketplace。不对接 ClawHub / lobehub / browse-sh（后续增量） |
| D2 | 安全扫描 = B：仅读取 skills.sh 的扫描结论（Snyk/静态分析 verdict）。**接受后果**：git / well-known / url 来源无扫描覆盖，这些来源的 skill 仅靠信任提示门控，不强制 dangerous 阻断（因无 scan 输入）。后续可用本地启发式扫描增量补齐（另开任务） |
| D3 | 命令命名空间 = A：`/skills <action> [args]` 复数组（search/install/update/uninstall/list）。现有 `/skill:<name> [args]` 单数调用保持不变。复数=管理，单数=调用，天然区分 |
| D4 | 安装目标 = `~/.novi/skills/<name>/`（现有 user 层加载源，无需改 `loadSourcedSkills`）；provenance 清单 = `~/.novi/skills/.hub/lock.json`（集中记录来源/version/hash/时间戳/scan 结论，Hermes 模式） |
| D5 | 入口范围 = A：仅 TUI `/skills <action>`。不新增 `novi skills` CLI 子命令（cli.ts 无子命令框架，脚本化需求后续增量） |

## Open Questions

（无阻塞问题，规划已收敛）

## Out of Scope

- agent 自动创建 skill（skill_manage 工具，Hermes 的 /learn）—— 另开任务
- skill bundle（Hermes）/ skill workshop 提案队列（OpenClaw）—— 另开任务
- publish / 发布 skill 到 registry —— 另开任务
- MCP —— 不在本任务
- `novi skills` CLI 子命令（脚本化入口）—— 另开任务
- gateway / headless 的生命周期入口 —— 另开任务
- 本地启发式安全扫描器（git/well-known/url 来源覆盖）—— 另开任务
- ClawHub / lobehub / browse-sh 来源对接 —— 另开任务