# Check-in agent scheduler implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking. Execution was subsequently authorized. The original checklist below is retained as the design record; actual implementation/verification is summarized in docs/checkin-crew.md and PR #10. Test files were consolidated and implementation commits grouped rather than following the proposed filenames and commit boundaries.

**Goal:** Extend Smith Crew to selectively review check-ins with six starter agents, bounded escalation, exact-commit execution, scoped writer coordination, and visible decisions.

**Architecture:** Keep the workspace Durable Object as the orchestrator, crew_runs as the AI work queue, and sessions.ts as the worker lifecycle. Add focused event, eligibility, scheduling-policy, lease, and finding modules inside the coordinator. The hosted C++ agent supplies pinned execution and metadata-only Git jobs; no second swarm service.

**Tech Stack:** Existing TypeScript/Cloudflare Worker and SQLite-backed Durable Object, vanilla JavaScript UI, C++ hosted agent, Vitest Cloudflare tests, native test runner, Python runtime fixtures.

**Spec:** [Check-in driven Crew orchestration design](../specs/2026-10-06-checkin-agent-scheduler-design.md). Read it before implementation; it defines policy, defaults, states, bounds, and exclusions.

## Global constraints

- Planning base is feature/cloudflare-experiment at 48cf41fb1c19bb9ff2e09a5bafcee12570937131. Worktree branch is codex/checkin-agent-scheduler. Target feature/cloudflare-experiment, never the actual main branch.
- Do not merge or deploy. Do not create, enable, run, or rely on GitHub Actions. Use local verification and explicitly authorized Smith tooling.
- Preserve unrelated changes in the original checkout, including Modules/SmithCoordinator/WebAssets.cpp.
- Keep hosted scope, JSON conventions, existing credentials, human Verify, machine opt-in, and Stop all crew. Do not expand native LAN coordinator scope or introduce dependencies/frameworks.
- Every development commit uses git commit --author="Codex <codex@example.com>". Do not change configured Git identity.
- The design's bounds and defaults apply to every task. Policy units are not USD; existing USD caps remain additional constraints.
- Existing members and agents retain their behavior. New orchestration stays off by default. Older agents cannot claim orchestration runs.
- Repository or model text is data and cannot grant capabilities. Only typed, authorized configuration and requests change scheduling.
- Do not add Codex-as-a-Crew-runtime support in this branch; use the currently supported Claude Code path.
- Code snippets below define proposed contracts and regression assertions, not claims that these APIs already exist.

## Review focus

1. Duplicate/out-of-order deliveries and force pushes: no duplicate spend, wrong-commit review, or accidental cross-branch coalescing. Tasks 2, 4, 5.
2. Lost workers and stale write leases: no accepted late report/push or overlapping writer before quarantine clears. Tasks 5, 6.
3. Omitted/truncated/renamed file metadata: never treat missing information as a harmless empty diff. Tasks 2, 3, 6.
4. Escalation cycles and crafted run tokens: no cross-workspace findings or uncontrolled child runs. Task 7.
5. Existing members, templates, old agents, and populated storage: migrations preserve behavior and rollback disables only the new scheduler. Tasks 1, 8, 10.

## Repository map and ownership

All src/, test/, public/, and tools/build-* paths below are relative to cloudflare/coordinator/. Native paths are repository-relative.

| Files | Responsibility |
| --- | --- |
| src/crew-orchestration-model.ts (new) | Event/policy/request/finding contracts and validation. |
| src/crew-events.ts (new) | Durable event intake, deduplication, metadata lifecycle, aggregate membership. |
| src/crew-eligibility.ts (new) | Pure path matching, metadata classification, and explained eligibility. |
| src/crew-scheduling.ts (new) | Pure due-time/priority rules and transactional admission ledger helpers. |
| src/crew-leases.ts (new) | Conservative prefix overlap, lease generations, renewal/quarantine. |
| src/crew-findings.ts (new) | Finding occurrences, dispositions, and bounded typed requests. |
| src/crew-orchestration.ts (new) | Small adapter wiring these modules into existing Crew hooks. |
| src/crew-model.ts, src/crew.ts | Optional member settings; existing queue and report integration. |
| src/workspace.ts, src/index.ts, src/settings.ts | Migrations, authorization, routes, alarms, workspace policy. |
| src/sessions.ts, src/ai.ts, src/contracts.ts | Claims, exact revisions, capabilities, metadata jobs. |
| src/checkin-webhook.ts, src/checkin-metadata.ts (new) | Signed provider adapter and bounded metadata loading. |
| Modules/SmithAgent/HostedCheckIn.{h,cpp} (new) | Fixed-command metadata collection and parsing helpers. |
| Modules/SmithAgent/HostedAgent.cpp, HostedAiSession.cpp, HostedCrewRun.{h,cpp} | Wire metadata jobs and scoped/pinned execution into existing transport. |
| src/mcp.ts, src/tokens.ts | Typed requests under existing run identity and authorization rules. |
| public/crew-events.js (new), public/crew.js, crew-review.js, index.html, style.css | Event/decision trace and findings within Crew. |

Do not move unrelated code solely to fit this plan. Keep helpers focused as crew.ts and workspace.ts are already substantial.

## Task 1: Add optional orchestration contracts and migrate populated storage

**Files:** Create src/crew-orchestration-model.ts, test/crew-orchestration-model.test.ts, test/crew-orchestration-migration.test.ts. Modify src/crew-model.ts, src/settings.ts, src/workspace.ts and src/crew.ts.

**Interfaces:** Export EventKind, CostClass, OrchestrationPolicy, MemberOrchestration, CheckInEvent, EligibilityDecision, AgentRequest, AgentLease, Finding. Add orchestration: MemberOrchestration | null to CrewMember; persist a versioned config snapshot per event run. Define fixture defaults in test/crew-orchestration-fixture.ts for subsequent tasks, extending test/crew-fixture.ts.

```ts
type CostClass = 'cheap' | 'medium' | 'expensive';
type EventKind = 'commit' | 'push' | 'pr_updated' | 'pr_ready' |
  'test_failure' | 'merge' | 'release_candidate' | 'manual';
type Change = { path: string; oldPath: string | null;
  added: number | null; deleted: number | null };
type Decision = 'eligible' | 'deferred' | 'skipped';
type EligibilityDecision = { crewId: string; eventId: string;
  decision: Decision; reasons: string[]; matchedPaths: string[];
  configVersion: number; policyVersion: number };
```

- [ ] Write tests using validateCrewMember and the new validateOrchestrationPolicy/validateMemberOrchestration. Assert unchanged legacy member defaults; malformed globs, negative limits, non-integer costs, NaN confidence, inconsistent mode, and invalid write prefixes fail with a field-specific 400.
- [ ] Add migration fixtures with waiting/running legacy rows. Assert these survive, legacy trigger parsing is unchanged, and migrations run twice harmlessly.
- [ ] Run: npm --prefix cloudflare/coordinator test -- test/crew-orchestration-model.test.ts test/crew-orchestration-migration.test.ts. Expect failure before the new contracts exist.
- [ ] Add orchestration JSON/revision columns; tables crew_checkins, crew_event_deliveries, crew_event_members, crew_decisions, crew_unit_ledger, crew_scope_leases, crew_findings, crew_finding_occurrences, crew_requests. Extend crew_runs with nullable event/root/request IDs and snapshot JSON. Use the next actual workspace schema version at execution time.
- [ ] Replace crew_one_waiting with one partial legacy waiting index and one waiting index for event member/aggregate ID. Preserve legacy uniqueness; event coverage belongs in crew_event_members.
- [ ] Re-run the targeted tests and existing test/crew.test.ts and test/settings.test.ts. Commit: feat(crew): add versioned check-in orchestration model.

**Representative assertion:**
```ts
expect(parseMember({ ...legacyMember }).orchestration).toBeNull();
expect(() => validateMemberOrchestration({
  ...readPolicy, mode: 'write', writeScopes: ['../auth/']
}, 'acceptEdits')).toThrow();
```
Define parseMember in the fixture as a call to existing validateCrewMember with a fixed user/time; legacyMember and readPolicy are complete baseline fixtures, not production helpers.

## Task 2: Durable event intake and verified change metadata

**Files:** Create src/crew-events.ts, src/checkin-webhook.ts, src/checkin-metadata.ts, test/crew-events.test.ts, test/checkin-webhook.test.ts, test/checkin-metadata.test.ts, Modules/SmithAgent/HostedCheckIn.h and .cpp. Modify src/index.ts, src/workspace.ts, src/contracts.ts, src/settings.ts, src/repo-projects.ts, Modules/SmithAgent/HostedAgent.cpp, Module.manifest, Tests/SmithHostedAgentTest/Main.cpp.

**Interfaces:** CrewEvents.accept(input, now) returns { eventId, duplicate }; CrewEvents.recordMetadata(eventId, expectedRevision, metadata, now) is compare-and-set. CheckInMetadata contains immutable base/head, changes, completeness, test evidence, and errors. Add metadata job kind checkin with fixed base/head and capability checkin-metadata-v1. Human route POST crew/checkins uses workspace operator authorization; provider route is separately signature-authenticated and project-bound.

- [ ] Test duplicate delivery returns the original event ID, same delivery with different content returns 409, unauthorized operator/viewer boundaries, and valid webhook signature over raw bytes. Bad signature or oversize body stores nothing.
- [ ] Test valid push, deleted branch, PR ready/update/merge mapping, and failed ordinary build intake. Preserve existing Verify/crew-created build loop exclusions. Incoming Crew-originated refs do not recursively create work.
- [ ] Test rename old/new paths, a paginated/truncated provider result, missing base history, arbitrary submitted remote, and stale metadata response after reconfiguration.
- [ ] Run the three new test files; expect failure. Implement storage-first acceptance, a retryable metadata lifecycle pending/loading/ready/blocked/ignored, and alarm retries with bounded backoff.
- [ ] Implement provider reads following existing github-reader.ts patterns. Consult current official provider documentation when implementing signature/event mapping; do not infer completeness from a single response. No network call inside transactionSync.
- [ ] Implement the native metadata job using fixed argv for fetch and git diff --name-status -z / --numstat -z with --no-ext-diff --no-textconv. Reuse registered-project transport and read credentials. Disable hooks, scripts, submodules and AI. Validate exact SHAs and cap output/time as the spec requires.
- [ ] Advertise the metadata capability and return an actionable wait reason if no compatible machine/provider access exists. Webhook configuration is opt-in with write-only secret storage following existing settings conventions; no secret appears in responses.
- [ ] Re-run tests and native helper tests. Commit: feat(crew): normalize check-ins and collect bounded diff metadata.

```ts
const first = await events.accept(pushInput, clock);
const replay = await events.accept(pushInput, clock + 1);
expect(replay).toEqual({ eventId: first.eventId, duplicate: true });
expect(await count('crew_checkins')).toBe(1);
```
The new fixture constructs events over the workspace test SQL handle; count(table) only accepts the fixture's allowlisted table names.

## Task 3: Pure eligibility with recorded explanations

**Files:** Create src/crew-eligibility.ts, test/crew-eligibility.test.ts. Modify src/crew-events.ts, src/crew-orchestration-model.ts.

**Interfaces:** classifyChanges(metadata, projectPolicy) returns facts with provenance/completeness; evaluateEligibility(memberSnapshot, eventFacts, previousFindings) returns EligibilityDecision. Export matchRepoGlob(pattern, path). No clock, network, or database in these functions.

- [ ] Write table-driven cases for documentation-only changes, authentication changes, dependency changes, module mapping, language filters, min/max diff lines, event kind, branch, and previous-finding categories.
- [ ] Cover root files under **, nested paths, case-sensitive matches, both rename paths, deleted files, unknown binary line counts, and absent test results. Missing required metadata must return deferred.
- [ ] Run npm --prefix cloudflare/coordinator test -- test/crew-eligibility.test.ts; expect failure.
- [ ] Implement a bounded glob matcher with *, ?, ** only, plus deterministic risk-rule accumulation and immutable decision facts. Persist a decision for every event-enabled candidate, including disabled/config-incompatible candidates with clear reasons.
- [ ] Add dry-run evaluation that only stores preview decisions and makes no runs, leases, reservations, or cooldown changes.
- [ ] Re-run eligibility, event and model tests. Commit: feat(crew): explain selective check-in eligibility.

```ts
expect(matchRepoGlob('Modules/**', 'Modules/SmithAgent/A.cpp')).toBe(true);
expect(matchRepoGlob('src/auth/**', 'src/author/file.ts')).toBe(false);
expect(evaluateEligibility(securityMember, incompleteFacts, [])
  .decision).toBe('deferred');
```

## Task 4: Debounce, cooldown, priority, jitter, and durable coalescing

**Files:** Create src/crew-scheduling.ts, src/crew-orchestration.ts, test/crew-event-scheduling.test.ts. Modify src/crew.ts, src/workspace.ts, src/crew-events.ts.

**Interfaces:** computeDue({ firstReceivedAt, lastReceivedAt, lastStartedAt, debounceMs, maxDebounceWaitMs, cooldownMs, jitterMs }) returns earliestStart. stableJitter(key, maxMs) returns a deterministic integer. rankCandidate(priority, waitingSince, now) returns a sortable score. CrewOrchestration.enqueueReady(now) creates/updates waiting crew_runs and CrewOrchestration.nextWake(now) returns the next meaningful alarm time.

- [ ] Test ten ancestor commits coalesce into one waiting aggregate with all delivery IDs, first base and last head; cross-branch/force-push events do not coalesce.
- [ ] Test a burst reaches maximum debounce wait, stable jitter survives restart, cooldown follows admitted starts, and a running target never changes its head.
- [ ] Test an edited policy leaves admitted snapshots unchanged; replan explicitly replaces only unclaimed work. Prevent restart alarms from spinning on permanently blocked work.
- [ ] Run test/crew-event-scheduling.test.ts; expect failure.
- [ ] Implement ordering and due-time functions exactly as the spec. Use ancestry supplied by verified metadata; unknown ancestry means no coalescing. Keep legacy enqueueDue/onJobFinished behavior for non-event members. An event-enabled member may still use its manual/interval trigger, but automatic build failure handling must select one path rather than enqueue both.
- [ ] Integrate nextWake with existing alarm scheduling; after finish/settings/node availability, revisit only relevant pending runs.
- [ ] Re-run scheduling and existing test/crew.test.ts and test/scheduler.test.ts. Commit: feat(crew): schedule and coalesce check-in runs.

```ts
expect(computeDue({ firstReceivedAt: 0, lastReceivedAt: 900,
  lastStartedAt: null, debounceMs: 200, maxDebounceWaitMs: 1000,
  cooldownMs: 0, jitterMs: 7 })).toBe(1007);
expect(stableJitter('event/member', 30)).toBe(stableJitter('event/member', 30));
```

## Task 5: Atomic admission, shared budgets, and exact-commit claims

**Files:** Modify src/crew-scheduling.ts, src/crew-orchestration.ts, src/crew.ts, src/sessions.ts, src/ai.ts, src/crew-model.ts, src/crew-prompt.ts, src/workspace.ts, Modules/SmithAgent/HostedAiSession.cpp. Create test/crew-admission.test.ts, test/crew-pinned-claim.test.ts. Extend Tests/SmithHostedAgentTest/crew_runtime_cases.py and claude_stub.py.

**Interfaces:** admitCandidate(runId, now, hooks) returns admitted sessionId or a typed waiting/skip reason. It runs inside the workspace transaction. Orchestrated claim adds orchestrationVersion: 1, eventId, baseCommit, headCommit, mode, policy snapshot, and optional lease data. All native AI execution requires crew-orchestration-v1.

- [ ] Test priority selection within event units; each class limit plus the smaller existing global limit; rolling global/member rates; unavailable machines; Stop all crew; and existing monetary cap behavior.
- [ ] Test two admissions cannot oversubscribe the last unit; idempotent finish/stop settles once; claimed failure consumes units; cancellation before claim refunds units; unknown actual cost retains a conservative reservation.
- [ ] Test coalesced allowances use max, not sum. An escalation uses the same root ledger. Legacy runs count against global machine/USD/concurrency limits but do not consume an unrelated event's units.
- [ ] Test branch moves after intake but claim/check-out still uses the original head SHA. Missing pinned head fails visibly with no tip fallback; stale/old agents cannot claim.
- [ ] Run the two new coordinator files and runtime pinning case; expect failure.
- [ ] Implement one transactional admission boundary for all ledgers and createCrewSession. Use rollback on failed session creation. Snapshot config, resolved project, budget and prompt; claim reads the snapshot instead of a subsequently edited member.
- [ ] Add native checkout of the exact head and input diff from exact base. Preserve the distinct output proposal branch. Add the feature advertisement only when the pin/scope protocol is implemented; until Task 6 lands, keep writers disabled.
- [ ] Re-run tests including test/sessions.test.ts and test/crew-no-copy.test.ts. Commit: feat(crew): enforce shared budgets and pin orchestration claims.

```ts
expect((await claimEvent(eventAtA)).headCommit).toBe(commitA);
expect(await remainingUnits(rootEventId)).toBe(3);
await finishTwice(theClaim);
expect(await consumedUnits(rootEventId)).toBe(theClaim.unitCost);
```
Add claimEvent, remainingUnits, consumedUnits and finishTwice to the orchestration fixture using existing claim/finish APIs and ledger reads; no live AI calls.

## Task 6: Reader concurrency and fenced, enforced writer scopes

**Files:** Create src/crew-leases.ts, test/crew-leases.test.ts, test/crew-scope-enforcement.test.ts. Modify src/crew.ts, src/crew-orchestration.ts, src/sessions.ts, Modules/SmithAgent/HostedCrewRun.h/.cpp, HostedAiSession.cpp, Tests/SmithHostedAgentTest/Main.cpp and crew_runtime_cases.py.

**Interfaces:** scopesOverlap(a, b) implements conservative prefixes. CrewLeases.acquire(runId, repositoryKey, branch, scopes, now), renew(runId, generation, now), quarantine(runId, now), and release(runId, generation, now) execute inside the workspace transaction. Lease claims include ID/generation/prefixes/expiry; the coordinator derives identity, never trusts caller-supplied ownership.

- [ ] Test concurrent readers, disjoint writers, parent/child conflicts, whole-repo conflicts, case variants, multiple project aliases, and all-or-nothing multi-scope acquisition.
- [ ] Test one-active-run-per-member remains; any active legacy run preserves whole-project exclusion. Read concurrency still needs available machines.
- [ ] Test expiry quarantines rather than immediately reassigns; late token/generation cannot report, renew, or authorize push; Stop all crew revokes pending authorization; lease stays held through push.
- [ ] Test native reader writes and out-of-scope writer changes fail before commit/push, including untracked/deleted/renamed files, symlink/junction escapes, .git, truncated reporting, and files beyond the display cap.
- [ ] Run coordinator lease tests and native helper/runtime tests; expect failure.
- [ ] Replace only the orchestrated admission path's project-wide busy rule with lease checks. Keep fixed upper runtime plus termination grace before quarantine clears without confirmation. Reject stale completion even if the worker claims success.
- [ ] Enforce scope through CLI permissions and independent post-run full filesystem/Git validation. A report's displayed files list cannot substitute for enforcement. Reader claims disable project creation regardless of member flags.
- [ ] Re-run scope, admission, sessions and native runtime tests. Commit: feat(crew): coordinate readers and fence scoped writers.

```ts
expect(scopesOverlap('Modules/SmithAgent/', 'Modules/SmithAgent/A/')).toBe(true);
expect(scopesOverlap('Modules/SmithAgent/', 'Modules/SmithCore/')).toBe(false);
expect(scopesOverlap('', 'web/')).toBe(true); // empty normalized prefix means whole repository
```

## Task 7: Structured findings and bounded escalation

**Files:** Create src/crew-findings.ts, test/crew-findings.test.ts, test/crew-requests.test.ts. Modify src/crew-model.ts, src/crew-review.ts, src/mcp.ts, src/tokens.ts, src/workspace.ts, src/crew-orchestration.ts, Modules/SmithAgent/HostedCrewRun.cpp, test/mcp.test.ts.

**Interfaces:** CrewFindings.ingest(runId, report, now), decide(findingId, disposition, actor, now); CrewFindings.request(sourceSessionId, { targetCrewId, findingIds, reason, requestId }, now) returns requestId/state/reason. Add MCP crew_request_review with source/root/branch/commit derived exclusively from authenticated session.

- [ ] Test additive legacy report parsing, confidence boundaries, report limits, finding fingerprint/occurrence behavior, and explicit disposition history.
- [ ] Test self/cyclic/A-to-B-to-A requests, max depth 2, max admitted runs 6, once-per-member per root, allowlist, disabled target, root budget, and idempotent request IDs.
- [ ] Test another workspace/event's finding IDs, stopped/expired run tokens, crafted source IDs, and prose crew_send containing a spawn instruction. All must create no unauthorized run.
- [ ] Run finding/request/MCP tests; expect failure.
- [ ] Extend CLI inline schema and native tool allowlist consistently. Preserve existing schema command-line safety and report caps; validate all model output server-side.
- [ ] Record requests and their acceptance/refusal reasons before enqueueing. The scheduler remains the sole admission path. High/blocking findings require human review by default; do not auto-start writers or change external branch protection.
- [ ] Re-run test/crew-prompt.test.ts, test/crew-final.test.ts and new tests. Commit: feat(crew): persist findings and budget agent review requests.

```ts
await requestReview(runA, memberB, 'request-1');
await requestReview(runA, memberB, 'request-1');
expect(await childCount(rootEventId, memberB)).toBe(1);
expect((await requestReview(runB, memberA, 'cycle')).reason).toBe('cycle');
```
requestReview and childCount are new fixture helpers invoking the typed workspace action and inspecting root ancestry; construct runA/runB as valid current claims.

## Task 8: Six opt-in templates and editable JSON policy

**Files:** Modify src/crew-model.ts, src/settings.ts, public/crew.js, public/index.html, public/app.js, docs/cloudflare/ai-chat.md. Create test/crew-templates.test.ts. Extend test/crew-dashboard.test.js and test/settings.test.ts.

**Interfaces:** Expose workspace orchestration settings, member orchestration fields and template values through existing list/put routes. Retain existing template IDs, including bug-hunter, and preserve saved member values.

- [ ] Test six starter templates create plan-mode members, no default write scopes or automatic project creation, and no agents created merely by enabling the feature.
- [ ] Test old templates and saved members are unchanged. JSON export/import round-trips exact policy values; invalid imports leave previous settings intact.
- [ ] Run template/dashboard/settings tests; expect failure.
- [ ] Add defaults from the design and forms with units, cooldown, debounce, class, filters, and explicit canRequest choices. The standard member editor must not silently clear orchestration fields.
- [ ] Explain disabled/old-agent/budget waits where the user configures the member. Mark cleanup as review by default; scoped write opt-in explicitly requires prefixes.
- [ ] Re-run tests. Commit: feat(crew): add six check-in reviewer templates and policy controls.

**Proposed member configuration example** (orchestration is nested inside the existing member body):
```json
{
  "name": "Security reviewer",
  "projectIds": ["smith"],
  "permissionMode": "plan",
  "orchestration": {
    "mode": "read_only",
    "events": ["push", "pr_ready"],
    "paths": ["cloudflare/coordinator/src/auth.ts", "cloudflare/coordinator/src/oauth.ts"],
    "cooldownMs": 600000,
    "debounceMs": 60000,
    "maxDebounceWaitMs": 300000,
    "maxJitterMs": 10000,
    "priority": "high",
    "costClass": "expensive",
    "unitCost": 4,
    "writeScopes": [],
    "canRequest": []
  }
}
```
The create form supplies the security-reviewer template and its charter. These values seed a new member; they do not override an existing one.

## Task 9: Event traces, findings UI, and bounded retention

**Files:** Create public/crew-events.js, test/crew-events-dashboard.test.js, test/crew-retention.test.ts. Modify public/crew.js, public/crew-review.js, public/index.html, public/style.css, src/index.ts, src/workspace.ts, src/crew-orchestration.ts.

**Interfaces:** crew-checkins lists paginated aggregates; crew-checkin returns event, covered deliveries, decisions, runs, requests, findings, ledger and leases; crew-finding-decide records operator disposition. Add HTTP routes under crew/checkins and crew/findings with allowlisted cursor/filter fields.

- [ ] Test viewer read/operator mutation boundaries, pagination across identical timestamps, missing/deleted member names, and secret exclusion.
- [ ] Test trace renders queued/deferred/skipped reasons, pinned commits, request ancestry, measured/unknown cost, files touched, and internal-only merge hold wording.
- [ ] Test hostile HTML in filenames/findings/messages is escaped. Test stale legacy UI saves preserve new configuration.
- [ ] Test retention keeps active/quarantined runs, unresolved findings and ancestry; terminal aggregate deletion is atomic; overflow returns an actionable retryable 429.
- [ ] Run new dashboard/retention tests; expect failure.
- [ ] Implement the Events view using current Crew section patterns and existing transcript links. Expose Dry run, Pause, and Stop through current controls, without starting new runs from a view action.
- [ ] Re-run tests. Commit: feat(crew): show check-in decisions and request traces.

## Task 10: End-to-end verification, documentation, and implementation PR

**Files:** Create test/crew-orchestration-integration.test.ts. Extend Tests/SmithHostedAgentTest/crew_runtime_cases.py. Modify docs/cloudflare/operations.md, docs/cloudflare/ai-chat.md, docs/cloudflare/agent-access.md, docs/cloudflare/progress.md. Keep this plan's checkboxes updated with actual evidence during execution.

- [ ] Add an integration fixture with six members and enough opted-in fake machines. Submit a documentation change, an auth change and a PR-ready event; assert selective decisions, budgets, class caps and exact commits.
- [ ] Run the full event -> metadata -> eligibility -> admission -> claim -> report -> request -> second review -> UI-read flow through real workspace actions and stubbed native CLI/Git processes.
- [ ] Include crash/restart, duplicate webhook/finish, force push, queued policy edit, node loss, expired/quarantined writer, Stop all crew, out-of-scope write, and migration-from-populated-state scenarios.
- [ ] Show the six agents can complete as findings-only reviewers. Separately prove an explicitly configured scoped writer produces a proposal only after a valid fenced run; no real push/deploy in tests.
- [ ] Document event sources, policy examples, metadata waits, lease quarantine, internal merge holds, limitations, and staged opt-in rollout.
- [ ] Run the verification commands below. Record actual results, failures, engine revision and tool versions; do not label unrun tests passing.
- [ ] Run a background local UI check for event navigation, explanation text, findings and settings using seeded local fixtures. Do not log into or mutate production.
- [ ] Review the whole diff against the spec and confirm only intended files changed. Commit: test(crew): verify check-in orchestration and document rollout.
- [ ] Push the implementation branch and update/open its PR against feature/cloudflare-experiment with architecture, config example, tests, limitations and follow-ups. Do not merge or deploy.

### Verification commands for implementation

```powershell
npm --prefix cloudflare/coordinator ci
npm --prefix cloudflare/coordinator run verify
.\RunTests.ps1 -Jobs 4
python Tests/SmithHostedAgentTest/hosted-runtime-test.py
git diff --check
```

The verify script includes a Wrangler deployment dry-run only. Do not invoke the deploy script. Run native coordinator tests without a competing server/test process on their port. Follow the existing runner's engine discovery and record the consumed engine revision. Dependencies may be installed at implementation time; this planning-only change does not need them.

### Logical commit discipline

Tasks 1–10 are reviewable milestones, but do not leave a task marked complete while its regression tests fail. Within each task, stage only its files and use:

```powershell
git commit --author="Codex <codex@example.com>" -m "the milestone message above"
```

## Acceptance and follow-up

Acceptance requires selective event execution, six working reviewer templates, pinned commits, bounded escalation, conservative enforced writer coordination, restart-safe accounting, backwards compatibility, and useful event traces. Trace IDs and test evidence must connect intake to final findings.

Known follow-ups: Codex Crew runtime; external GitHub merge-check publication; automatic release-provider adapters; multi-writer scope relaxation beyond literal prefixes; more agent templates; repository object formats beyond the existing SHA-1 contract. None should be slipped into this branch.

The planning PR contains only this plan and its design. Its approval does not mean runtime behavior has been implemented or tested, and it does not authorize deployment.
