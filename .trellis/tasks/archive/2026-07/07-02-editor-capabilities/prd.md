# C1: editor capabilities (@file / ! !! / Ctrl+G / multiline / Tab)

## Goal

升级 `InputBox` 从「纯字符串拼接、单行编辑、无光标」到真正的编辑器：引入光标位置模型、多行编辑（cursor 移动 + wordwise delete）、`@file` 引用（fuzzy 列表 overlay）、`!`/`!!` shell bang、外部编辑器（Ctrl+G）、Tab 路径补全。复用 child 1 的 overlay 抽象（filePicker 变体）。

**依赖关系**：本 child 依赖 child 1（config-personalization）已产出的 overlay 抽象。`@file` fuzzy 列表用 `{ kind: "filePicker" }` overlay。后续 child 3（message-queue-ux）依赖本 child 升级后的 InputBox。

## Background — 已确认事实

### 当前 InputBox（src/tui/InputBox.tsx）
- `useState<string>` 持输入，无光标位置概念。
- `useInput` 累积 printable chars；`key.return` → submit（Shift+Enter 换行）；`key.backspace` 删末字符。
- 无 cursor 左右移动、无 wordwise delete、无 Home/End、无外部编辑器、无文件引用、无 shell bang、无路径补全。

### overlay 抽象（child 1 已实现）
- `App.tsx` 持 `Overlay = null | { kind: "settings" }`。
- overlay 非空时 InputBox 不挂载。
- 本 child 扩展 Overlay union：`| { kind: "filePicker"; query: string; cursor: number }`。

### pi 参考
- `@` fuzzy 搜文件（项目内）→ 选回插入 `@path`。
- `!command` 跑 bash，输出发给 model；`!!command` 跑但不发输出。
- Ctrl+G 开外部编辑器（`$VISUAL` → `$EDITOR` → Windows Notepad / 其他 `nano`），拿回多行文本。
- Tab 路径补全（在 `@` 后或独立路径输入时）。
- Emacs-like 键位：Ctrl+A/E 行首尾、Ctrl+W 删词、Ctrl+U/K 删到行首/尾、Ctrl+B/F 左右、Alt+B/F 词级移动。

### 技术约束
- Ink 的 `useInput` 只给 `value`（单字符或 paste）+ `key`（方向/退格/return/ctrl 标记）。终端不区分 Shift+Enter 与 Enter（部分终端可，见现有代码 fallback）。
- 外部编辑器：spawn 子进程（`$VISUAL`/`$EDITOR`/`nano`），写 tmp 文件 → 等子进程退出 → 读回 → 塞进输入。Ink 需在子进程运行时暂停 raw mode（`process.stdin.setRawMode(false)`）+ 退出时恢复。

## Requirements

### R1 光标位置模型
- InputBox 内部从 `useState<string>` 升级为 `useState<{ text: string; cursor: number }>`（cursor = 字符 offset）。
- 渲染：在 cursor 位置画 `▏` 光标符。
- 左/右方向键、Home/End、Backspace/Delete 按 cursor 位置操作（而非固定末尾）。

### R2 多行编辑完善
- Shift+Enter / Ctrl+J 换行（插入 `\n`）。
- 上/下方向键在多行间移动 cursor（保持在列位置尽量稳定）。
- Ctrl+A/Home 行首；Ctrl+E/End 行尾。
- Ctrl+W / Alt+Backspace 删光标前一个词；Alt+D 删光标后一个词。
- Ctrl+U 删到行首；Ctrl+K 删到行尾。
- Ctrl+B 左移一字符；Ctrl+F 右移一字符；Alt+B 词级左移；Alt+F 词级右移。

### R3 `@file` 引用
- 输入 `@` 触发 filePicker overlay：显示匹配 query 的项目文件 fuzzy 列表。
- query = `@` 后到 cursor 的 token；`↑`/`↓` 选；`Enter` 插入 `@<path>` 到输入并关闭 overlay；`Esc` 取消（保留 `@`）。
- 文件扫描复用 `glob` 工具能力（项目内 `**/*`，去重，忽略 node_modules / .git）。
- 列表大小限制（如 10 条）避免渲染溢出。

### R4 `!` / `!!` shell bang
- 输入 `!command` + Enter：执行 bash 命令，stdout 发给 model（作为 prompt 附加上下文）。`!!command`：执行但输出不发给 model（仅本地副作用）。
- 实现路径：submit 时检测前缀 `!`/`!!` → 调 `env.exec` → 拿 stdout → 构造 prompt（对 `!`：`<command output>\n\n<原输入除 bang>` 或独立发一条带输出上下文的消息）。
- 与 onPrompt 的关系：`!` 的输出需注入到 LLM context——最简方式是把输出拼成一条 user prompt 发出（`harness.prompt`），`!!` 只执行不 prompt。

### R5 外部编辑器 Ctrl+G
- `Ctrl+G`：写当前输入到 tmp 文件 → spawn `externalEditor`（settings 未来可配，本轮从 `$VISUAL` → `$EDITOR` → 平台默认取）→ 等退出 → 读回 → 替换输入。
- 期间 Ink 暂停 raw mode，子进程退出后恢复。
- 失败（无编辑器 / spawn 失败）：notice 提示，不破坏当前输入。

### R6 Tab 路径补全
- 在 `@` token 或独立路径输入时，`Tab` 补全到最长公共前缀。
- 若唯一匹配：插入完整路径；若多匹配：不展开但可触发 filePicker overlay 显示候选（复用 R3）。

## Acceptance Criteria

- [ ] 左/右方向键移动光标，Backspace/Delete 在光标位置删字符（非末尾）。
- [ ] Home/Ctrl+A 行首，End/Ctrl+E 行尾。
- [ ] Ctrl+W 删光标前一个词，Alt+D 删光标后一个词，Ctrl+U/K 删到行首/尾。
- [ ] Alt+B/F 词级移动，Ctrl+B/F 字符级移动。
- [ ] Shift+Enter 换行，上/下方向键在多行间移动 cursor。
- [ ] 输入 `@` 后打字弹出 filePicker overlay 显示匹配文件；↑↓ 选择；Enter 插入 `@path`；Esc 取消。
- [ ] `!ls` + Enter 执行 ls 并把输出发给 model；`!!ls` 执行但不发输出。
- [ ] Ctrl+G 打开外部编辑器，编辑后内容替换输入。
- [ ] Tab 在路径输入时补全到最长公共前缀；多匹配时展开公共前缀。
- [ ] overlay（settings / filePicker）非空时 InputBox 不处理输入（无重复按键）。
- [ ] `tsc --noEmit` + `eslint` + `vitest` 全绿。

## Out of Scope

- 消息队列 UX（steer/followUp 快捷键、Escape restore、Alt+Up）—— child 3。
- 可扩展命令注册器 / keybindings 定制文件 —— 后置。
- 图片粘贴（Ctrl+V）—— 后置。
- 杀环（kill ring / yank）—— 后置。

## Technical Notes

- 详细设计见 child 2 的 `design.md`：cursor 状态机、filePicker overlay 渲染、bang 解析、外部编辑器 spawn 流程、Tab 补全算法。
- 本 child 的 `implement.md` 给出文件改动清单 + 验证命令。
- 复用 child 1 的 overlay 抽象（App.tsx 渲染分支 + Esc 退出 + overlay 接管输入）。
