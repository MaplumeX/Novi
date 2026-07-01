# Type Safety

> TypeScript conventions and type organization in Novi.

---

## Overview

Novi runs under `strict: true` with `target: ES2023` / `module: Node16`. The
codebase leans heavily on types from `@earendil-works/pi-agent-core` and
`@earendil-works/pi-ai` rather than hand-rolling domain types. Tool parameter
schemas use **typebox** to match the `AgentTool` contract.

Run `npm run typecheck` (`tsc --noEmit`) — it must pass with zero errors.

---

## Type Import Convention

Always separate value and type imports:

```ts
import { NodeExecutionEnv, AgentHarness, JsonlSessionRepo, uuidv7 } from "@earendil-works/pi-agent-core/node";
import type {
  JsonlSessionMetadata,
  Session,
  ExecutionEnv,
} from "@earendil-works/pi-agent-core/node";
```

`import type { … }` is required for type-only imports (erased at runtime, no
`.js` resolution issues under Node16).

---

## Tool Parameter Schemas (typebox)

Every tool defines its parameter schema with typebox, imported as `* as Type`:

```ts
import * as Type from "typebox";

const Parameters = Type.Object({
  path: Type.String(),
  offset: Type.Optional(Type.Number()),
  limit: Type.Optional(Type.Number()),
});

export function createReadFileTool(env: ExecutionEnv): AgentTool<typeof Parameters> { … }
```

- The tool function's generic parameter is `typeof Parameters` so `execute`
  receives typed `params`.
- Do not use zod, joi, or hand-written JSON schemas — typebox is the
  established convention.

---

## Result / Discriminated Unions

`ExecutionEnv` methods return `Result<T, Error>` discriminated by `ok`:

```ts
result: { ok: true; value: T } | { ok: false; error: Error }
```

Narrow with `result.ok` before accessing `.value` / `.error`, or use the shared
`unwrap` helper (which throws on failure).

Harness events come as a discriminated union on `event.type`. Always switch on
`type` and narrow inside each case:

```ts
switch (event.type) {
  case "message_update": {
    const ame = event.assistantMessageEvent;
    if (ame.type === "text_delta") { … }
    break;
  }
}
```

---

## Type Organization

- **Public types** exported from the module that owns them
  (`BootstrapOptions`, `BootstrapResult` in `bootstrap.ts`;
  `LoadedResources` in `resources.ts`).
- **Component props** declared as `interface XxxProps` in the same file.
- **State shapes** (`HarnessState`, `Phase`, `ToolCallView`, `QueueState`)
  live alongside the hook that produces them (`useHarnessState.ts`).
- Shared types coming from dependencies are re-imported where needed; there
  is no central `types/` directory. Do not create one without an explicit task.

---

## Forbidden Patterns

- No `any` without an eslint-disable and a justifying comment.
- No `as unknown as Type` except in test mocks where a partial mock is
  acceptable (e.g. `harness: { compact } as unknown as AgentHarness`).
- No non-null assertion (`!`) on values that can legitimately be `undefined` —
  narrow with a guard. (Existing `skill!.description` in tests is tolerated
  only because the preceding `expect(skill).toBeDefined()` guards it.)
- Do not use `import { Type }` (default import) — use `import * as Type`
  to match the codebase.
- Do not omit the `.js` extension on relative imports (Node16 resolution).
