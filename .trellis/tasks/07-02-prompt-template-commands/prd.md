# D: prompt templates as commands

## Goal

把已加载的 prompt templates 作为 `/<name>` 命令展开：输入 `/<templateName> [args]` → 参数替换（`$1`/`$@`/`${1:-default}`）→ 作为 prompt 发给 harness。加 `/templates` 列表命令。

**依赖关系**：无前置依赖（独立）。prompt templates 已由 `loadResources` 加载到 `harness.getResources().promptTemplates`，pi-agent-core 已导出 `formatPromptTemplateInvocation` + `parseCommandArgs` + `substituteArgs` + `harness.promptFromTemplate(name, args)`。

## Background — 已确认事实

### pi-agent-core 已提供
- `loadPromptTemplates(env, paths)` → `PromptTemplate[]`（Novi 已用）。
- `PromptTemplate`：`{ name, description?, content }`。
- `formatPromptTemplateInvocation(template, args?)`：参数替换后的完整 prompt 字符串。
- `parseCommandArgs(argsString)`：shell 风格解析参数。
- `substituteArgs(content, args)`：`$1`/`$@`/`$ARGUMENTS`/`${@:N}`/`${@:N:L}`/`${1:-default}` 替换。
- `harness.promptFromTemplate(name, args?)`：直接调 harness 用模板发 prompt。

### 当前 commands.ts
- `runCommand`：查 `COMMANDS` 数组，未命中 → `Unknown command`。本 child 在未命中后加 prompt-template fallback。

## Requirements

### R1 `/<templateName>` 展开
- 输入 `/<name> [args]`，若 `/<name>` 不在内建命令里，查 `harness.getResources().promptTemplates` 是否有同名 template。
- 有 → `parseCommandArgs(args)` → `harness.promptFromTemplate(name, args)`（或 `formatPromptTemplateInvocation` + `harness.prompt`）。
- 无 → 现有 `Unknown command` 提示。
- 需 idle（promptFromTemplate 是结构性操作）。

### R2 `/templates` 列表
- 列出所有已加载 template：name + description（若有）。
- 格式：`  <name> — <description>`。

### R3 args 传递
- `/<name> foo bar` → args = ["foo", "bar"]。
- `/<name> "multi word"` → args = ["multi word"]（shell 风格引号，parseCommandArgs 处理）。
- 替换后若有 `$1` → "foo"、`$@` → "foo bar"。

## Acceptance Criteria

- [ ] `/<templateName> args` 展开模板 + 参数替换，作为 prompt 发出。
- [ ] 内建命令优先（`/help` 不被 template 同名覆盖）。
- [ ] `/templates` 列出所有已加载 template 的 name + description。
- [ ] 无参数 `/<templateName>` 正常展开（无 `$1` 占位符或用默认值）。
- [ ] `tsc --noEmit` + `eslint` + `vitest` 全绿。

## Out of Scope

- template 的 autocomplete（输入 `/` 时列出 template，后置）。
- frontmatter 的 `argument-hint` 在 autocomplete 显示（后置，依赖 autocomplete）。

## Technical Notes

- 详细设计见 child 5 的 `design.md`（若有必要；本 child 很轻，可能 prd + implement 足够）。
- 本 child 的 `implement.md` 给出文件改动清单 + 验证命令。
