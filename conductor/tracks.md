# Tracks Registry

Tracks are the logical unit of work in aftercall. Each track has a spec (why + what) and a phased implementation plan (how). Every track gets its own branch named `feat/<track-id>` (or `fix/...`, `chore/...`, `docs/...`).

> **Track specs are local-only.** `conductor/tracks/` is git-ignored (this is a
> public, forkable repo) so per-track design/roadmap docs — which may reference
> private infrastructure or downstream consumers — stay off GitHub. The shipped
> code and its generic README/docs are the public artifact; the track is the
> private design behind it. This registry intentionally lists no track rows.

Create a new track with `/conductor:new-track <slug>` (its files live under the
ignored `conductor/tracks/<slug>/`).
