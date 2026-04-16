# aftercall — Product Definition

## What it is

A Cloudflare Worker that turns Bluedot meeting webhooks into a queryable knowledge base (D1 + Vectorize) with a Notion triage inbox and an MCP server for Claude.ai.

## The problem it solves

aftercall lets you search and ask questions about your meetings using AI.

After a video call, it automatically saves a summary, the full transcript, and any action items. Then you can ask Claude things like _"What did I agree to do for Sarah?"_ or _"What meetings mentioned the budget?"_ — and get real answers back.

It also drops every to-do from your calls into a Notion checklist so nothing falls through the cracks.

You'd need a Bluedot account (free trial) to record your calls. Ongoing cost is about $5/mo for hosting plus a fraction of a cent per call for AI processing.

## Target users

- **Solo founders / operators** who run lots of external calls and need action items to not fall through the cracks
- **Individual professionals** (consultants, IT leads, PMs) who want Claude.ai to answer questions across their meeting history

Single-user deploys — friends fork the repo and host their own instance (GitHub username allowlist via `ALLOWED_USERS`).

## Key goals

1. **Conversational recall** — any past call queryable in Claude.ai via natural language, through MCP tools
2. **Forkable** — any friend can clone + deploy their own instance in ~10 minutes

## Non-goals

- Multi-tenant SaaS — intentionally single-user per deploy
- Real-time transcription — Bluedot handles recording + summary; aftercall ingests post-hoc
- UI surface — Claude.ai is the UI; Notion is the triage inbox
- Team-scale features — no permissions, roles, or sharing beyond GitHub allowlist
