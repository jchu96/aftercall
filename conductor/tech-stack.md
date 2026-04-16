# Tech Stack

## Runtime

| Layer | Tech |
|-------|------|
| Platform | Cloudflare Workers (workerd) |
| Language | TypeScript 5.7 (ESM) |
| Web framework | Hono 4.12 |
| Validation | Zod 4 |

## Storage

| Layer | Tech | Role |
|-------|------|------|
| Source of truth | Cloudflare D1 (SQLite) + Drizzle 0.45 | `transcripts` table, idempotent on `video_id` |
| Semantic search | Cloudflare Vectorize | 1536d cosine, chunk embeddings |
| OAuth state | Cloudflare KV | `OAUTH_KV` binding, state/tokens |
| Derived view | Notion API (direct `fetch`, **not** `@notionhq/client`) | Followups DB (triage), Transcripts DB (metadata hub) |

## AI

| Layer | Tech |
|-------|------|
| Extraction | OpenAI `gpt-5-mini` (structured outputs, `response_format: json_schema`) |
| Embeddings | OpenAI `text-embedding-3-small` |

## MCP

| Layer | Tech |
|-------|------|
| Server | `@modelcontextprotocol/sdk` 1.29, Streamable HTTP, stateless mode |
| Auth | `@cloudflare/workers-oauth-provider` 0.4 + GitHub OAuth |

## Observability

| Layer | Tech |
|-------|------|
| Error tracking + tracing | `@sentry/cloudflare` 10.48 (optional — no-op when `SENTRY_DSN` unset) |
| Source maps upload | `@sentry/cli` 2.58 via `scripts/deploy.mjs` wrapper |

## External

| Source | Role |
|--------|------|
| Bluedot | Webhook source (Svix-signed), records the meetings |
| GitHub | OAuth IdP for MCP access (username allowlist via `ALLOWED_USERS`) |
| Claude.ai | MCP client (the primary query surface) |

## Dev

| Layer | Tech |
|-------|------|
| Test runner | Vitest 2.1 via `@cloudflare/vitest-pool-workers` |
| D1 in tests | Real SQLite via miniflare (never mocked) |
| Vectorize in tests | Mocked (no miniflare support yet) |
| Deploy | Wrangler 4.82 |
| Migrations | `drizzle-kit generate --name <description>` + `wrangler d1 migrations apply --remote` |

## Why these choices

- **Cloudflare Workers + D1 + Vectorize + KV all in one stack** — one platform, one deploy, one bill. Aligns with forkability.
- **OpenAI only** — single provider, simpler setup story, best-in-class structured outputs.
- **Direct `fetch` for Notion** — `@notionhq/client` fails in workerd (`Cannot read properties of undefined (reading 'call')`).
- **Stateless MCP transport** — CF Workers are isolate-per-request; stateful mode would need KV/DO session persistence for no real benefit.
- **No ORM migrations at runtime** — Drizzle generates SQL, `wrangler d1 migrations apply` runs them. D1 schema is controlled via committed SQL files in `drizzle/`.

## Compatibility flags (required)

| Flag | Why |
|------|-----|
| `nodejs_compat` | Bluedot's Svix package needs Node APIs |
| `global_fetch_strictly_public` | Required by `@cloudflare/workers-oauth-provider`; also protects against SSRF |
