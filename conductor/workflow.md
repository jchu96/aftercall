# Workflow

How aftercall gets built. These are hard rules, not suggestions.

## TDD — strict

Every feature and bugfix starts with a failing test.

1. **Red** — write a failing test that expresses the behavior you want
2. **Green** — write the minimum code to make it pass
3. **Refactor** — clean up while tests stay green

No code change without a test. Exceptions: docs-only edits, `wrangler.toml` / `.gitignore` / CI config, typo fixes.

**Tests hit real D1 via miniflare** (via `@cloudflare/vitest-pool-workers`). Never mock D1. Vectorize must still be mocked (no miniflare support yet).

## Conventional Commits

```
<type>[optional scope]: <subject>

[optional body]
```

Types used in this repo: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `perf`, `ci`.

- Imperative, present tense ("Add", "Fix", "Upgrade")
- ≤ 70 char subject
- Body explains **why**, not what (the diff shows what)

## Branching — feature branches, never straight-to-main

Every new feature, fix, or non-trivial chore goes on a branch:

```
feat/notion-redesign-and-rag-tool
fix/notion-400-on-long-summary
chore/upgrade-gpt-5-mini
docs/roadmap-delete-call
```

1. Branch off `main`
2. Commit on the branch (following Conventional Commits)
3. Open PR against `main` — self-review your own diff cohesively
4. Squash-merge once tests pass

**Direct push to `main` is reserved for trivial edits only** — typo fixes, one-line README tweaks. Previous commits that landed on main directly are grandfathered; new work follows this rule.

## Code review — self-review via PR

Single-maintainer repo (for now). Open the PR against `main`, skim your own diff top-to-bottom before merging. The discipline of reviewing your own change cohesively catches things the in-flight edits didn't.

When external collaborators appear, upgrade to required reviews for non-trivial changes.

## Verification checkpoints

Manual verification required **after each track phase**, before marking the phase complete:

1. `npx vitest run` — all tests green
2. `npx tsc --noEmit` — typecheck clean
3. For pipeline changes: fire a real webhook and `npx wrangler tail` to confirm end-to-end behavior
4. For MCP changes: smoke-test in Claude.ai
5. For Notion schema changes: confirm Notion pages render as expected

Track phases (red → green → ship) are the natural checkpoint granularity. Per-task verification is too much ceremony; per-track verification is too little.

## Track lifecycle

1. `/conductor:new-track <name>` creates the spec + phased implementation plan under `conductor/tracks/<track-id>/`
2. Implementation goes on a branch named after the track (`feat/<track-id>`)
3. Each phase commits incrementally on the branch
4. Phase complete = tests green + manual verification + checkbox updated in track spec
5. Track complete = all phases done + PR merged + track moved to "completed" in `tracks.md`

## Deploy

- **Local dev:** `npx wrangler dev` (remote Vectorize)
- **Production:** `npm run deploy` — wraps `wrangler deploy` with optional Sentry source-map upload
- **Raw deploy** (no Sentry): `npx wrangler deploy`
- **Migrations:** `npx wrangler d1 migrations apply aftercall-db --remote` — never forget `--remote`
