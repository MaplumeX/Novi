# Quality Guidelines

> Code standards and review bar for the Novi backend layer.

---

## Toolchain

- **Language**: TypeScript, `strict: true`, `target: ES2023`,
  `module: Node16` / `moduleResolution: Node16`.
- **Module system**: ESM (`"type": "module"`). All relative imports use the
  `.js` extension (Node16 resolution requires it):
  ```ts
  import { bootstrap } from "./bootstrap.js";   // ✅
  import { bootstrap } from "./bootstrap";       // ❌ will fail at runtime
  ```
- **Lint**: `eslint .` (flat config, `@eslint/js` + `typescript-eslint`
  recommended). `dist/`, `node_modules/`, `.pi/`, `.claude/`, `.trellis/` are
  ignored.
- **Format**: `prettier --write .` (semi on, double quotes, trailing comma
  all, print width 100, tab width 2).
- **Tests**: `vitest run`. Co-located `*.test.ts` files.
- **Typecheck**: `tsc --noEmit`.

Before finishing backend work, all four should pass:
`npm run typecheck && npm run lint && npm run test && npm run build`.

---

## Code Standards

### Imports

- Node built-ins first, then external packages, then local modules.
- Import **types** with `import type { … }`.
- Named imports preferred; default imports only for the entry file's consumer.

```ts
import * as Type from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core/node";
import type { ExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { resolveAbsolutePath, sliceLines, textResult, unwrap } from "./shared.js";
```

### Typebox for tool schemas

Tool parameter schemas use **typebox** (imported as `* as Type`), not zod or
hand-written JSON. This matches the `AgentTool` contract:

```ts
const Parameters = Type.Object({
  path: Type.String(),
  offset: Type.Optional(Type.Number()),
  limit: Type.Optional(Type.Number()),
});
```

### JSDoc

Public factory functions and non-obvious helpers carry a JSDoc block explaining
the contract / side effects / why-not-what. Comments explain *why*, code says
*what*. Example (`shared.ts`):

```ts
/**
 * Retry helper: unwrap a `Result`, throwing on failure with the env error.
 */
export function unwrap<T>( … ): T { … }
```

### Comments document reality

Inline comments capture non-obvious decisions (API quirks, ordering,
fallbacks). Example (`bootstrap.ts`):

```ts
// When --model is not given, prefer the documented stable default for the
// default provider; otherwise fall back to the first catalog entry.
```

---

## Testing Requirements

- Every new pure function or tool gets a co-located `*.test.ts`.
- Tool tests use the shared helpers in `tools/__tests__/helpers.ts`:
  `setupEnv()` (mkdtemp + `NodeExecutionEnv` + cleanup), `getTool(env, name)`,
  `writeFixture(dir, rel, content)`.
- Always clean up temp dirs / env in a `finally` block (see `bash.test.ts`).
- Test shared singleton state via `resetSharedState()` (e.g. todo store).
- Mock the harness with `vi.fn()` + `as unknown as AgentHarness` for
  component-level tests (see `compaction.test.ts`).
- Test error paths, not just happy paths (`bash.test.ts` verifies non-zero exit
  codes throw).

---

## Forbidden Patterns

- No `any` without an explicit eslint-disable and a reason comment.
- No direct stdout writes from backend modules (TUI owns stdout).
- No CommonJS (`require`/`module.exports`). ESM only.
- No importing from `@earendil-works/pi-agent-core` root entry for
  Node-only APIs — use `/node` subpath (see `pi-agent-core-api.md`).
- No reaching into `dist/` internals of dependencies. Only public exports.
- Do not leave `console.log` debugging in committed code.
