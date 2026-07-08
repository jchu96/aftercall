# Changelog

All notable changes to this project are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Video enrichment (optional, script-only): `scripts/enrich-video.ts`** — point it at a screen recording of a call and it uploads the video to Google Gemini, analyzes it *with the call's transcript as context* (resolved from the filename's meeting code via `resolveMeetingCode()`), and writes an issue-grade dossier of on-screen problems: verbatim UI text, the reporter's quote, the click-path as performed, a screenshot per incident, and the app URL when a browser address bar is legible. Two-pass (cheap low-res whole-call index → targeted medium-res per-incident read that also discards false positives). Output + a re-run ledger land under git-ignored `staging/dossiers/`. `npm run enrich -- "<recording>"`.
  - Gemini is the **one sanctioned exception** to the single-provider (OpenAI) rule, scoped strictly to this script — never imported by the Worker. `GEMINI_API_KEY` is optional (falls back to `NEC_KB_GEMINI_API_KEY`); forkers without it just skip the feature. Text extraction + embeddings stay OpenAI.
  - `app_url` is only populated when an address bar is actually visible + legible — the model is instructed to abstain rather than confabulate a hostname.
- `enrich` npm script; `GEMINI_API_KEY` documented as an optional secret.

## [0.6.0] — 2026-06-29

**Call lookup by identifier + speaker-aware RAG.** Fixes two retrieval gaps: you couldn't find a call by pasting its Meet URL (only semantic search existed, and it returns noise for identifiers), and chunk boundaries orphaned speaker labels so per-call Q&A misattributed who said what.

### Added

- **`find_call(query, limit?)` MCP tool** — structured/lexical call lookup (the counterpart to semantic `search_calls`). Resolves a Meet/Zoom URL, bare meeting code, hex id, title fragment, or participant name to a call, ranked exact-identifier-first. No embeddings.
- **`meeting_code` column** (indexed, nullable) derived from `video_id` via the new pure `resolveMeetingCode()` (`src/identity.ts`). A pasted `https://meet.google.com/x`, schemeless `meet.google.com/x`, and bare `x` all collapse to the same code, so lookups stop depending on the stored format. `video_id` stays verbatim (still the `UNIQUE` idempotency key).
- **Shared `resolveTranscript()` resolver** (`src/mcp/resolve.ts`) — exact → normalized → fuzzy chain with disambiguation, used by `get_call`, `find_call`, and `answer_from_transcript`.
- **Embedding provider seam** (`src/embed.ts`) — single `embedQuery()` for query-time embeddings, so swapping providers (e.g. Gemini `gemini-embedding-001` @1536d) is localized to one module.
- `chunk_count` + `chunk_schema_version` columns + `tailDeleteIds()` helper for resumable re-indexing.

### Changed

- **Turn-aware chunking.** `chunkTranscript` now packs whole `Speaker: utterance` turns (never splitting mid-turn), merges consecutive same-speaker fragments, and re-labels oversized-turn splits with `(continued)` — so every chunk carries speaker attribution. Plain (non-transcript) text falls back to the legacy sentence-based splitter. Bumped `CHUNK_SCHEMA_VERSION` to 2.
- `answer_from_transcript` — speaker-attribution system prompt; cold-Vectorize fallback now selects question-relevant turns instead of truncating the first 24k chars; resolves flexible identifier forms.
- `get_call` hardened to normalize + fuzzy-resolve and disambiguate; `search_calls`/`get_call`/`find_call` descriptions rewritten so the model routes identifiers → `find_call`, topics → `search_calls`.
- `scripts/reindex-vectorize.ts` re-embeds with the speaker-aware chunker (passing participant names), tail-deletes stale vectors, and backfills `meeting_code` + chunk metadata. `--stale-only` skips already-v2 rows. **Run once after deploy** to re-index existing calls.
- MCP tool count: **6 → 7**.

## [0.5.0] — 2026-04-16

**Notion redesign + per-call RAG tool.** aftercall's Notion Transcripts DB stops duplicating Bluedot's native summary pages and becomes a structured metadata hub. New `answer_from_transcript` MCP tool for drilling into a specific call.

### Added

- **`answer_from_transcript(video_id, question)` MCP tool** — RAG over a single call. Embeds the question, filters Vectorize by `transcript_id`, concatenates top-8 chunks, passes to `gpt-5-mini`. Falls back to D1 `raw_text` when Vectorize returns zero chunks (eventual consistency or pre-metadata-index gap).
- `Recording URL` + `Bluedot Page` URL properties on the Transcripts DB — structured links to the recording and Bluedot's native Notion summary page.
- `Meeting` relation on the Followups DB pointing back to the Transcripts row. Click a followup → jump to its meeting.
- Vectorize metadata index on `transcript_id` — required for the new tool's filter. `scripts/setup.ts` now creates it idempotently.
- `scripts/reindex-vectorize.ts` — re-upserts existing chunks so the new metadata index covers historical vectors. One-off migration.
- `scripts/backfill-meeting-relation.ts` — one-off backfill for `Meeting` relation on existing Followups (forker utility; not needed for new deploys).
- `scripts/smoke-answer.ts` — canned eval set for `answer_from_transcript` against the deployed worker.
- `conductor/` directory with project-wide context artifacts (product, tech stack, workflow, style guide, track specs).

### Changed

- **Transcripts page body** shrank to a single "View on Bluedot" link block — no more summary content. Bluedot's native Notion sync owns the rich summary narrative; aftercall's Transcripts DB provides structured metadata and filterable views that Bluedot doesn't.
- `buildFollowupRowBody` now requires `transcriptPageId` and emits a `Meeting` relation property.
- Handler skips followup creation (with a warn log) when the Transcripts page fails to create, to avoid orphan relations.
- MCP tool count: **5 → 6**. MCP server version: `0.3.0 → 0.5.0`.
- `docs/tools.md` documents the new tool + its metadata-index prerequisite.

### Removed

- `summaryToBlocks` / `heading3` / `richTextSegments` markdown parser in `src/notion.ts` — dead now that summary rendering moved out.
- `Summary` and `Action Items` rich_text properties on the Transcripts DB (left as orphan columns on existing Notion rows; safe to ignore or manually archive).

### Breaking

- Existing deploys must run the migration steps in [`conductor/tracks/notion-redesign-and-rag-tool/migration.md`](./conductor/tracks/notion-redesign-and-rag-tool/migration.md): add the new Notion properties, create the Vectorize metadata index, and reindex existing vectors. Takes ~5 minutes.
- Historical Followups rows will not get `Meeting` relations automatically — jchu96's production data had Video ID mismatches that made automated backfill impossible, documented in the migration guide. New Followups populate the relation correctly.
- Fresh forks get the new schema automatically via the updated `npm run setup`.

### Why

Bluedot already produces a rich, structured summary page in Notion for every meeting (Overview + grouped Action Items + Topics under a "BlueDot Calls" parent). aftercall's previous Transcripts page was a lower-quality duplicate with a single long paragraph for the whole summary — sometimes triggering Notion's 2000-char rich_text limit with a 400 error. Rather than patch the parser (done in 0.4.x but dead-code now), this release acknowledges Bluedot as the summary owner and repositions aftercall's Notion surface as the structured layer Bluedot doesn't provide: filterable DB views, triageable action items, and cross-meeting relations.

---

## [0.4.0] — 2026-04-15

**Rebrand: `bluedot-rag` → `aftercall`.** Fresh worker URL, D1 database, and Vectorize index — all workspace-specific IDs moved out of committed config.

### Changed

- **Worker URL**: `https://bluedot-rag.jeremy-chu.workers.dev` → `https://aftercall.jeremy-chu.workers.dev`
- **D1 database**: `bluedot-rag-db` → `aftercall-db` (data migrated via `wrangler d1 export` + `execute --file`)
- **Vectorize index**: `bluedot-rag-vectors` → `aftercall-vectors` (re-embedded from D1 via `scripts/migrate-vectorize.ts`)
- **GitHub repo**: `jchu96/bluedot-rag` → `jchu96/aftercall` (GitHub auto-redirects old URLs)

### Added

- `wrangler.toml.example` — committed template with placeholders for workspace-specific IDs (D1 `database_id`, KV `id`, Notion data source IDs, `BASE_URL`, `ALLOWED_USERS`).
- `scripts/setup.ts` — `ensureWranglerToml()` copies `wrangler.toml.example` → `wrangler.toml` on fresh clones before any step reads the config.
- `scripts/migrate-vectorize.ts` — reusable script that re-embeds all D1 transcripts into a named Vectorize index (for future reindexing / rename ops).

### Security

- `wrangler.toml` is now gitignored. Workspace-specific identifiers (D1 `database_id`, KV namespace `id`, Notion data source IDs) no longer land in the public repo.

### Breaking

Forkers or existing users pulling this release must:

1. Update their Bluedot webhook endpoint URL.
2. Update their GitHub OAuth App's Homepage URL + Authorization callback URL.
3. Reconnect the Claude.ai MCP connector to the new worker URL.
4. On fresh clones, run `npm run setup` — `wrangler.toml` will be generated from the template.

---

## [0.3.0] — 2026-04-15

**Sentry error tracking + pipeline performance tracing.** Fully optional — leave `SENTRY_DSN` unset and the SDK is a no-op so forkers without a Sentry account can still clone and deploy.

### Added

- `@sentry/cloudflare` integration wrapping the worker entrypoint. Runtime captures uncaught errors from OAuth, MCP, and webhook paths automatically.
- Pipeline tracing in `src/handler.ts` — top-level `bluedot.pipeline.{transcript,summary}` spans with child spans for `openai.extract`, `openai.embed`, `d1.upsert_*`, `vectorize.upsert`, `notion.create_transcript_page`, `notion.create_followup`.
- `Sentry.captureException` at every pipeline catch site with `video_id` + `svix_id` tags (non-fatal Notion failures still report).
- `SENTRY_DSN`, `SENTRY_ENVIRONMENT`, `SENTRY_RELEASE` on the `Env` interface (all optional).
- `scripts/deploy.mjs` — deploy wrapper that uploads source maps to Sentry when `.sentryclirc` or `SENTRY_AUTH_TOKEN` is present, and skips gracefully otherwise.
- `SENTRY_ORG` + `SENTRY_PROJECT` env vars to override the Sentry project target.
- README "Observability (optional)" section + `SENTRY_*` rows in env/vars reference.
- Setup script auto-detects the worker URL during step 8 (GitHub OAuth App registration). Reads `BASE_URL` from `wrangler.toml` on re-runs; on first runs falls back to Cloudflare's `/accounts/{id}/workers/subdomain` API using wrangler's stored OAuth token. Removes the "guess your worker URL" footgun.

### Changed

- `openai` upgraded `^4.77.0` → `^6.34.0` to resolve the `zod@^4` peer conflict with `@modelcontextprotocol/sdk`. No source changes required — `chat.completions.create` and `embeddings.create` APIs are stable across the jump.
- `src/index.ts` now wraps the OAuth-provider worker in `Sentry.withSentry` with `enabled: Boolean(env.SENTRY_DSN)` so the SDK is inert without a DSN.
- `npm run deploy` now runs `scripts/deploy.mjs` (wraps `wrangler deploy --outdir dist --upload-source-maps` plus optional Sentry release tagging + sourcemap upload).

### Notes

- Git history was rewritten in this release to replace the previous commit author email with the GitHub noreply address, and to strip references to an unrelated predecessor project. Commit SHAs prior to `0.3.0` no longer match what was published during `0.2.0`.

---

## [0.2.0] — 2026-04-15

**MCP server with GitHub OAuth.** Indexed calls are now queryable from Claude.ai over the Model Context Protocol.

### Added

- MCP server at `/mcp` using `@modelcontextprotocol/sdk` Streamable HTTP transport in stateless mode.
- Five MCP tools with Zod schemas:
  - `search_calls(query, limit?)` — semantic search via OpenAI embeddings + Vectorize.
  - `get_call(video_id)` — full D1 transcript details.
  - `list_followups(status?, source?, limit?)` — query the Notion Followups DB.
  - `find_action_items_for(person, since?)` — `json_each` over the D1 `action_items` column.
  - `recent_calls(days?)` — last N days of calls ordered newest first.
- GitHub OAuth using `@cloudflare/workers-oauth-provider`. `/authorize` + `/auth/github/callback` mint MCP bearer tokens after verifying the caller's GitHub username against a comma-separated `ALLOWED_USERS` allowlist.
- `POST /auth/revoke` endpoint to invalidate a bearer token via `unwrapToken` + `revokeGrant`.
- `OAUTH_KV` KV namespace binding for OAuth state (`gh-state:*`, 5-min TTL) + OAuth provider's internal storage.
- Setup script step 8 that provisions `OAUTH_KV`, walks through GitHub OAuth App registration, collects `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` / `ALLOWED_USERS`, and writes everything to `wrangler.toml` + `.dev.vars`.
- Docs: `docs/architecture.md` (ingestion + OAuth + MCP query flow mermaid diagrams), `docs/tools.md` (tool reference with sample Claude.ai prompts), `docs/auth.md` (OAuth setup walkthrough + troubleshooting).
- `global_fetch_strictly_public` compatibility flag (required by `workers-oauth-provider`).

### Changed

- `src/index.ts` is now a thin re-export from `src/mcp/index.ts`, which wraps the Bluedot webhook handler + OAuth routes + MCP API handler under a single `OAuthProvider` default export.
- `Env` type extended with `OAUTH_KV`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `ALLOWED_USERS`, `BASE_URL`.
- `src/mcp/handler.ts` dynamically imports `./tools` so the MCP SDK (and its transitive `ajv` dep) doesn't load on non-MCP code paths — keeps vitest-pool-workers' ESM shim happy.

### Notes

- End-to-end MCP transport (`tools/list`, `tools/call` through Streamable HTTP) is exercised by live Claude.ai smoke tests rather than automated — `ajv`'s internal JSON import breaks under vitest-pool-workers' ESM shim, but each tool's business logic is covered by a fast unit suite.
- Bluedot webhook (POST `/`) behavior is unchanged — the same signed payloads continue to flow through the ingestion pipeline.

## [0.1.0] — 2026-04-14

Initial public release. Bluedot → Cloudflare D1 + Vectorize → Notion Followups pipeline.

### Added

- Cloudflare Worker that verifies Svix-signed Bluedot webhooks and handles both `meeting.transcript.created` + `meeting.summary.created` event types.
- OpenAI structured extraction (`gpt-5-mini` via json_schema) to pull `{ title, summary, action_items[], participants[] }` from Bluedot's summary text.
- OpenAI embeddings (`text-embedding-3-small`, 1536d) on chunked transcript text, upserted to Cloudflare Vectorize with deterministic IDs (`{transcript_id}-{chunk_index}`).
- Cloudflare D1 `transcripts` table with `UNIQUE(video_id)` constraint for idempotent concurrent writes.
- Notion integration (direct `fetch`, not the SDK) that creates one page per meeting in a Call Transcripts DB and one row per action item in a Followups DB with `Status = Inbox`.
- Interactive `npm run setup` script that provisions D1, Vectorize, both Notion databases, and writes `.dev.vars` + `wrangler.toml`.
- Migration script for historical Neon transcripts → D1 + Vectorize + Followups.

[0.5.0]: https://github.com/jchu96/aftercall/releases/tag/v0.5.0
[0.4.0]: https://github.com/jchu96/aftercall/releases/tag/v0.4.0
[0.3.0]: https://github.com/jchu96/aftercall/releases/tag/v0.3.0
[0.2.0]: https://github.com/jchu96/aftercall/releases/tag/v0.2.0
[0.1.0]: https://github.com/jchu96/aftercall/releases/tag/v0.1.0
