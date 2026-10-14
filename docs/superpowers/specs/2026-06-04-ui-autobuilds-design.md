# UI-managed Autobuilds (poll → build → [handoff]) — design

**Status:** approved (design + phasing), 2026-06-04. Phase 1 = this doc. Phase 2 (handoff) deferred.

## Goal

Let an operator configure, **from the web UI**, per-project git-poll autobuild rules:
"poll branch *X* every *N* seconds; when its commit changes, build product *Y* for platform *Z*."
Multiple rules per project, different branches. Rules live **server-side** (a flat file in the
data dir), so polling can be set up for any project — including ones whose repo `smith.json`
only has `manual` triggers — without editing the repo. Phase 2 adds per-rule handoff
(Cloudflare/Steam/itch); not in this cut. Real deploys stay gated (see CLAUDE.md safety rule).

## Why this shape

Today poll triggers live only in each repo's `smith.json`, and only **URL-cloned** projects
become pollable `m_sources`. On the live coordinator that means *nothing* is polled: smith has
a poll trigger but is loaded via `--project` (no source); senet/soccer-boy are sources but are
`manual`-only. UI rules + a pollability fix make auto-build real and operator-controllable.

## Data model

- **`AutobuildRule`** (new, `SmithCore/Domain.h` or `Coordinator.h`):
  `id, projectId, branch (name or glob), intervalSeconds, product, targetOs ("" | windows | mac | linux),
   enabled, createdAt, lastSha (per-rule baseline), lastPolledAt (runtime)`.
- **`BuildRecord.targetOs`** (new field): the platform a build is pinned to. Empty = any node the
  rule/product selector allows. This is the win/mac/linux "build target" (folds in old task #34).

## Storage

`autobuilds.json` in the data dir — JSON array of rules. `Save/LoadAutobuilds` mirror
`Save/LoadSessions`. `LoadAutobuilds()` in `Start()` before the trigger thread. Gitignored.

## Platform routing (build targets, win/mac/linux)

In the dispatch matcher (`Coordinator.cpp` ~line 430, where variant `os` already overrides the
selector): also apply `if (!rec.targetOs.empty() && rec.targetOs != "any") sel.os = rec.targetOs;`.
The job is then matched only to a node of that OS, and `ResolveJobSpec` already picks
`commandByOs[node.os]` — so a Una product's per-OS command runs natively on the right box. No
`discover` spec needed; works for any product that has a `commandByOs[<os>]`.

## Source pollability (prerequisite)

A project is only pollable if `m_sources` has it. Make a `--project` local repo pollable:
in `LoadProjects`, if the project's `localDir` is a git work tree, register
`m_sources[id] = { url = primaryRepo.url, dir = localDir, branch = primaryRepo.defaultBranch,
local = true }`. Add `bool ProjectSource.local`. **Local sources are fetch-only**: the poller may
`git fetch` (read-only, never touches the work tree) but must **never** `GitRepo::Sync` them (that
would reset the operator's working copy). The build agent checks the commit out into its own
workspace regardless, so the coordinator never needs to mutate `localDir`.

## Poller integration

New loop in `TriggerLoop`/a helper, beside the existing smith.json poll:
for each enabled `AutobuildRule` whose `intervalSeconds` has elapsed:
`sha = FetchRemoteSha(source.dir, branch)`; if `sha != rule.lastSha`: when `lastSha` non-empty →
`EnqueueBuild(projectId, product, branch, sha, "autobuild", /*variant*/"", targetOs)`; then set
`rule.lastSha = sha` and `SaveAutobuilds()`. **Baseline-first** (empty `lastSha` records the sha,
no build) — consistent with the existing poll, no surprise build-storm when a rule is created;
operators can still hit Build now (manual trigger) for an immediate run.

## API (guardHuman)

- `GET  /api/projects/:id/autobuilds` → rules for the project.
- `POST /api/projects/:id/autobuilds` → create or update (body carries the rule; new id if absent).
- `POST /api/autobuilds/:ruleId/delete` → remove.

## Web UI

Project view gains an **Autobuilds** panel: a table of rules (branch · interval · product ·
platform · enabled · last build) plus an add/edit form — branch (text), interval (number + sec/min
unit), product (dropdown from the project's products), platform (dropdown: any/windows/mac/linux),
enabled (checkbox). Delete per row. Regenerate `WebAssets.cpp`.

## Tests

- `Save/LoadAutobuilds` round-trip (coordinator test or a pure seam).
- `targetOs` routing: a build with `targetOs=mac` matches only a mac node (extend the existing
  selector test in `SmithCoordinatorTest`).
- Behavioral: throwaway coordinator + tiny git repo + a UI-created rule → push → autobuild
  enqueued for the new sha with the right product/targetOs; no-change → nothing (mirrors the
  poll-state test).

## Phasing

1. **This cut:** model + storage + pollability fix + poller + targetOs routing + CRUD API + UI + tests + docs.
2. **Next:** per-rule handoff (Cloudflare/Steam/itch) with the config each needs; real deploys gated.
