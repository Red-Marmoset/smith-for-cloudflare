# Coordinator migration progress

## A0 implementation — 2026-10-04

Implemented the hosted fixture coordinator: D1 user sessions, authoritative DO
membership, one-use node enrollment and revocation, idempotent enqueue/claim,
frozen per-OS job specs, 90-second leases, fenced completion, durable events and
a retryable monotonic D1 history projection. The Worker exposes a status page
and a versioned API at the experimental origin.

Verification: 13 tests run in the Workers runtime, generated binding type checks
and Wrangler deployment dry-run passed. Tests cover cross-workspace denial,
revocation, concurrent claims, lost-response replay, stale completion, durable
reconstruction, D1 outages, polling/alarm starvation and enrollment admission.

An independent review found alarm postponement under polling and unnecessary D1
coupling on node requests. Regression tests failed before the fixes and passed
afterward. The enrollment quota is also enforced at redemption, so outstanding
codes cannot exceed the documented bound.

Decisions made for this first milestone:

- Ship a vertical slice of Tasks 1, 2 and 4 before full parity. None of those
  larger tasks is marked complete; shared C++ fixtures and native protocol work
  remain. The tradeoff is that native builds cannot connect yet.
- Seed individual, expiring test sessions through the Cloudflare management API.
  No global user credential or public bootstrap bypass is introduced. Browser
  login remains unavailable until OAuth/session integration is implemented.
- Use the current Cloudflare Vitest plugin rather than the older pool package
  named in the plan, following current Cloudflare documentation.
- Provision D1 and DO now; defer R2 until authorized logs/artifact APIs exist.
  No artifact support is claimed by the fixture service.

The existing coordinator under `C:\code\smith` is an independent LAN service.
Do not stop it as a side effect of the experiment's smoke test. The experiment
must have no tunnel, local-origin request, or dependency on that service. Record
cloud deployment IDs and job persistence as evidence of actual hosted execution.

## Live verification

Source commit `a2fa2ef1bacd2e596a9d7fca0f7b572cc8f07772` was deployed to the
Custom Domain on 2026-10-04. The [recorded smoke evidence](deployment-evidence.json)
identifies both Worker versions and the persisted job. The authenticated cloud
fixture passed concurrent claims, lease replay/renewal, completion and conflicting
result rejection. After redeployment, the job still read `success`; node
revocation then denied both credentials. Independent D1 verification found one
successful history projection and zero remaining test sessions.

A0 deployed version: `ee382e09-3e9f-466a-8b5c-1c57a6a1098a`.
The original LAN service was left running; a shutdown rehearsal was not performed.
Cloudflare execution is verified by the Worker deployment, DO persistence and
Custom Domain, with no local-origin configuration in the experiment.

Next: native HTTPS/protocol-v2 integration and browser authentication/dashboard;
complete the remaining Task 1/2/4 contract and authorization coverage alongside
those features. This is a fixture milestone, not coordinator parity.

## Interactive Windows build loop — 2026-10-04

The experiment now serves an authenticated browser dashboard and protocol-v2
Windows agents. It supports one-use invitations, secure cookie sessions/CSRF,
prepared pinned GitHub projects, capability scheduling, machine enrollment,
ordered build logs, cancellation and durable completion. Worker version
`0a6f670e-9a0e-46c0-bd5b-9bb727096243` deploys coordinator source `5d3fe62`.
Native source `9257d1a` adds HTTPS, owner-only credentials, exclusive workspace
locks, crash containment and recovery without re-execution.

Verification: all 25 Workers tests, generated type checks and dry-run passed;
all 7 native test projects passed (732 assertions), plus a real TLS/process test
covering certificate rejection, enrollment/logs/results, replay and process-tree
termination on crash. Package helper tests passed (4). Review findings for
lost-response enqueue retries, overlapping log selection and concurrent workspace
quota admission were fixed; the retry/quota regressions were observed failing
before the fix and passing afterwards.

R2 now stores the authenticated Windows release download. Build output remains in
DO SQLite for this first loop. Browser access uses individual invitations because
Cloudflare Access management was unavailable with the configured token. OAuth,
full pipeline import, inputs/artifact delivery, handoffs and native Linux/macOS
containment remain incomplete; the broader plan is not marked complete.

See [interactive build evidence](build-evidence.json) for the real dashboard job,
source revision, result and published package checksum. The coordinator is hosted
on Cloudflare; native compilation deliberately runs on the enrolled Windows
machine. The independent LAN coordinator was left running.

## Settings page — 2026-10-04

The hosted dashboard gained a Settings page. Account settings (display name,
e-mail, time zone, clock, log timestamp style, refresh cadence, follow output)
are per user in D1 via `POST /auth/profile` and migration `0005`. Workspace
settings (name, machine-offline threshold, queued-build supersede, Cloudflare
account ID and a write-only Cloudflare API token) live in the workspace Durable
Object and are writable by owners/admins only. The token is injected into
`spec.env` as `CLOUDFLARE_API_TOKEN` at claim time and never stored in a job.
Log chunks now record a receipt time so timestamps can be rendered.

Verification: 33 Workers tests (8 new: validation, redaction/keep/clear, role
gating, claim-time injection and rotation, supersede, log stamps, profile
round-trip), generated type checks and the deploy dry-run passed. A headless
Chromium run against `wrangler dev --local` exercised sign-in, both forms, a
rejected malformed token, token clearing, persistence across reload, a fake
machine posting output, and elapsed/ISO stamps in the log view. Not deployed
from this session; apply migration `0005` before deploying.

## Copy projects to Cloudflare Artifacts — 2026-10-05

Projects can now be copied from GitHub into Cloudflare Artifacts and built from
the copy (one-shot copy, then switch). The dashboard gained an **Add project**
dialog, a "Copy to Cloudflare Artifacts?" prompt after adding, and a per-project
**Copy to Artifacts** button with status. The Worker owns repository creation,
token minting/revocation and independent head verification through the Artifacts
REST API (`src/artifacts-repos.ts`), using the workspace's Cloudflare account ID
and API token from Settings; a new `mirror` job class is executed by a native
agent, which pushes the pinned commit and tags with the write token supplied only
through `GIT_CONFIG_*` environment variables. Builds of a switched project carry a
repository-scoped read token, the only credential the hosted agent accepts.
Workspace schema migration 6 adds `jobs.kind`. See
[operations](operations.md#cloudflare-artifacts-copy-a-projects-repository).

Verification (no real Artifacts call was made, per the development safety rule):
89 Workers tests (9 new, against an in-memory Artifacts fake, including the
alarm-driven retry and the failure paths), generated type checks and a deploy
dry-run; `SmithHostedAgentTest` (61 assertions) and `SmithProtocolTest` (99) pass
for the policy, env construction and wire round-trip. Not deployed: the operator
sets the `SMITH_ARTIFACTS_TOKEN` secret (or a workspace token with Artifacts
Edit), deploys, rebuilds the agent package, and runs the first real copy.

Copies default to **Smith's backend Cloudflare account** (`SMITH_ARTIFACTS_ACCOUNT_ID`
+ the `SMITH_ARTIFACTS_TOKEN` secret); a workspace that stores its own Cloudflare
token with Artifacts Edit gets copies in its own account instead, and each copy is
pinned to the account it was made in. 11 Workers tests cover the feature.

## Projects from a Git URL — 2026-10-05

Owners can add a project by pasting a Git URL. Smith reads the repo's `smith.json`
with one TypeScript reader that matches LAN Smith (parse, `discover` variants,
`classify`, branch rules, variable substitution), either through the GitHub API with
a write-only workspace token or on an agent that can clone the repo (a `scan` job).
Builds check out the branch tip and get their command from `/resolve`; agents whose
Git login is refused are skipped for an hour (or until Rescan). Spec:
`docs/superpowers/specs/2026-10-05-add-project-from-git-design.md`; plan:
`docs/superpowers/plans/2026-10-05-add-project-from-git.md`.

Verification: 153 Workers tests (the soccer-boy, senet and smith `smith.json` files
are fixtures), type checks and a deploy dry-run; all seven C++ test projects,
including a LAN parity check on the same fixtures (SmithCoreTest 498), wire
round-trips (SmithProtocolTest 104) and the scan/branch-tip policy and Git failure
classification (hosted policy 219). Dashboard checked in a browser against local
`wrangler dev`. Not deployed: deploy the Worker, then update agents.

## GitHub first, Artifacts only when the account has it — 2026-10-06

Artifacts was unavailable on the account in use, yet the dashboard offered copies
whenever credentials existed. The workspace object now asks the Artifacts API whether
the account behind the resolved credentials can use it (cached; re-checked when
Cloudflare settings change) and hides/refuses copies otherwise, so projects build
straight from GitHub. A user-facing text pass removed tool names users do not deal
with: Artifacts is "Smith's copy" (Copy into Smith / Keep a copy in Smith), a copied
project still shows the GitHub repository it came from, Ollama is "model on machine"
(LAN dashboard: "Model on agent"), and the footer no longer says "on Cloudflare".
Tools people configure themselves (GitHub, Cloudflare tokens, Claude Code, Codex,
Anthropic keys) keep their names.

Crew members no longer require Smith's copy: like a chat, a run checks the project out
with the machine's own Git login when there is no copy (crew-created projects still need
one).

## Autonomous crew — 2026-10-06

Named AI members that look after projects on a schedule (phases 0 to 5 of
`docs/superpowers/specs/2026-10-05-autonomous-crew-design.md`, on branch
`claude/autonomous-crew-2`). Members run Claude Code with the machine's sign-in (default), the
workspace's Anthropic API key or a local Ollama model, restricted to file tools and the
`crew_*` tools, and the agent pushes a proposal branch: to Smith's copy of the project with a
token minted for the push, or, for a project without a copy, with the machine's own Git login
as a chat does (Smith then cannot confirm the pushed head). The
dashboard gained the Crew section (Members, Review, Messages), a Crew card in Settings and
two toggles on each machine card. A person verifies, accepts or dismisses each proposal;
Verify is never automatic. Members can message each other and, behind a workspace setting,
create shared projects. DO migrations 10 to 14. Docs:
[operations](operations.md#crew), [AI chat](ai-chat.md#crew),
[agent access](agent-access.md#crew-tools).

Verification: Workers tests, type checks and the deploy dry-run (`npm run verify`), the C++
test projects and the dashboard test against a stand-in agent. Not deployed, and not run
against a real signed-in machine: the owner's hands-on checks are listed at the end of the
Crew section of [AI chat](ai-chat.md#crew). Deploy the Worker, update agents, then run them.

## Smith-hosted repositories, milestone 1 — 2026-10-06

Smith is now its own git host: a project's copy lives on the workspace's build
machines (those an owner or admin switched on with **Keep copies of repositories
here**) and is reached only through the coordinator at
`https://exp.redmarmosetstudios.com/git/<project>.git`, with a Smith token as the
password (`read` clones, the existing `build` scope pushes). Nothing on a machine is
exposed: each git RPC is relayed through an R2 mailbox (`smith-experiment-git`) to the
machine's git thread, which serves it with `git upload-pack` / `receive-pack`
`--stateless-rpc` on a bare store and uploads the response in 5 MiB parts. An
agent-provisioned `update` hook enforces the credential's ref policy (default branch
protected from force-push and deletion, `refs/smith/*` reserved, crew runs limited to
their branches). Builds on the hosting machine clone the local store when the
coordinator names it with the expected tip; everything else gets a short-lived,
machine-bound ticket through `GIT_CONFIG_*` with credential helpers off. The dashboard
gained the per-machine switch with its reason, the Clone dialog with never-expiring git
credentials, and "Copy into Smith" that is always rendered and says what would enable
it; Artifacts stays as the fallback where an account has it. Spec:
`docs/superpowers/specs/2026-10-06-smith-hosted-git-design.md`; plan:
`docs/superpowers/plans/2026-10-06-smith-hosted-git.md`. Decisions taken with the owner:
push uses the `build` scope, git credentials last until revoked, hosting is a
per-machine switch.

Verification: 322 Workers tests (27 files; 13 new in `git-host.test.ts` covering auth,
username and scope refusals, the relay lifecycle with a fake machine, expired writer
relays with late tips, host jobs and the `repoUrl` switch, claim-time tickets and the
local fast path), `npm run typecheck` clean. Native: the new `HostedGitHost`,
`HostedGitRelay`, `HostedTransport` and the `HostedAgent` changes compile (g++ syntax
checks against the module headers); a Linux harness ran the real-git checks that are
now in `SmithHostedAgentTest` (advertisement, v2 `ls-refs` RPC through
`stdinFile`/`stdoutFile`, every hook refusal on real pushes: 50 checks) and the pure
checks (79). `RunTests.ps1`/`RunTests.sh` could not run in the development container
(no engine checkout); run them before publishing the package. Not deployed: create
the `smith-experiment-git` bucket and its two lifecycle rules, deploy the Worker,
publish the Windows package, hand-build the macOS/Linux packages, switch a machine on,
copy a project, clone it from a laptop, push a branch, force-push the default branch
and see it refused. Milestones 2 (R2 backups and restore), 3 (replication and
failover) and 4 (polish) follow.

## Smith-hosted repositories, milestones 2 and 3 — 2026-10-06

Copies, failover and backups. Every machine switched on for hosting now holds a copy of every
hosted repository (up to five), fetched from the primary through the coordinator with a
machine-bound ticket after each push (`replicate` tasks handed out on `git/poll`, one per machine
at a time, leases renewed by polls, capped backoff); a copy is current only when its tips equal
the record, and reads are served from current copies when the primary is away. The newest
current copy is promoted when the primary is gone (offline past the threshold, switched off,
revoked, drained, or without the label), at once for a push and otherwise on the alarm; the old
primary syncs when it returns and keeps aside under `refs/smith/recovered/*` whatever it held
beyond the record, listed on the card with Push it / Discard. The primary bundles each repository
into the `GIT` bucket (a full weekly, incrementals five minutes after pushes, verified, uploaded in
parts, recorded when whole; two fulls with their chains kept within 8 GB). A lost repository is
restored automatically (or on request) onto a machine that keeps copies, becoming hosting when the
bundles equal the record and degraded (pushes refused, reads served) when the record is newer,
until an owner accepts the restore or a machine with the newer refs returns. Switching a machine
off moves its copies to a trash folder purged after a week.

Verification: 428 Workers tests (18 in `git-host.test.ts`; the five new ones drive two and three
fake machines through replication with a stale copy after a push, a read served by the copy while
the primary is away, promotion on a push with the old primary coming back and its recovered ref
pushed through a write ticket, a full bundle uploaded in parts and restored onto a fresh machine
after the primary was switched off, a restore behind the record refused pushes until accepted, and
retention arithmetic), `npm run typecheck` clean. Native: `HostedGitTasks` and the new
`HostedGitHost` helpers compile; a Linux harness ran the real-git checks now in
`SmithHostedAgentTest` (replicate from a local primary, a force-push there leaves the copy's lost
commit under `refs/smith/recovered/*`, full and incremental bundles restore into a store equal to
the primary, discard and trash purge: 46 checks). `RunTests.ps1`/`RunTests.sh` still cannot run in
the development container; run them before publishing. Not deployed, as above; after deploying,
switch a second machine on and watch it copy, then stop the first and push.

## Artifacts REST calls reach Cloudflare — 2026-10-06

Every Artifacts REST call passed `redirect: 'error'` to `fetch`, and the Workers runtime
rejects that before sending. So with a workspace's own Cloudflare token, the capability check
answered "unknown", the copy fell back to "unavailable", and nothing reached Artifacts. The
in-memory fake bypassed `fetch`, so the tests missed it. The fix is `redirect: 'manual'`, as
the GitHub and OAuth clients already use. `test/artifacts-rest.test.ts` now runs the REST
client in the Workers runtime against the documented API shapes, so a fetch option the runtime
rejects fails there. Smith's own account goes through the binding (above) and was not affected
once that landed.

## Smith-hosted repositories, milestone 4 — 2026-10-06

Two pieces of polish. **Linked repository:** a Smith-hosted copy has the same Pull / Push /
Detach buttons as an Artifacts copy (`copyOf` describes either kind); a pull is a mirror job whose
target is the Smith remote with a job-bound write ticket for the branch and tags, relayed to the
primary and confirmed against Smith's own record; a push clones the machine's own copy (or a
claim-time ticket) and pushes to the linked repository with the machine's Git login. **Faster
clones:** with protocol v2 the coordinator answers the capability advertisement and the `ls-refs`
request from its record (agents now report peeled tag targets with every tips report), so a clone
costs one relay round trip instead of three; `fetch`, pushes and v0 stay relayed.

Verification: 543 Workers tests after merging upstream's check-in crew scheduler, plus the new
hosted sync and record-answered cases in `git-host.test.ts`; type check clean. Native: the peeled
column in `HostedGitParseTips`/`HostedGitStoreTips` compiles and the Linux harnesses (hook and
serve, tasks) pass with an annotated tag in the fixture. Still not run here: `RunTests.*`, and
every operator step listed above.

## Shared repository store per machine — 2026-10-09

A connected machine serves every workspace its owner is in, and the same project is
often in several of them; until now each job and each chat cloned the repository from
the remote again, and job directories were never removed. The hosted agent now keeps
one bare store per repository under `repos/` (keyed by the canonical repository URL:
workspace, project and job play no part), fetches only what changed into it, and makes
every job and chat checkout a local clone of the store (objects hard-linked, `origin`
pointed back at the real remote). A machine's own copy of a Smith-hosted repository is
still cloned directly when it holds one; the store serves everything else, the
coordinator's relay of a Smith-hosted repository included. A first scan of a repository with no store keeps its shallow blob-less clone. Module
`HostedRepoCache`; tests in `SmithHostedAgentTest` against a local remote.

Verification: the new C++ tests (URL canonicalisation, shared store across two
spellings of one repository, hard-linked objects, pick-up of later commits, rebuild of
a corrupt store, a failed first fetch leaving no store). Not yet run on a Windows
agent: the Windows runtime fixture (`hosted-runtime-test.py`) covers the refused-
repository log lines, which are unchanged.

## Build on push — 2026-10-09

Projects added from a Git URL can build on a push: **Build on push** on the card registers
a GitHub push webhook through a member's GitHub link (manual URL + secret only as the
fallback), deliveries are HMAC-checked inside the workspace object, and the `smith.json`
`webhook` triggers for the branch say what to build (`src/push-builds.ts`, the
`push-builds` and `push-delivery` workspace actions, `/api/v2/hooks/github/...`). Smith's
own `smith.json` gained the `deploy-experiment` product (tests, then
`DeployWorker.bat --unattended`, which never logs in or pauses) and a webhook trigger for
it on `feature/cloudflare-experiment`, so a push to that branch redeploys the coordinator
and publishes the agent package; agents then update themselves. Docs:
[operations](operations.md#build-on-push).

Verification: Workers tests (`test/push-builds.test.ts` plus the fixture update), type
checks and the deploy dry-run. Not run: the C++ test projects (no engine on the build box
used; `SmithCoreTest`'s fixture product count was updated to 6) and any real deploy. The
owner's hands-on steps: label the Windows agents that may deploy `smith-deploy` (the
deploy rule is `serial`, so they never overlap; DO migration 19), put the Cloudflare API
token in Settings (or `wrangler login` on that machine), add the Smith project from its
Git URL on the branch, press **Build on push**, push.

## Chats push as they go — 2026-10-09

Phase A of `docs/superpowers/specs/2026-10-09-chat-branches-and-review-design.md`. A chat
reply that committed is now pushed by itself: Smith queues the chat's own push turn on the same
machine (request IDs `auto-push-<seq>`), with the same refspec, Git login or one-push token and
operator-role rule as the Push button; the next message waits for it. What the button refuses
(a guest's chat, a copy of the project without the role, an older agent) is noted in the chat
with its fix. **Keep this chat on my computer only** in the chat's menu (`localOnly` on
`POST /ai/sessions/:id/update`, DO migration 18) switches it off per chat. Branches are named
after the chat, `smith/ai-<slug>-<8 hex>`, on agents that report the `named-branches` feature
(older agents keep `smith/ai-<8 hex>`). Every message turn carries a `briefing` the agent hands
Claude Code as `--append-system-prompt` and Codex ahead of its first message: the project, branch
and base commit, that Smith commits and pushes, what the person can build, and not to push or
deploy. The agent refuses a briefing that could read as a flag or is not plain text.

Verification: 549 Workers tests (sessions: auto-push, kept-local chats, a viewer's chat on a copy,
an older agent's note, named branches, the briefing on message turns only), type check and the
deploy dry-run; `SmithHostedAgentTest` for the argv, briefing and branch-name helpers. Not
deployed, and not yet run with a real CLI: deploy the Worker, update agents, then start a chat
and watch the push step appear after the first reply.
