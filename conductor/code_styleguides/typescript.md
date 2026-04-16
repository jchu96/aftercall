# TypeScript Style Guide

Derived from existing code in `src/`. No ESLint/Prettier runtime — `tsc --noEmit` + self-review enforce this.

## Baseline

- **ESM only** (`"type": "module"` in package.json, `moduleResolution: "bundler"`)
- **Strict TypeScript** (`"strict": true` in tsconfig) — no `any`, no implicit `any`
- **Target:** ES2022
- **Runtime:** Cloudflare Workers (workerd) — no Node-only APIs outside scripts, unless guarded by `nodejs_compat`

## Naming

| Kind | Convention | Example |
|------|-----------|---------|
| Variables / functions | `camelCase` | `buildFollowupRowBody` |
| Types / interfaces | `PascalCase` | `NotionDeps`, `ExtractedFromSummary` |
| Constants | `SCREAMING_SNAKE_CASE` for module-level invariants | `DEFAULT_MODEL`, `RICH_TEXT_MAX` |
| Files | `kebab-case.ts` for implementation; `kebab-case.test.ts` for tests | `webhook-verify.ts` |
| MCP tools | one file per tool, named after the tool | `search_calls.ts`, `get_call.ts` |

## Functions

- **Prefer pure functions** — accept inputs explicitly, return values explicitly, no module-level mutable state
- **Dependency injection over module imports** for anything that touches the outside world. MCP tools take `(args, env, deps?)` so tests can inject mocks.
- **Early return** over nested `if/else`:

  ```ts
  if (!input.query) return errorResponse("missing query");
  if (!user.isAllowed) return errorResponse("forbidden");
  // happy path
  ```

- **Async all the way** — never wrap sync code in `new Promise(...)`; never block an async handler with sync I/O

## Types

- **Interfaces for object shapes**, `type` for unions / utility types
- **Avoid `any`** — use `unknown` if the shape is truly unknown, then narrow with type guards
- **Zod for runtime validation** at system boundaries (webhooks, MCP tool args)
- **Drizzle for DB types** — let `drizzle-kit` generate them; don't hand-maintain row interfaces

## Imports

- Group by origin: external packages → internal modules → types
- Use `import type { … }` for type-only imports (helps Workers tree-shaking)
- **No `@modelcontextprotocol/sdk` imports outside `src/mcp/handler.ts`** — its transitive `ajv` dep breaks the vitest-pool-workers ESM shim. Dynamic-import it.

## Error handling

- **Throw typed errors** at boundaries (`WebhookVerificationError`, `NotionApiError`)
- **Catch narrowly** — `catch (err) { if (err instanceof X) ... }`, never swallow
- **Pipeline failures return 500** so Svix retries (handler-level only — internal helpers throw)
- **Log before throwing** in handlers — the worker tail needs the context

## Testing

- **Vitest via `@cloudflare/vitest-pool-workers`** — tests run in real workerd with miniflare D1
- **Test the tool function, not the SDK wrapper** — MCP tools are pure `(args, env, deps?)` → `{ content: [...] }`. Call them directly.
- **Real D1, mocked Vectorize** — always. Never mock D1.
- **TDD strict** — failing test first. If you write code before a test, delete it and restart.

## Comments

Default to no comments. Write a one-line `//` comment only when:

- The *why* is non-obvious (a hidden constraint, a workaround for a specific bug)
- There's a subtle invariant that would surprise a future reader

Don't write comments that restate what the code does. Don't leave "// added for feature X" breadcrumbs — those rot.

## File length

Keep modules under ~300 lines. If a file grows past that, extract a sub-module or helper file. `src/mcp/tools/` is the canonical pattern — one file per tool.
