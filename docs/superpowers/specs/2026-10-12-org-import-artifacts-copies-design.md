# Import a GitHub organisation into Smith: Artifacts as the home, budgeted copies on machines

**Status:** design approved in conversation 2026-10-12; implementation plan to follow.
**Scope:** the Cloudflare-hosted coordinator (`cloudflare/coordinator/`), the hosted native agent
(`Modules/SmithAgent/Hosted*.cpp`) and the hosted dashboard. The LAN coordinator is unchanged.
**Builds on:** `2026-10-06-smith-hosted-git-design.md` (machine-hosted copies, the relay, R2 bundles) and
`2026-10-09-git-lfs-on-r2-design.md` (Git LFS on R2, copies of large files on machines; pull request #12).
The branch for this work is cut from the merged #12 (commit `a9cf881`).

## Context

Red-Marmoset's code lives in 55 GitHub repositories. The owner wants to leave GitHub: every repository
copied into Smith in one batch, with git objects on Cloudflare Artifacts and large files on Smith's own
R2-backed Git LFS, and **without every build machine having to hold a copy of everything**. Machines
should keep copies as redundancy, within a budget each, spread across the fleet.

What exists today on the branch:

- Two kinds of "Smith's copy": on Cloudflare Artifacts (`project.artifacts`, pushed by a `mirror` job,
  cloned directly from the Artifacts remote with 90-day Artifacts tokens) and on the workspace's own
  machines (`project.hosted`, served through the relay at `<origin>/git/<project>.git`). `copyOf`
  (`upstream.ts`) prefers the machine copy. A project started on Artifacts is moved onto a machine as soon
  as one with "Keep copies of repositories here" is online, and a `keep-artifacts-copy` mirror job pushes
  the branch back to Artifacts after each push to the machine copy.
- Replication is "every switched-on machine holds every repository" (up to `MAX_REPLICAS = 5`,
  `git-tasks.ts`), and on the LFS branch "every switched-on machine holds every large file" while a
  free-disk reserve holds. Two per-machine switches (`host_repos`, `host_lfs`), no budget, no spreading.
- GitHub sign-in stores a per-user token with `repo` scope (`oauth.ts`, `githubTokenFor`); a workspace
  `githubToken` secret exists; `listGitHubRepos` lists what a token can see (installations plus
  `/user/repos`), capped at three pages. There is no organisation listing.
- The `mirror` job on the agent clones a source with the machine's own git login and pushes a branch and
  tags to a remote with a token (`HostedAgent.cpp`, `mirrorSpecs` in `projects.ts`).

Facts from the Cloudflare Artifacts documentation (read 2026-10-12): import takes **public HTTPS remotes
only** (no credentials field; `REMOTE_AUTH_REQUIRED` 10106), is one-shot, and asynchronous; **no Git
LFS**; limits are **32 MB per blob, 1 GB per repository**, 1 TB per account, unlimited repositories;
tokens are repo-scoped `read`/`write` with a TTL of 60 s to one year; the REST API lists repositories with
cursors and deletes them (202); there is no refs listing (the smart-HTTP advertisement is the way); push
notifications exist only through Queues event subscriptions. Pricing is Workers Paid: 1 GB and 10,000
operations free per month, then $0.50 per GB-month and $0.15 per thousand operations.

### Decisions made with the owner (2026-10-12)

1. **One git URL for every project**: `https://exp.redmarmosetstudios.com/git/<project>.git`. The Worker
   proxies to Artifacts, or relays to a machine, behind it. Smith tokens and tickets everywhere; the
   Artifacts-token clone path is retired.
2. **Artifacts is the source of truth whenever a repository is there.** A machine is the home only for
   a repository Artifacts cannot hold (over 1 GB) or when an owner chooses. The "move onto a machine when
   one appears" behaviour goes.
3. **Smith's existing LFS server on R2** (pull request #12) is reused, not duplicated.
4. **Files over a threshold are moved to LFS on import**, whether or not the repository used LFS, by
   rewriting history with `git lfs migrate import`. The threshold is a workspace setting (default 10 MB,
   at most 32 MB) and can be changed per import run. The original history is bundled into R2 first;
   rewritten repositories are detached from GitHub.
5. **One budgeted copies layer** for repositories and large files together, per machine; **target
   copies per item** (default 2) placed on the machines with the most unused budget; **one `import`
   job per repository** through the normal queue.

## Design

### 1. Home

`Project` gains a server-owned field `home: 'artifacts' | 'machines'`, set when a copy completes and
never accepted from a caller (`validateProject` leaves it out, like `createdBy`).

- `home: 'artifacts'`: `project.artifacts.status === 'done'`, the project's `repoUrl` is Smith's URL
  (`smithRemote(origin, id)`), and the workspace holds a `git_repos` row for the project with the new
  state **`artifacts`** (no primary node; see §3). `copyOf` answers `{ kind: 'artifacts', remote: <Smith
  URL>, ... }` from this field alone.
- `home: 'machines'`: exactly today's hosted copy (`project.hosted.status === 'ready'`, `git_repos` in
  `hosting`/`degraded`/...).
- No `home`: the project builds from the repository it was added from.

Rules:

- A new copy (Copy into Smith, Start a project, Import from GitHub) goes to **Artifacts** when the
  workspace can use it (`artifactsReady()`) and the repository fits; otherwise to machines, and the card
  says which and why ("On a build machine: over 1 GB, too large for Smith's storage").
- The automatic move from Artifacts to a machine (`host` job queued when a host comes online, and the
  `keep-artifacts-copy` mirror job) is **removed**. The card of a machines-home project offers **Move to
  storage** (owner/admin) when the repository fits: a `mirror` job pushes every branch and tag to a fresh
  Artifacts repository, the Worker verifies the heads, then `home` flips to `artifacts` and the machine
  copies become ordinary copies (§4). The reverse, **Move to machines**, exists for completeness
  (today's `host` job from the Artifacts remote with a read token).
- **Upgrade of existing projects** (one pass in the alarm after deploy): a project with both an
  Artifacts copy and a hosted copy keeps `home: 'machines'` and gets the Move to storage button; a
  project with only an Artifacts copy becomes `home: 'artifacts'` with `repoUrl` switched to Smith's URL
  and a `git_repos` row in state `artifacts` seeded from the advertisement (§3); a project with only a
  hosted copy becomes `home: 'machines'`. Nothing moves bytes.
- `hasSmithCopy` (crew), `pushNeedsBuilder` (sessions) and every "builds from Smith's copy" check treat
  both homes alike: a copy is a copy.
- Pull, Push and Detach (`upstream.ts`) work the same for both homes: the remote is Smith's URL and the
  credential is a job-bound ticket (`mintTicket`), as for hosted copies today. `pullToken` and
  `syncSpecs` lose their Artifacts-token branch.

### 2. The git endpoint: proxy or relay

`handleGit` (`git-route.ts`) keeps its path match, authentication (`authenticateGit`), rate limits,
username check and refusal texts. After the workspace object authorises the request (`git-read`,
`git-write`, `git-advertise`, `git-ls-refs`), the answer says which backend serves it:

- **`backend: 'relay'`** (machines home): today's path, unchanged.
- **`backend: 'artifacts'`** with `{ remote, token }`: the Worker **proxies**. `info/refs` and both RPCs
  are forwarded to `<remote>/<same path and query>` with `Authorization: Bearer <token>`, the client's
  `Content-Type`, `Content-Encoding`, `Accept` and `Git-Protocol` headers, and the request body streamed
  through untouched (`fetch(…, { body: request.body, duplex: 'half', redirect: 'manual' })`). The
  answer streams back with its `Content-Type` and the `NO_CACHE` headers. Nothing is buffered and
  nothing touches R2. For an Artifacts home the v2 advertisement and `ls-refs` are **proxied, never
  answered from the record**, so a client always sees Artifacts' truth.
- Inbound push bodies are capped by the platform at 100 MB per request; a larger push gets the existing
  413 text ("push larger than 100 MB"). Clone and fetch responses are unlimited.

**Tokens.** The workspace object mints repo-scoped Artifacts tokens through the existing
`ArtifactsClient.issueToken` and caches them in a new table `artifacts_tokens(project_id, scope,
token_id, plaintext, expires_at, PRIMARY KEY (project_id, scope))`: `read` tokens live one hour and are
reused by every read in that hour; `write` tokens live ten minutes. A token is minted outside the
transaction (the pattern of `pullToken`), stored, and revoked when replaced or when the project is
removed. Machines, browsers and MCP clients never receive an Artifacts token; the only exception is the
bulk push of an `import` job (§5) and the Move to storage mirror job, which carry one as the `mirror`
job does today.

**After a push.** When a proxied `git-receive-pack` answers 200, the Worker, in `ctx.waitUntil`,
fetches the repository's advertisement with the read token it already holds (§3) and posts the tips to
the workspace object (`git-artifacts-tips {repo, tips}`), which bumps the generation, marks copies
stale, queues copy refreshes and calls `copyPushed(repoId, before, after)` so Build on push and the
crew's branch triggers fire exactly as for a push to a machine copy. A failed fetch leaves the record
alone; the alarm's daily refresh catches up.

**Artifacts unavailable.** A proxied request that fails to connect, times out (30 s to first byte) or
answers 5xx: a read is retried **once through the relay** against a machine holding a `current` copy
(`git-read` with `backend: 'relay'` requested: for a repository in state `artifacts` it picks a `current`
replica, or refuses with the storage text when none is online), and the response says nothing of it; a
write answers `ERR Smith's storage is unreachable; nothing was pushed. Try again in a few minutes` on
`info/refs` and 503 with the same text on the RPC. A 401 or 403 from Artifacts means the cached token
is bad: it is dropped, a new one minted, and the request retried once; a second refusal is logged as
`artifacts_token_refused` and answered 502 "Smith could not reach its copy of this project".

**Clone dialog.** One intro, one URL, one credential for every project with a home. The
`clone-help-artifacts` paragraph and the `artifacts-credential` action and route are removed.

### 3. The record of an Artifacts home

Artifacts-home repositories reuse the hosted-git record so copies, tips, Build on push and the card
share one code path:

- A `git_repos` row with `state = 'artifacts'`, `primary_node_id = NULL`, `uuid`, `default_branch`,
  `refs_json`/`refs_digest`, `generation`, `bytes` (from the last copy report), `source_url` (the
  Artifacts remote) and `last_push_at`. `hostEligible`, promotion, backups and restore skip this state.
- **Tips** come from the smart-HTTP advertisement: `GET <remote>/info/refs?service=git-upload-pack`
  with a read token and no `Git-Protocol` header (protocol v1 lists every ref), parsed by a new
  `parseAdvertisement` in `git-host.ts` into `Tips`, peeled tags included. `refreshArtifactsTips(repo)`
  is the fetch plus the `git-artifacts-tips` action: the Worker runs it after each proxied push, and the
  alarm runs it outside its transaction (as `sweepLfs` does its R2 calls) once a day, after a Move to
  storage, and whenever a copy reports a digest the record does not have (someone may still hold an old
  Artifacts token). A changed digest bumps the generation, marks copies stale and queues refreshes.
- **Machine copies** of an Artifacts home are `git_replicas` rows as today. The `replicate` task's
  payload keeps `remote: smithRemote(origin, repo.id)` and the node-bound read ticket: the machine
  fetches through Smith, the Worker proxies to Artifacts, and no machine ever holds an Artifacts token.
  A copy is `current` when its tips digest equals the record's.
- **Loss and restore.** A daily probe (`getRepo` plus the advertisement) that finds the Artifacts
  repository missing or empty marks the row `lost` with "Smith's storage no longer has this repository;
  a machine holding a copy can restore it", and the card offers **Restore to storage**: a `mirror` job on
  a machine with a `current` copy (its own `file://` store, the `--mirror` push of every branch and tag)
  into a fresh Artifacts repository, verified by the advertisement, then `state` returns to `artifacts`.
  R2 bundle backups are **not** taken for Artifacts homes (Artifacts is the durable store and machine
  copies are the second one); the `backups` section of the card shows the original-history bundle of a
  rewritten import (§5) only.
- Removing a project deletes the Artifacts repository (`ArtifactsClient.deleteRepo`, new: the binding's
  `delete(name)` or `DELETE …/repos/:name`), revokes its tokens, marks the row `deleted` and queues
  `discard` tasks and LFS drops as today.

### 4. Copies on machines: one budgeted layer

**Per machine (per workspace).** One switch, **Keep copies here**, and a **budget**. `host_repos`
becomes the switch; `host_lfs` is kept in the schema and always written equal to `host_repos` (the
`node-lfs` action and `POST nodes/:id/lfs` route are removed; `node-host` and `POST nodes/:id/host`
take `{ host: boolean, budgetBytes?: number | null }`). New column `copy_budget_bytes INTEGER` (NULL:
the workspace default) in schema version 22. The agent's heartbeat `hosting: { able, reason, free }`
is unchanged.

**Workspace settings** (`settings.ts`): `copyBudgetBytes` (default 50 GiB, 1 GiB to 10 TiB),
`copiesPerItem` (default 2, 1 to 5), the existing `lfsMachineReserveBytes` renamed in the UI to "Keep at
least N GB free on machines", and `lfsImportThresholdBytes` (default 10 MiB, 1 MiB to 32 MiB; §5).

**Items.** A repository copy (`git_replicas`, `bytes` reported by the machine after each fetch) and a
large-file copy (`lfs_replicas`, the object's size). A machine's **usage** is the bytes of the copies it
holds that are not `lost`, plus the bytes of fetch and replicate tasks queued or leased to it. A
machines-home repository's primary counts like any copy.

**Planner.** A new module `copies.ts` replaces `GitTasks.planReplicas` and `LfsTasks.plan`, run from
`reconcileGit` each alarm pass and after the events that make work due (a push, a switch, a budget
change, a machine coming online). It is a pure function over `(nodes, repos, replicas, lfsObjects,
lfsReplicas, tasks, settings, now)` returning the tasks to queue and the drops to queue, so it is
unit-tested without a Durable Object.

1. **Eligible machines**: `hostEligible` (active, build purpose, switched on, not draining, labelled,
   online) with a hosting report; room for an item is `budget − usage ≥ cost` **and** `free − cost ≥
   reserve`, where cost is `REPLICA_FREE_MARGIN(bytes)` for a repository (two times its size plus 1 GiB,
   as today) and the size for a large file. A repository over `MAX_REPO_BYTES` is never copied (today's
   `oversize` rule).
2. **Placement**: items sorted by copies held (`current` or `stale`, not `lost`) ascending, then
   repositories before large files, then oldest first. For each item with fewer than `copiesPerItem`
   copies, candidate machines are those not holding it with room, ordered by unused budget descending
   and hostname as the tie-break; one task per missing copy, at most one git task and four LFS tasks
   leased per machine at a time (today's limits), at most `LFS_PLAN_LIMIT` new tasks per machine per
   pass. The source of a repository copy is the primary through the relay (machines home) or the proxy
   (Artifacts home), in both cases `smithRemote(origin, id)` with a node-bound read ticket.
3. **Stale copies** are refreshed before new ones are made (they already hold most of the bytes), as
   today's sort does.
4. **Shedding**: a machine whose usage exceeds its budget (the budget was lowered, or items grew)
   drops **one item per pass**, the newest copy first, and only an item that has at least
   `copiesPerItem` other copies not `lost`, never the primary of a machines-home repository and never
   the last `current` copy. The dropped bytes are re-placed by the next pass. Items above target that
   fit are left alone: extra copies cost nothing until budget is short.
5. **Switch off / removal**: today's `hostSwitchedOff` and `cancelFor`; the next pass re-places what was
   lost.
6. **Nothing fits**: the item is reported under-replicated; no task, no churn, no log noise.

**Dashboard.**

- Machine card, one **Copies** block: the switch; the budget field in GB with the placeholder "workspace
  default (50 GB)"; "uses 12 GB of 50 GB: 8 repositories, 340 large files · 412 GB free"; "full: budget
  reached" or "full: reserve reached" when the planner cannot place anything more; `hostingReason` when
  it cannot host at all.
- Project card: "copies on DESKTOP-SEM, MAC-MINI (2 of 2)", or "1 of 2 copies: no machine has room;
  raise a budget or switch a machine on" with links to the machines list; the Large files row says the
  same for its objects in aggregate ("340 large files, 2 copies each; 12 with one copy").
- Settings → **Copies** (the Large files block renamed and extended): default budget, copies per item,
  the reserve, the import threshold, the LFS quota and transfer mode as today, and "N repositories and M
  large files have fewer than 2 copies" with the machines that are full.

### 5. Import from GitHub

**Entry.** Projects → **Import from GitHub** (owners and admins). The dialog:

1. **Organisation**: the organisations the signed-in person's GitHub link can see (`GET /user/orgs`
   and the repositories of their App installations), else the workspace token's, else a typed name. A
   token that cannot list the organisation's repositories (404 or an empty private list on a token that
   lacks the org's approval) shows the one fix: **Link GitHub** (the existing button) or "add a
   fine-grained token with access to the organisation in Settings".
2. **Repositories**: `GET /orgs/{org}/repos?type=all&per_page=100`, up to ten pages, newest pushed
   first: name, visibility, archived, GitHub's size, last push, and "already in Smith" (matched by
   repository URL against every project's `repoUrl`, `artifacts.sourceRepoUrl`, `hosted.sourceRepoUrl`
   and `detachedFrom`). Every repository not in Smith is ticked; archived ones are ticked and marked.
   The total is shown ("55 repositories, 18 GB on GitHub").
3. **Options**: the large-file threshold (prefilled from Settings, 1 to 32 MB) and **Stay linked to
   GitHub** (on; rewritten repositories detach regardless and the row says so).
4. **Preflight**: for each ticked repository, in parallel batches of ten with a 25 s overall budget,
   `GET /repos/{o}/{r}/git/trees/{default branch sha}?recursive=1` with the same token. Rows show
   "3 files over 10 MB on main: history will be rewritten", "no large files on main", or "could not check"
   (truncated tree, rate limit, timeout). The machine's job is authoritative: history can hold large
   files that the default branch does not. Blobs over 32 MB make the row say "must be rewritten for
   Smith's storage".
5. **Import** starts it and keeps the dialog open as the **import panel**: "23 of 55 done · 2 failed
   (Retry) · 1 on a machine instead", each row with its state, the job link and the message. Re-opening
   Import from GitHub for the same organisation lists new repositories only; a repository already in
   Smith is never imported twice.

**Credentials.** Listing and preflight use the person's GitHub token (`githubTokenFor`) or the
workspace `githubToken`; neither reaches a machine. Machines clone with their own git login, as every
`mirror` and `host` job does; a machine without access is skipped through the existing `repo_access`
requeue, and the row says "waiting for a machine that can read this repository" with the machines that
tried.

**Record.** Two tables in the workspace object:

```sql
CREATE TABLE IF NOT EXISTS imports (id TEXT PRIMARY KEY, source TEXT NOT NULL, org TEXT NOT NULL, created_by TEXT NOT NULL,
  threshold_bytes INTEGER NOT NULL, link INTEGER NOT NULL, state TEXT NOT NULL,   -- running | done | cancelled
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS import_repos (import_id TEXT NOT NULL, full_name TEXT NOT NULL, url TEXT NOT NULL, project_id TEXT NOT NULL,
  state TEXT NOT NULL,   -- queued | running | done | machine | failed | cancelled
  job_id TEXT, message TEXT NOT NULL DEFAULT '', rewritten INTEGER NOT NULL DEFAULT 0, moved_files INTEGER NOT NULL DEFAULT 0,
  moved_bytes INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL,
  PRIMARY KEY (import_id, full_name));
```

Actions: `import-list-orgs`, `import-list-repos` (both human, read; the GitHub calls run in the Worker
before the action, the action only matches against projects), `import-start` (owner/admin),
`import-get` (read), `import-retry` and `import-cancel` (owner/admin). Routes under
`/api/v2/workspaces/:ws/imports/…` mirror them. Starting an import creates, per ticked repository and
inside one transaction: a repository project (`kind: 'repo'`, named as Add project names it: `smith.json`'s
`project.name` once read, else the repository name; branch blank until the job reports the default branch), a
`git_repos` row in state **`importing`** (uuid minted,
`source_url` the GitHub URL), the `import_repos` row, and one **`import` job**. The Artifacts
repository is created (`createRepo(repoNameFor(ws, id), …)`) and the write token minted just before
the transaction, as `startMirror` does today; a transaction that refuses deletes the repository again.
Project slots and the job quota apply; an organisation larger than the free slots is refused with the
number before anything is created.

**The `import` job.** A new `JobKind` beside `mirror` and `host`, with a spec for every OS, needing the
labels **`smith-import`** (advertised by updated agents) and **`git-lfs`**:

```ts
import: { source: { url, branch: '' }, artifacts: { remote, writeToken },                    // the bulk push goes straight to Artifacts
          smithRemote: '<origin>/git/<id>.git', lfs: { url: smithRemote, authToken: <ticket> },  // objects go to Smith's LFS
          thresholdBytes, maxRepoBytes: MAX_REPO_BYTES, original: { jobBlob: 'original.bundle' } }
```

The LFS ticket is a job-bound write ticket minted at claim (as build tickets are), scoped to
`lfs-write` for the project. On the machine (`HostedImport.cpp`, a sibling of the mirror code in
`HostedAgent.cpp`), under the job's directory:

1. `git clone --mirror -- <source> repo.git` with the machine's own login (`HostedGitAuthEnv(source,
   '')`), `GIT_TERMINAL_PROMPT=0`, fsck on transfer as the `host` job sets. Record the default branch
   from `refs/remotes/origin/HEAD`, else the repository's `HEAD`.
2. **Measure**: `git count-objects -v` size; over `maxRepoBytes` → complete with `failure:
   'oversize'` and stop (no rewrite, no LFS push).
3. **Existing LFS**: if `git lfs ls-files --all` lists anything, `git lfs fetch --all origin` into the
   mirror's LFS store so every object ever referenced is present (a missing object on GitHub fails the
   job with its oid).
4. **Large blobs**: `git rev-list --objects --all | git cat-file --batch-check='%(objectsize) %(objectname)
   %(rest)'`, keeping paths whose blob is over `thresholdBytes` (pointer files are tiny and never match).
   None → step 6.
5. **Rewrite**: `git bundle create original.bundle --all` and upload it through the job blob route
   (below); then `git lfs migrate import --everything --above=<thresholdBytes>` in the mirror (the plan's
   first agent task confirms migrate works on a bare mirror; if a git-lfs version refuses, the job clones
   the mirror into a working repository with every ref fetched, migrates there, and pushes from it; the
   spec changes nowhere else). Record the moved file count and bytes from migrate's output. Measure
   again: over `maxRepoBytes` → `oversize`.
6. **Large files to Smith**: `git lfs push --all <smithRemote>` with `lfs.url` and the ticket in the
   environment (`HostedGitAuthEnv(smithRemote, ticket)`, exactly as builds of LFS projects receive it).
   A 507 from the batch endpoint (the workspace's large-files quota) fails the job with its text.
7. **Git to Artifacts**: `git push --mirror <artifacts remote>` with the write token in the environment.
   On a failure that is not authentication or not-found, the job retries **in slices**: every branch's
   history pushed oldest-first in batches of 200 commits (`git push <remote> <sha>:refs/heads/<branch>`),
   halving the batch on a repeated failure down to 1, then the tags; this keeps each pack small enough
   for Artifacts' memory limit. A blob over 32 MB that survives (impossible after step 5 with the
   threshold capped at 32 MB, possible when the threshold was not applied) fails with "a file over 32 MB
   remains; lower the threshold or keep this repository on a machine".
8. **Report**: `commit` (the default branch's tip after the rewrite), `branch`, `smithJson` and `paths`
   as a scan report (the project needs no separate scan), `lfs: { objects, bytes }`, `rewritten`,
   `movedFiles`, `movedBytes`, `originalBundle: { size, sha256 }`.

The job's git children run with `GIT_CONFIG_NOSYSTEM=1`, an empty global config and
`credential.helper=` except the clone of the source, which uses the machine's login (the `host` job's
rule). The write token and the ticket join the redaction list.

**Job blob route.** A job may upload one named blob in parts, authorised by its lease: `POST
/api/v2/workspaces/:ws/jobs/:id/blobs/:name?part=N` (each part a 5 MiB R2 `uploadPart` as the relay's
response parts are) and `POST …/blobs/:name/complete` with the byte count and SHA-256. The workspace
object actions `job-blob-upload`, `job-blob-part` and `job-blob-finish` mirror `git-relay-upload`,
`git-relay-part` and `git-relay-finish`. The key is `backups/<ws>/<repoUuid>/original-<jobId>.bundle`
and completion inserts a `git_backups` row with `kind = 'original'`, `ready = 1`. Original bundles are
kept until the project is removed, count against `BACKUP_BUDGET_BYTES` (the card warns when the budget
is exceeded; nothing is deleted automatically), and owners and admins download them from a new route
`GET …/projects/:id/backups/:backupId` (streamed from R2 with `Content-Disposition`).

**Settlement** (`reconcileImports`, the `reconcileMirrors` pattern, run on job completion events and
from the alarm):

- `success`: the Worker checks the Artifacts repository's default-branch head equals the reported
  `commit` (`branchHead`; an Artifacts repository still importing answers 409 and is retried later).
  Then, in one transaction: `project.artifacts = { status: 'done', remote, sourceRepoUrl: <GitHub URL>,
  … }`, `project.home = 'artifacts'`, `project.repoUrl = smithRemote`, `project.branch` and `commit`
  from the report, the project's actions from the scan report through the existing mapping,
  `detachedFrom = <GitHub URL>` and `sourceRepoUrl = remote` when `rewritten` (or when the import had
  Stay linked off), the `git_repos` row to `artifacts` with tips from the advertisement, the LFS
  objects' rows already `ready` from the pushes, the import row `done` with the counts, and copy tasks
  planned. The write token is revoked.
- `failure: 'oversize'`: the import row becomes `machine`; a **`host` job** (today's, from the GitHub
  URL with the machine's login) is queued for the project, the Artifacts repository is deleted, any LFS
  objects the job pushed are swept (they belong to no history), and the row says "On a build machine:
  over 1 GB, too large for Smith's storage".
- `failure: 'repo_access'`: the existing requeue; the row says which machines could not read it.
- any other failure, `lost` or `cancelled`: the row becomes `failed` with the job's message; **Retry**
  queues a new job for that row (up to three automatic retries with 1, 5 and 15 minute delays for
  network and Artifacts-busy failures, then it waits for the button). A cancelled import cancels its
  queued jobs and deletes the Artifacts repositories and projects of rows that never finished; finished
  rows stay.

**Old agents** do not advertise `smith-import`, so they never see these jobs; a queued import job's
waiting reason says "Waiting for a machine with git-lfs and an updated agent (update DESKTOP-SEM)".

### 6. Settings, help and documentation

- Settings → Copies (§4) and the import threshold; the Large files quota and mode stay where they are.
- Project card: the home ("In Smith's storage" / "On DESKTOP-SEM") with Move to storage / Move to
  machines, the copies line, the Large files row, and for a rewritten import "History rewritten on
  import: 37 files (2.1 GB) moved to large files; original history kept" with the bundle download.
- Machine card: the Copies block.
- `help.md`: "Import from GitHub", "Where projects live" (storage versus machines), "Copies and budgets",
  and the rewrite rule in "Large files". `docs/user-guide.md` and `docs/cloudflare/operations.md`: the
  settings, the `smith-import` label, the `artifacts_tokens` table, the backup prefix for originals, the
  removed `nodes/:id/lfs` route, and that Artifacts homes take no bundle backups.

### 7. Error handling

- **Proxy**: connection failure, timeout or 5xx from Artifacts → reads fall over to a current machine
  copy, writes refuse with the storage text; 401/403 → re-mint once, then 502; over 100 MB → 413.
- **Import**: no machine with access waits; `oversize` goes to a machine; LFS quota exceeded stops the
  row with "raise the large-files quota in Settings → Copies"; Artifacts busy (409) retries; a missing
  LFS object on GitHub fails the row naming the oid; git-lfs absent never happens (the label); three
  automatic retries for transient failures, then Retry.
- **Planner**: nothing fits means an under-replicated notice, never churn; shedding moves one item per
  pass; a machine without a hosting report is skipped.
- **Upgrade pass**: a project whose Artifacts repository cannot be reached keeps its old `repoUrl`
  until the next alarm pass succeeds; nothing is marked lost on the first failure.

### 8. Security

1. The git endpoint's rules are unchanged: Basic/Bearer with Smith tokens and tickets only, cookies and
   node credentials refused, true 401 challenges, per-credential and per-IP rate limits, username
   cross-check, scopes (`read` for upload-pack, `build` for receive-pack).
2. Artifacts tokens live only in the workspace object (`artifacts_tokens`) and in the spec of an
   `import` or mirror job for its bulk push, exactly as `mirror` jobs carry one today; never in the
   dashboard, MCP or agent heartbeats; revoked when replaced, when the job ends and when the project
   is removed. Read tokens are one hour, write tokens ten minutes (two hours for a bulk push).
3. GitHub tokens never reach machines; listing and preflight run in the Worker; machines use their own
   git login.
4. The job blob route is authorised by the job's lease, keyed by the job's own uuid, size- and
   hash-checked on completion; the bundle is a server-chosen key.
5. The rewrite runs on the machine's own clone; nothing on GitHub is changed. The original bundle is
   uploaded **before** the rewrite starts, and a failed upload fails the job before any rewrite.
6. Import is owner/admin; retry and cancel too; the import panel is visible to members with read.

### 9. Testing

Workers-runtime vitest beside the existing suites:

- `git-proxy.test.ts`: the proxy against a stubbed Artifacts git server (`fetch` replaced for the
  Artifacts origin): advertisement and RPC pass-through with headers and streamed bodies; token caching
  and expiry; a 401 from Artifacts re-mints once; 5xx falls reads over to the relay and refuses writes
  with the exact texts; a successful push refreshes tips, bumps the generation and fires `copyPushed`;
  `ls-refs` and the v2 advertisement are proxied, not answered from the record.
- `copies.test.ts`: the planner as a pure function: placement by unused budget with deterministic
  tie-breaks, the reserve, target copies, repositories before large files, stale-first refresh, shedding
  one item per pass and never the last current copy or a primary, no churn when nothing fits, the
  per-machine task limits; `MAX_REPO_BYTES` exclusion.
- `imports.test.ts`: org and repository listing on `fakeGitHub` (extended with organisations, tree
  sizes and truncation), the preflight texts, "already in Smith" matching, start (projects, rows, jobs,
  Artifacts repositories, token minting, refusal rolls back), settlement for each outcome including
  `oversize` to a `host` job and LFS sweep, retry and cancel, the `smith-import` label requirement and
  the waiting reason, the job blob route (parts, completion, hash mismatch, lease checks) and the
  backup download route.
- `home.test.ts`: `copyOf` and `hasSmithCopy` on both homes, the upgrade pass over the three legacy
  shapes, Move to storage and Restore to storage, project removal deleting the Artifacts repository.
- Settings validation ranges and the node budget field.

Agent (C++) tests in `SmithHostedAgentTest`, against local bare repositories, with the rewrite steps
skipped and reported when `git lfs version` fails on the test box: default-branch detection, size
measure and `oversize`, large-blob detection with pointer files excluded, the bundle, migrate on a bare
mirror (or the working-repository fallback), the sliced push against a local `git http-backend`
configured to refuse large packs, failure classification, redaction of the token and ticket, the
`smith-import` label probe.

An end-to-end drill, `cloudflare/coordinator/tools/import-e2e.ps1`, against `wrangler dev --local` with
a local `git http-backend` standing in for Artifacts (the first-commit work already pushes to one) and
`ARTIFACTS_MODE=fake` with the fake client's remote base made configurable (`ARTIFACTS_FAKE_REMOTE`) so its
repositories resolve to that server: a repository with a 15 MB file and a 40 MB file is imported with a
10 MB threshold by a real git and git-lfs client, cloned back through the proxy, and both files smudge.

No real organisation import, no real deploy and no push to a real Artifacts account by Claude (the
safety rule in `CLAUDE.md`); the owner runs the first import.

### 10. Compatibility and rollout

- Schema version 22: `nodes.copy_budget_bytes`, `imports`, `import_repos`, `artifacts_tokens`, and
  the `importing` and `artifacts` repo states. `host_lfs` stays and mirrors `host_repos`.
- `ResolvedJobSpec` gains `import`; `JobResult` gains `rewritten`, `movedFiles`, `movedBytes`,
  `lfs` and `originalBundle`; old fields unchanged; `WireTypes.h`/`WireJson.cpp` follow.
- Old agents never see `import` jobs (label); they keep serving relays and copies.
- Rollout: merge #12 then this; deploy the Worker (the upgrade pass runs on the first alarm); update
  agents; switch machines on with budgets; Import from GitHub.

## Out of scope (v1)

Artifacts' own importer for public repositories (no machine); serving reads from a machine while
Artifacts is up (reads always go to the home); Queues event subscriptions from Artifacts; importing
from GitLab or Bitbucket organisations (the listing is GitHub's; the job is host-agnostic and a later
listing plugs in); moving a project between workspaces; a scheduled re-import of new organisation
repositories (re-open the dialog); LFS on the LAN coordinator.
