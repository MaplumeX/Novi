# TUI 统一重构实施计划

## 1. 建立视觉原语

- [ ] 重构 `src/tui/theme.ts`，补齐语义色、单列宽图标、间距和截断常量；迁移时保留单一来源约束。
- [ ] 新增共享的面板、选择行和按键提示展示原语，并以纯 props 驱动。
- [ ] 搜索所有 TUI 颜色、图标、divider 和选中标记，列出需要迁移的调用点，避免新旧视觉词汇并存。

验证：`npm run typecheck`，并针对视觉辅助纯函数运行定向测试。

## 2. 统一实时状态投影

- [ ] 扩展 `ToolCallView`，在 `useHarnessState` 边界规范化 start/update/end 的 args、部分结果、最终结果和错误状态。
- [ ] 保持 `useHarnessState` 为唯一 raw event 消费者；展示组件不得新增 event cast。
- [ ] 添加工具事件顺序、并行完成、错误和 turn 清理测试。

验证：定向运行 `useHarnessState` / MessageList 相关测试与 `npm run typecheck`。

## 3. 重构对话阅读区

- [ ] 新增 Thinking 展示组件与 preview/collapse 纯函数：进行中摘要、完成后单行记录、详细模式全文。
- [ ] 抽取工具语义展示模块，覆盖 read/write/edit/bash/ls/glob/grep/web/todo 等内置工具及未知工具 fallback。
- [ ] 重写 `ToolCallBlock` 为稳定的运行中/成功/失败骨架；默认 1–2 行，失败首条可见，详细模式显示完整内容。
- [ ] 重构 `MessageList`，通过 `toolCallId` 合并历史 toolCall、实时状态和最终 ToolResult，移除独立 streaming 工具行。
- [ ] 重构用户消息锚点、助手正文间距及流式反馈，确保流式到历史态不发生结构跳变或重复。
- [ ] 将 `toolExpanded` 重命名为 `detailMode`，保持 `Ctrl+O` 操作并同时控制 Thinking 与工具详情。

验证：扩展 `MessageList.test.ts` 和工具展示纯函数测试；手测普通/长 Thinking、成功/失败及连续/并行工具。

## 4. 重构输入与常驻底部

- [ ] 使用新的焦点视觉重构 `InputBox`，保持编辑、历史、slash、bang、附件、steer/follow-up 和 external editor 行为。
- [ ] 统一 slash completion 的选择行与帮助提示。
- [ ] 将 notice 放入一致的轻量消息区域；不改变 `print()` 及命令错误传播契约。
- [ ] 合并 `StatusBar`、session 与常驻快捷键提示，移除重复 divider 和重复 busy 状态。
- [ ] 检查 `Ctrl-C`、`Ctrl-O`、Shift-Tab 和 overlay 优先级未变化。

验证：运行 input、commands、queue、image-submit、App 相关现有测试并进行交互手测。

## 5. 统一临时面板与启动界面

- [ ] 迁移 `PermissionPrompt`，保持数字键、方向键、Enter、Esc deny 与 fail-closed 行为。
- [ ] 迁移 Session/Model/File picker，统一标题、选中行、空态和 footer hints。
- [ ] 迁移 `SettingsForm`，保留浏览、编辑、保存目标、reload 和凭据只读行为。
- [ ] 迁移 `TrustPrompt` 与 `OnboardingWizard`，复用同一视觉原语但保持独立 render 生命周期。
- [ ] 检查所有 overlay 打开时 `InputBox` 仍未挂载，权限提示仍高于普通 overlay。

验证：运行 permission、trust、onboarding、file-picker、settings 相关测试；逐一手测取消与确认路径。

## 6. 一致性与边界检查

- [ ] 搜索组件内硬编码颜色、Unicode 图标、重复快捷键格式和旧 theme key。
- [ ] 检查未知工具、空结果、仅图片消息、空 Thinking、超长单行、20+ 行结果、窄终端和 session resume。
- [ ] 检查历史态与 live 态对相同工具使用同一摘要函数和组件。
- [ ] 按最终实现更新必要的前端 spec；不把一次性视觉细节写成全局规范。

## 7. 质量门

- [ ] `npm run typecheck`
- [ ] `npm run lint`
- [ ] `npm run test`
- [ ] `npm run build`
- [ ] 真实 TUI 手测：普通消息、Thinking、工具成功/失败、权限确认、各 picker/settings/onboarding、详细模式、窄终端、恢复 session。

## 风险文件与回滚点

- `src/tui/useHarnessState.ts`：事件投影风险最高；可独立回退实时 view 扩展。
- `src/tui/MessageList.tsx` / `ToolCallBlock.tsx`：历史与实时合并风险；保留 `toolCallId` 测试作为回滚判断。
- `src/tui/App.tsx` / `InputBox.tsx`：键盘路由风险；视觉变化不得夹带命令语义修改。
- 共享面板原语：若抽象导致复杂度上升，可回退为共享 `SelectionRow` / `KeyHints` 两个最小原语，不回退已确定的信息层级。
