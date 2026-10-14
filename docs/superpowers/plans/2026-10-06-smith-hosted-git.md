# Smith-hosted git Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Smith is the git host for a project: copies live on the workspace's build machines (switched on per machine), are served only through the coordinator at `https://exp.redmarmosetstudios.com/git/<project>.git`, replicate to every switched-on machine, are backed up to R2 for free, and come back after a lost machine.

**Architecture:** The Worker gains `src/git-route.ts` (the public smart-HTTP endpoint and the node relay routes), `src/git-host.ts` (tables, `HostedGit` state helper, eligibility, ref policy, host job specs) and `src/git-workspace.ts` (`GitOps`: relay waiters, poll, tips, tickets, host jobs). The hosted agent gains `HostedGitHost` (pure rules and store operations), `HostedGitRelay` (the git thread) and `HostedTransport` (the curl transport with downloads and part uploads). The dashboard gains the per-machine switch, the copy row and the Clone dialog.

**Tech Stack:** TypeScript on Cloudflare Workers (vitest in the Workers runtime, `npm run verify`), C++ on the Una engine (`RunTests.ps1` / `RunTests.sh`, `Tests/SmithHostedAgentTest`), vanilla ES modules for the UI.

**Spec:** [docs/superpowers/specs/2026-10-06-smith-hosted-git-design.md](../specs/2026-10-06-smith-hosted-git-design.md).

## Global Constraints

- Agents never accept inbound connections and have no TLS of their own: every hop is a `curl` request the agent makes (`HostedTransport`).
- No credential in argv, `.git/config` or forwarded output; tickets travel only as `GIT_CONFIG_*` extra headers scoped to one repository, with `credential.helper` switched off.
- Per `CLAUDE.md`: never a real clone, push, copy or deploy against the live coordinator during development; Workers tests drive the relay with a fake machine, native tests run real git against local bare stores.
- Platform code only in `*_Windows.cpp` / `*_Posix.cpp`; new C++ files in `Modules/SmithAgent/Module.manifest`; 800-line soft limit; no wx outside `SmithTray`.
- Deploy order per milestone: bucket/lifecycle (once), Worker, then the agent package; old agents never advertise `smith-git-host` or `smith-git-client`, so nothing new reaches them.

## Milestone 1: host and serve (done 2026-10-06)

- [x] Worker: `git-route.ts` (auth, rate limits, gzip caps, R2 mailbox, wait, stream, pkt-line errors), `git-host.ts`, `git-workspace.ts`, dispatch in `workspace.ts`/`index.ts`/`linked-nodes.ts`, tokens (`git-read`, `git-write`, `expiresInDays: null`), `isCredentialedRemote`, `hasSmithCopy`, `smith-git-client` on hosted-project jobs, `wrangler.jsonc` bindings (`GIT`, `GIT_RATE`, `GIT_FAIL_RATE`); 13 tests in `test/git-host.test.ts`.
- [x] Agent: `Process::stdoutFile`; `HostSpec`, `hostedUuid`, `tip` on the wire; `HostedTransport`, `HostedGitHost`, `HostedGitRelay`; labels, `hosting` heartbeat, git thread, host job, local fast path, job-directory pruning, update gating; policy for Smith remotes and tickets; tests in `SmithHostedAgentTest` (pure + real git), `SmithProtocolTest`, `SmithCoreTest`.
- [x] Dashboard: copy row with Clone, per-machine switch and reason, Clone dialog with never-expiring credentials, token section rename, `host` jobs labelled, Artifacts as fallback.
- [x] Docs: operations (API rows, "Smith-hosted repositories", bucket commands), progress, agent-access, README, experiment README, this spec and plan.
- [ ] Operator: create `smith-experiment-git` with its two lifecycle rules, run `RunTests.ps1`/`RunTests.sh`, deploy the Worker, publish the Windows package, hand-build macOS/Linux packages, switch a machine on, copy a project, clone and push from a laptop, see a force-push of the default branch refused.

## Milestone 2: backups to R2 and restore (done 2026-10-06)

- [x] Worker: `backup`/`restore` tasks in `git_tasks` handed out on `git/poll` after relays (`src/git-tasks.ts`), the `git-task-*` actions and the `git/task/:id/{body,part,complete}` routes authorised by the task lease (`src/git-task-route.ts`), two-phase `git_backups` manifests (reserved at queue time, `ready=1` once the object's size matches), retention (two newest fulls plus their chains) within the 8 GB budget with R2 deletes after the transaction, weekly fulls and debounced incrementals, automatic restore of lost repositories (or after a day offline with no current copy) and `git-restore` on request, `degraded`, `git-accept-dataloss` refused while an online copy holds the newer record.
- [x] Agent: `HostedGitTasks` (`git bundle create --all [^base]`, a full when the base is gone, `bundle verify`, SHA-256 up to 256 MiB, parts upload; restore into `<store>.restore-<task>` with per-bundle verify and `fetch '+refs/*:refs/*'`, manifest-driven deletions, `HEAD` from the record, `fsck --connectivity-only`, swap never over an existing store).
- [x] Dashboard: copies current, "backed up N ago" / "not backed up yet", work in flight, lost → Restore from backup, degraded → Accept the restore.
- [x] Tests: retention and chain arithmetic, full bundle uploaded in parts and restored onto a fresh machine, restore behind the record → degraded, pushes refused, Accept; C++ bundle round trip with real git.
- [x] `DeployWorker.bat` refuses to deploy until the `smith-experiment-git` bucket exists and prints the create and lifecycle commands.

## Milestone 3: replication, failover, divergence (done 2026-10-06)

- [x] Worker: `replicate` tasks with capped backoff for every switched-on machine (five copies, placement by free disk), reads served by current copies, promotion when the primary is unavailable (offline, switched off, revoked, drained, label lost; at once on a push, else on the alarm), `git_recovered` with Push it / Discard (`promote` pushes through the relay with a write ticket for that ref), `discard` tasks on switch-off, per-repo copies on the card.
- [x] Agent: `git fetch --prune --atomic --no-tags` with `+refs/heads/*:refs/heads/*` and `+refs/tags/*:refs/tags/*` and the task's ticket (never relayed to itself); refs the copy held beyond the record kept under `refs/smith/recovered/<time>/*` (not an ancestor of the new tip and contained by no other ref); tips after every sync; `discard` to `git/trash/`, purged after seven days.
- [x] Tests: a push marks copies stale and re-queues replication; a copy is current only on equal tips; the primary away → a read goes to the copy, a push promotes it; the old primary returns, syncs and its recovered ref is pushed with a ref-scoped write ticket; C++ divergence check with a real force-push.
- [ ] Later: project delete → `discard` tasks and backups kept 30 days; "machines current" count on the machine card; a primary's out-of-band changes flagged on the card.

## Milestone 4: polish

- [x] Idle polling stops: the heartbeat's `gitHost` is true only while the machine is switched on and able somewhere or still owes a task.
- [x] Pull / Push / Detach for Smith-hosted copies: `copyOf` in `src/upstream.ts` describes either copy kind; pulls carry a job-bound write ticket and are confirmed from the record; pushes use the claim-time ticket or local copy; the card shows the same buttons (`copyOf` in `public/repo-projects.js`); the agent's mirror validation accepts Smith's copy as a target with a ticket.
- [x] `ls-refs` and the v2 advertisement answered by the coordinator from the record (`parseLsRefs`, `lsRefsLines`, `v2Advertisement` in `src/git-host.ts`; `git-advertise` / `git-ls-refs` actions; agents report peeled tag targets with every tips report, kept in `git_repos.peeled_json`).
- [ ] `bundle-uri` bootstrap from R2; streaming instead of the mailbox if latency matters; optional scheduled re-sync from `sourceRepoUrl`.
- [ ] `hosted-runtime-test.py` (Windows): a relay case that clones and pushes against the fake coordinator through the real agent.
