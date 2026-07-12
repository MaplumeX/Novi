# 修复 fetch_content 截断存储回归

## Goal

修复全量测试中 fetch_content 截断内容未保存的回归

## Requirements

- 将 `fetch_content` 截断内容存储测试的 Novi 缓存目录隔离到临时目录，不能依赖或写入开发者真实的 `~/.novi`。
- 保持生产环境的缓存路径、截断策略、错误降级和工具 API 不变。
- 修复后的测试必须验证 `storedPath` 非空、文件实际存在，并继续验证返回 footer 指向该路径。

## Acceptance Criteria

- [ ] `src/tools/__tests__/fetch-content.test.ts` 的截断存储用例在隔离临时目录中稳定通过。
- [ ] 全量 `npm test` 通过。
- [ ] `npm run typecheck`、`npm run lint` 与 `npm run build` 通过。
- [ ] 仅修改该测试及其必要的测试隔离支撑；不改变 `fetch_content` 运行时行为。

## Notes

- 这是轻量测试修复任务，PRD 足够；不需要设计文档或实施计划。
