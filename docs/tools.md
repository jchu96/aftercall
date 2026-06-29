# MCP Tools Reference

Seven tools are exposed at `/mcp`. Every tool returns a single `text` content block — Claude.ai renders the markdown directly.

All tools require a valid bearer token (minted via the GitHub OAuth flow — see [auth.md](./auth.md)).

---

## `search_calls`

Semantic search over call transcripts using Vectorize (OpenAI `text-embedding-3-small`).

**Input**

| Param | Type | Required | Default | Notes |
|-------|------|----------|---------|-------|
| `query` | string | yes | — | Natural-language query. |
| `limit` | integer (1–25) | no | 5 | Max number of distinct calls returned. |

**Output**

One line per matching call, deduplicated by transcript (best chunk score wins). Includes title, score, `video_id`, and a snippet from the matching chunk.

```
Found 3 calls matching "IronRidge contract":

• [2026-04-10] **Pierce weekly sync** (score 0.89) — `https://meet.google.com/abc-xyz`
   > Discussed IronRidge Q2 contract scope and timeline for the amendment…
• [2026-04-03] **Intro with Renewable Co** (score 0.82) — `https://meet.google.com/def-ghi`
   > …mentioned IronRidge as a competitor in the quote-to-order tooling space…
```

**Sample prompts**

- _"Search my calls for IronRidge."_
- _"Find the call where I talked about compensation with Pilar."_
- _"What calls mention the Q2 roadmap?"_

---

## `find_call`

Locate a **specific** call by any identifier — distinct from `search_calls`, which is for topics. Pure lexical (no embeddings): normalizes the input through `resolveMeetingCode()` and matches against the indexed `meeting_code`, the raw `video_id`, the title, and participant names/emails (`json_each`). Ranks exact-identifier hits above title/participant matches.

**Input**

| Param | Type | Required | Default | Notes |
|-------|------|----------|---------|-------|
| `query` | string | yes | — | A Meet/Zoom URL, bare meeting code, hex id, title fragment, or participant name/email. Paste verbatim — normalization (scheme/`www.`/query-string stripping) is handled for you. |
| `limit` | integer (1–25) | no | 10 | Max candidate calls returned. |

**Output**

One line per candidate with its exact `video_id`, ranked. A pasted `https://meet.google.com/www-jjni-xtd` resolves a row stored as the schemeless `meet.google.com/www-jjni-xtd`. On no match, the message names the recovery tool (`search_calls` for topics, `recent_calls` to browse).

```
Resolved "https://meet.google.com/www-jjni-xtd" → 1 call. Use its `video_id` with get_call or answer_from_transcript:

• [2026-06-12] **Pricing sync** — `meet.google.com/www-jjni-xtd`
```

**Sample prompts**

- _"Find the call at https://meet.google.com/www-jjni-xtd."_
- _"Which meeting was the 'Main Service Panel Naming' call?"_
- _"Pull up my call with Pierce."_

---

## `get_call`

Fetch one call's full details. Accepts an exact `video_id` and also tolerates a pasted URL / code / title — it runs the exact → normalized (`meeting_code`) → fuzzy chain and returns a disambiguation list if several calls match.

**Input**

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| `video_id` | string | yes | Exact `video_id` from another tool, or an identifier to resolve (Meet/Zoom URL, meeting code, or title). |

**Output**

Markdown-formatted block: title, source link, recorded date, summary, participants, action items.

```
# Weekly sync with Pierce
**Source:** https://meet.google.com/abc-xyz
**Recorded:** 2026-04-10 15:00:00

## Summary
We discussed the Q2 plan and next steps for IronRidge…

## Participants
- Jeremy Chu <j@example.com>
- Pierce Somebody <p@example.com>

## Action items
- Send proposal to Pierce *(owner: Jeremy)* — due 2026-04-21
- Review spec *(owner: Pierce)*
```

Returns `"Call not found: <video_id>"` when no row matches.

**Sample prompts**

- _"Pull up the full details of the call with video_id `https://meet.google.com/abc-xyz`."_
- _"Show the action items from my last call with Pierce."_ (Claude will typically chain with `search_calls` → `get_call`.)

---

## `list_followups`

Query the Notion **Followups** database (`NOTION_FOLLOWUPS_DATA_SOURCE_ID`) with optional `Status` and `Source` select filters.

**Input**

| Param | Type | Required | Default | Notes |
|-------|------|----------|---------|-------|
| `status` | string | no | — | Filter by `Status` select (e.g. `Inbox`, `In Progress`, `Done`). |
| `source` | string | no | — | Filter by `Source` select (e.g. `Bluedot`). |
| `limit` | integer (1–100) | no | 25 | Max rows. |

**Output**

```
Found 4 followups:

• **Send proposal to Pierce** — Inbox · P1 · owner: Jeremy · due 2026-04-21 · from: Weekly sync with Pierce
   https://notion.so/page-1
• **Review compensation doc** — Inbox · P2 · owner: Jeremy · from: Comp chat with Pilar
   https://notion.so/page-2
…
```

When `status` + `source` are both set, the filter is an `and` composition. When Notion returns zero rows or a non-2xx error, the tool surfaces that instead of throwing — keeps Claude's response cycle smooth.

**Sample prompts**

- _"What followups are in my inbox?"_
- _"Show me the Bluedot followups I haven't started yet."_
- _"List my top 10 open followups."_

---

## `find_action_items_for`

Find action items assigned to a specific person across all indexed calls. Case-insensitive substring match on the `owner` field using SQLite's `json_each` expansion.

**Input**

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| `person` | string | yes | Name or substring. `"Andy"` matches `"Andy Ross"` and `"andy@…"` alike. |
| `since` | string (`YYYY-MM-DD`) | no | Lower bound on the call's `created_at`. |

**Output**

```
Found 3 action items for "Andy":

• [2026-04-12] **Follow-up with permitting** — Draft permit application *(owner: Andy Ross)* — due 2026-04-19
• [2026-04-05] **Intro call** — Send vendor list *(owner: andy)*
• [2026-03-28] **Weekly team** — Review Q2 planning doc *(owner: Andy)*
```

Returns `"No action items found for \"<person>\""` when no row matches.

**Sample prompts**

- _"What action items does Andy owe me?"_
- _"Find everything assigned to Pierce since March."_
- _"What have I committed to do based on my calls?"_ (with `person: "Jeremy"`)

---

## `recent_calls`

List calls from the last N days, ordered newest first. Up to 50 rows.

**Input**

| Param | Type | Required | Default | Notes |
|-------|------|----------|---------|-------|
| `days` | integer (1–365) | no | 7 | Look-back window. |

**Output**

```
Found 4 calls in the last 7 day(s):

• [2026-04-14] Sync with Pilar (`https://meet.google.com/...`) — We discussed options for the vision board and next weekend's trip planning…
• [2026-04-12] IronRidge Q2 kickoff (`...`) — Agreed on scope and the April 30 checkpoint…
…
```

Returns `"No calls found in the last N day(s)."` when empty.

**Sample prompts**

- _"What did I do last week?"_
- _"Summarize my calls from the last 30 days."_
- _"Which meetings have I had in the past 3 days?"_

---

## `answer_from_transcript`

Ask a question about a single indexed call. Runs RAG over that call's chunks: embed the question, query Vectorize filtered by `transcript_id`, feed the top-8 chunks + question to `gpt-5-mini`, return a grounded answer.

Where `search_calls` is "which calls mention X?" across the corpus, `answer_from_transcript` is "in _this_ call, what did we decide about X?"

**Input**

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| `video_id` | string | yes | The `video_id` of the call to ask about. |
| `question` | string | yes | The natural-language question. |

**Output**

A single text block with the model's answer. The model is prompted to answer using only the transcript excerpts, and to say so plainly if the answer isn't in the excerpts — it should not invent details.

When Vectorize returns zero chunks (eventual consistency right after ingest, or metadata-index miss), the tool falls back to the full `raw_text` stored in D1 and passes a truncated copy to the model instead. If neither path has content, returns `"Transcript not yet indexed — try again in a moment."`

**Errors**

- Unknown `video_id` → `"Call not found: <video_id>"`
- No chunks in Vectorize AND empty `raw_text` → `"Transcript not yet indexed — try again in a moment."`

**Sample prompts**

- _"In the IT Hiring call, when did we discuss the €1,500 offer?"_
- _"What did Jugoslav say about MCP servers?"_
- _"Summarize the compensation section of the call at `meet.google.com/abc-xyz`."_
- _"Did we agree on a start date for the new hire?"_

**Prerequisite: metadata index**

This tool uses `filter: { transcript_id }` on Vectorize, which requires a metadata index pre-declared on the `transcript_id` property. `scripts/setup.ts` creates this for new forks; existing deployments run:

```bash
npx wrangler vectorize create-metadata-index aftercall-vectors \
  --property-name=transcript_id --type=number
```

Metadata indexes only apply to vectors inserted _after_ index creation. If you have historical data, `scripts/reindex-vectorize.ts` re-upserts every existing chunk so the filter works across your whole history. See `conductor/tracks/notion-redesign-and-rag-tool/migration.md`.

---

## Error responses

MCP errors follow JSON-RPC 2.0 conventions:

- Invalid bearer → HTTP 401 with `WWW-Authenticate: Bearer resource_metadata="..."`
- Unknown tool name → JSON-RPC error `-32601 Method not found`
- Invalid input (e.g. `limit: -5`) → JSON-RPC error `-32602 Invalid params` (the SDK enforces Zod schemas automatically)
- Upstream failure (OpenAI/Notion non-2xx) → the tool surfaces the error as a text response rather than throwing, so Claude sees a readable message.

---

## Adding a new tool

1. Create `src/mcp/tools/<name>.ts` with a pure async function `(args, env, deps?) => ToolResult`.
2. Write a unit test at `src/mcp/tools/<name>.test.ts` — follow the pattern in existing tests (real D1 via `setupD1()`, mocks for external services).
3. Register the tool in `src/mcp/tools.ts` with a Zod input schema, `title`, and `description`. Zod runtime validation + schema export is automatic.
4. Add an entry to this file.
5. Deploy. Claude.ai picks up the new tool on the next `tools/list` call (usually after a reconnection).
