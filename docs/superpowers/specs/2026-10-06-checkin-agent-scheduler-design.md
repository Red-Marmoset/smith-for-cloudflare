# Check-in driven Crew orchestration design

Date: 2026-10-06
Status: implemented in PR #10 after subsequent authorization. See docs/checkin-crew.md for local verification and rollout. No deployment.
Base: `feature/cloudflare-experiment` at `48cf41fb1c19bb9ff2e09a5bafcee12570937131`.
Working branch: `codex/checkin-agent-scheduler`.
PR target: `feature/cloudflare-experiment`; do not merge.

## Purpose and completion criteria

Extend Smith's hosted Crew so a repository check-in wakes only relevant agents, with an explainable decision for every candidate. Readers produce structured findings; writers need exclusive permission for their declared scope. All escalation passes through Smith's scheduler and shares the initiating event's budget.

The original attachment requested a plan; the subsequent request authorized implementation immediately. This design records the intended architecture. The eventual implementation is complete when six representative agents work through real hosted claims at pinned commits, the scheduler survives retries and restarts, and the dashboard explains each run or refusal. Merely adding prompts is insufficient.

## Existing implementation to preserve

The hosted coordinator already uses SQLite-backed Durable Object storage. Extend it; do not add a database, service, broker, or framework. The native LAN coordinator is outside this change.

| Existing component | Reuse and required change |
| --- | --- |
| `src/crew-model.ts` | CrewMember is the agent definition. Extend its JSON validation and templates; do not create a competing AgentDefinition registry. |
| `src/crew.ts` | crew_runs is the run queue. Extend admission/promotion and migrate its one-waiting-row-per-member index. |
| `src/sessions.ts` | Preserve AI turns, machine claims, event streams, stop handling, stale-token checks, and message/push separation. |
| `src/workspace.ts` | Preserve workspace authorization, transactional state changes, schema migrations, alarm scheduling, and external I/O outside transactions. |
| `src/settings.ts` | Extend existing JSON workspace settings and member configuration. Do not introduce YAML. |
| `src/crew-review.ts` | Preserve proposals and human Verify/Accept/Dismiss. Add normalized findings without losing existing reports. |
| `src/crew-messages.ts`, `src/mcp.ts` | Keep chat messages as attributed text. Add a distinct typed escalation tool; prose messages never schedule agents. |
| `Modules/SmithAgent/HostedAiSession.cpp`, `HostedCrewRun.*` | Extend restricted execution and claim material for exact commits and write scopes. |
| `public/crew.js`, `crew-review.js`, `crew-messages.js` | Extend the existing Crew UI with events, decisions, findings, and requests. |

Source paths above are relative to `cloudflare/coordinator/` unless rooted at `Modules/`.

At this base, triggers are manual, interval, or buildFinished; admission serializes the whole primary project; member clones are reused; findings are embedded in reports; tool is claude-code and Codex crew execution is explicitly unsupported. This plan does not add a new model-provider runtime. Codex can implement the feature while Smith continues using its supported Crew runtime.

## Architectural choice

Extend Crew in small modules sharing the same workspace transaction and existing queue. A separate swarm service would duplicate identity, leases, spend accounting, and UI. Prompt-only collaboration would leave races and runaway requests unresolved. Neither is appropriate here.

Flow:

```text
authenticated check-in -> durable event -> metadata -> eligibility decisions
 -> waiting crew_runs -> transactional admission -> existing AI session/claim
 -> report/findings -> explicit requests -> same scheduler and event budget
```

## Event contract and intake

CheckInEvent contains id, projectId, repositoryKey, branch, baseCommit, headCommit, kind, source, deliveryId, receivedAt, metadataState, changes, testState, risk, originRunId, and policyVersion. Repository identity is resolved from a registered Smith project, never from an arbitrary submitted URL. Each event has one immutable target commit; branch is context, not a substitute for that commit.

Supported normalized kinds: commit, push, pr_updated, pr_ready, test_failure, merge, release_candidate, manual. The first implementation supplies:
- An operator-authorized workspace action for manual/check-in submission, including commit events from an explicitly configured integration.
- A signed, project-bound GitHub webhook adapter for push and pull-request events. Verify the raw-body signature before parsing or storing; accept supported actions only. A merged PR emits merge; ready-for-review emits pr_ready.
- Internal test_failure events for ordinary failed Smith builds, preserving the existing exclusions for Crew Verify and Crew-created project builds.
- Manual release_candidate submission. Automatic release-provider integration is follow-up work.

Do not install Git hooks automatically. Hooks or integrations only submit events; they never launch agents. Repository content cannot enable agents, grant permissions, increase budgets, or configure its own webhook secret.

Persist intake before replying. Enforce delivery uniqueness per project/source and a normalized semantic key for equivalent retries. One push is one range event, not an unbounded run per constituent commit. Different branches remain distinct. Record branch deletion as ignored; never interpret an all-zero hash as executable work.

Metadata is verified against the registered repository: changed paths including both sides of renames, additions/deletions, language, configured module ownership, dependency-file changes, test state with provenance, and deterministic risk signals. Payload path lists are hints until verified. Provider pagination/truncation and missing history must produce visible incomplete metadata, never an empty successful diff.

Use GitHub reads when existing workspace credentials permit them. For Artifacts or other Git remotes, use a metadata-only job through Smith's existing job/claim transport, with a new capability label. It runs fixed Git commands without repository scripts, hooks, external diff drivers, textconv, submodule updates, or an AI CLI. Fetch exactly the required commits, with bounded history expansion; no branch-tip fallback. A missing commit or unsupported machine leaves a visible blocked event.

Bounds: 256 KiB intake body, 20,000 changed paths, 512 UTF-8 bytes per path, 10 MiB metadata output, and 60 seconds per metadata attempt. Reject traversal, absolute paths, NUL/control characters, and malformed hashes. Exceeding bounds marks metadata incomplete and prevents automatic writers. Store SHA-1 commits consistently with Smith's current 40-hex contract; broader object formats are follow-up.

## Agent configuration and eligibility

Add optional orchestration configuration to CrewMember, leaving existing members unchanged. Presence opts a member into event scheduling. Existing permissions remain authoritative: read_only maps to plan; write maps to acceptEdits. Contradictory mode/permission settings are rejected, not silently reconciled.

Configuration includes event kinds, branch/path/language/module filters, min/max changed lines, risk threshold, dependency filters, previous-finding categories, cooldown, debounce, maximum debounce wait, jitter, priority, cost class, unit cost, write scopes, and canRequest member IDs.

Across filter dimensions use AND; within a dimension use OR. Omitted dimensions match all. Unknown required metadata yields deferred, not a false match or false negative. Path globs support only *, ?, and ** with explicit case-sensitive, repository-relative slash semantics; no executable regex or brace expansion. Match both old and new rename paths. Module mapping and risk rules are operator-controlled project policy, not inferred from arbitrary source text.

Return a persisted decision per candidate with eligible, deferred, or skipped, stable reason codes, relevant matched facts, and policy/config versions. Dry-run evaluates without creating AI turns, claiming writer leases, consuming budget, or changing cooldowns. A facts hash and config revision make replay explainable.

## Scheduling and budgets

Retain crew_runs and existing run states. Add eventId, rootEventId, requestedByRunId, requestDepth, orchestration snapshot, and decisionId. Legacy runs keep null event IDs.

Separate a run's immutable snapshot from the mutable member. Queued changes require explicit cancel/replan; editing configuration must not silently change an admitted run's permissions, cost, prompt, or target commit.

Coalesce only waiting events for the same member/project/branch/event class. Preserve every covered event ID, first base, and last head. Coalesce only verified ancestor chains; force pushes and divergent histories remain distinct. Once a run is admitted it cannot be retargeted. A running member may have one pending coalesced range per verified ancestry chain and event class on a branch; divergent chains remain separate bounded waiting entries. Only roots with no admitted run or accepted escalation may coalesce. Aggregate budgets use the maximum constituent event allowance, never their sum; escalations share that aggregate.

Use earliestStart = max(lastReceived + debounce, lastStarted + cooldown) + stableJitter, with debounce capped by firstReceived + maxDebounceWait. Jitter is derived once from a stable key and stored. Priority is high=100, normal=50, low=0 with age bonus capped at 100; tie-break by due time then durable sequence. All times are server UTC milliseconds. Inject time in pure policy functions.

Default policy is proposed and configurable:
- Cost-class concurrency: cheap 8, medium 3, expensive 1.
- Existing workspace concurrency remains an additional cap; retain its current default rather than increasing it implicitly.
- Event units: low-risk 3, normal 8, high-risk 15, pr_ready 25, release_candidate 50.
- Member and global start-rate limits: existing runsPerDay plus a proposed global 60 starts per rolling hour.
- Each request chain: maximum depth 2, maximum 6 admitted runs, each member at most once per aggregate.

Event units are scheduling weights, not dollars. Preserve existing USD reservation/spend controls, model limits, machine opt-in, max duration, and Stop all crew. Admission atomically reserves units, USD, concurrency, rate capacity, and any writer lease before creating a session. Offline work consumes none until admitted.

Refund units only if no worker claimed the run; claimed work consumes units even on failure, preventing free retry loops. Release concurrency when terminal, retain actual or conservatively reserved monetary cost when unknown. Duplicate finishes, stop, crash recovery, and push transitions must settle exactly once.

## Read concurrency and write leases

Readers may overlap on the same project when machine/workspace/class limits allow. Keep one active run per member because the current native member checkout is reused. Per-machine limits still apply. Writers use an isolated member checkout and obtain a lease keyed by canonical repository identity, target branch, and scope.

Initial lease scope language is deliberately conservative: whole repository or literal directory prefixes (for example Modules/SmithAgent/). A parent prefix conflicts with its children; disjoint prefixes may run together. Arbitrary globs are eligibility filters, not lease scopes. Multiple scopes are acquired atomically in sorted order. Treat case variants as overlapping for leases across supported OSes. Two project aliases for the same repository do not bypass the lock.

Lease record: id, repositoryKey, branch, prefix, holderRunId, generation, expiresAt, state. Renew only from a current AI turn. Generation fencing is checked on claim, report/finish, and push authorization. Stop or expiry rejects late responses. Lost leases become quarantined until the worker confirms termination or its bounded max runtime plus grace expires; do not immediately grant an overlapping writer while a disconnected process might still run.

Native execution restricts editing to leased prefixes, denies .git/control/input access, and examines the complete NUL-delimited changed-file set (tracked, deleted, renamed, untracked) before commit. Out-of-scope writes fail the run and produce no proposal push. Path checks account for symlinks/junctions and platform case behavior. The lease is a coordination mechanism; do not claim it is an OS sandbox. Readers must leave the checkout unchanged and must never create projects or push.

Hold a writer lease across its separate push turn until terminal settlement. A conservative cleanup timeout is not permission to publish stale work. If exact pinning or scopes are unsupported by an older agent, show “agent update required”; do not silently fall back.

## Findings and escalation

Extend the existing report schema additively with confidence [0,1], category, files, and blocking. Existing title/detail/file fields remain accepted. Persist normalized findings with source run/event, headCommit, fingerprint, lifecycle, and timestamps; retain crew_reports as the proposal/report envelope. Do not invent confidence for old findings: null means unreported.

Fingerprint uses project, category, canonical file list, and normalized title; evidence is versioned per commit. Repeated reports update occurrences, not create endless duplicates. Resolved/dismissed findings stay auditable; a newer clean run does not automatically erase unresolved findings.

Possible dispositions: no_action, second_review, fixer_requested, merge_blocking, human_review. Defaults are human_review for high severity/blocking and informational for lower severity; no automatic fixer. “Merge blocking” is an internal review hold on this commit. External branch-protection checks are not part of this branch and the UI must say so.

Add crew_request_review(targetCrewId, findingIds, reason, requestId). Derive requester, root event, project, branch, and pinned commit from the run token. Require canRequest, compatible target project/config, current lease, and referenced findings belonging to that event. Resolve request IDs idempotently; refuse cycles, self-requests, exhausted depth/run/unit budgets, and disabled targets. Accepted requests enter the existing queue and have their own eligibility/admission trace. They never invoke a CLI directly. Plain crew_send remains non-executable chat.

## Six starter agents

Create six opt-in templates, all read-only by default. Preserve current templates and existing members without rewriting them.

| Template | Units | Class | Purpose |
| --- | --- | --- | --- |
| standards-reviewer | 1 | cheap | Check changed code against repository conventions. |
| cleanup-reviewer | 1 | cheap | Identify local dead code and needless duplication; propose bounded fixes. |
| bug-hunter | 2 | medium | Find concrete regressions in changed behavior. |
| test-reviewer | 2 | medium | Identify missing regression coverage and failure cases. |
| security-reviewer | 4 | expensive | Review configured sensitive paths and dependency changes. |
| architecture-reviewer | 5 | expensive | Review configured module boundaries and significant structural changes. |

Existing bug-hunter is reused as a template identity with optional event defaults only on newly created event members. Security can request test-reviewer or architecture-reviewer only when explicitly configured; no implicit all-to-all edges. An operator may configure cleanup or another member as a scoped writer, but the installation does not enable writes. Prove writer machinery with a separately configured test member.

## Observability, compatibility, and rollout

Add an Events view under Crew with root event, exact commits, coalesced deliveries, selection/skips, queue reason, run status, units reserved/consumed, measured cost or “unknown”, lease state, request ancestry, findings, and files touched. Reuse the transcript renderer and Review view. Escape all repository, model, and user text. Viewers read; operators manage members/events/decisions; owners/admins control workspace budgets and integration secrets.

Retain at most 1,000 completed event aggregates for 30 days; never prune active runs, unresolved findings, or request/lease references they need. Paginate decisions and findings. Prune aggregates transactionally with their terminal children and report counts; cap pending intake at 1,000 with retryable 429 responses. Unresolved findings cap at 5,000; stop new autonomous intake visibly rather than silently dropping them.

Ship disabled by default behind a workspace orchestration toggle. Add capability crew-orchestration-v1 for AI agents and a separate metadata-job capability. Roll out metadata/dry-run first, then readers, then explicitly scoped writers. Existing interval/manual/buildFinished members retain behavior and old agents continue serving them. Existing whole-project serialization remains in force when an active legacy run has no scope metadata.

No merges, real deployments, GitHub Actions, new autonomous project creation, automatic Verify, external merge checks, or dozens of extra agents in this work. The implementation PR must report test evidence and remaining manual rollout checks.
