# Product Guidelines

## Voice and tone

**Friendly and approachable.** Conversational. Written for individuals and hobbyists forking a personal tool — not an enterprise buyer.

- Short sentences
- Plain English over jargon where possible (explain the jargon when you must use it)
- Italics for illustrative examples (_"What did I promise Pierce last week?"_)
- GFM tables for reference material
- Don't apologize for trade-offs — state them plainly
- No emoji spam; the occasional `❌` in a "Don't" table is fine

## Design principles

### 1. Forkability (primary)

Every decision should pass the "can a friend clone this and run it?" test.

- No secrets baked into code — ever
- Setup script (`npm run setup`) handles all provisioning (D1, Vectorize, KV, Notion DBs, OAuth)
- Observability (Sentry) is optional — guarded by `SENTRY_DSN` / `.sentryclirc` / `SENTRY_AUTH_TOKEN` checks
- `wrangler.toml` is gitignored; `wrangler.toml.example` is the committed template
- Conventions and gotchas documented in CLAUDE.md so Claude Code helps forkers, not just you
- No vendor lock that can't be swapped (exception: Cloudflare Workers itself — that's the whole point)

### 2. Simplicity over features (secondary)

Resist config proliferation. One opinion is better than a knob.

- One LLM provider (OpenAI). No Anthropic, no Mistral, no fallback chain.
- One Notion integration. One GitHub OAuth App.
- One transport mode for MCP (stateless Streamable HTTP). Don't add a second for "flexibility."
- If a feature requires a new env var, new service, or new setup question — weigh it hard.
- Prefer deleting code to adding a flag.

### 3. Idempotency (implicit, not negotiable)

All writes must survive replay.

- D1 has `UNIQUE(video_id)` — reprocessing the same webhook is safe
- Vectorize IDs are deterministic (`{transcript_id}-{chunk_index}`)
- D1 is source of truth; Notion is a derived view (Notion failures are non-fatal, don't retry pipeline)
- Pipeline failures return 500 so Svix retries — the retry must not create duplicates
