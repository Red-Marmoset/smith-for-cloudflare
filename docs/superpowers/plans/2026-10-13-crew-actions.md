# Crew actions implementation plan

Goal: implement the user's approved finding actions, project automation modes, new roles,
and bounded verification, then merge into feature/cloudflare-experiment.

Architecture: extend the existing check-in scheduler rather than create a second execution
path. Store project automation in orchestration.projectRules[projectId].automation.
Finding actions capture evidence and exact commits, enqueue scoped writer members, and
retain an audit record. Verification uses existing secretless pinned Smith builds, with
a required crew-verify-isolated machine label, a duration cap and attempt cap.

Defaults: mode report_only; fixerCrewId/testCrewId null; maxFixAttempts 1;
verification { enabled:false, maxAttempts:1, timeoutMinutes:10 }.
Modes: report_only records findings; suggest permits human-requested actions;
automatic_fix additionally requests fixes from new findings automatically.
Existing explicit manual crew operations remain available; opted-in project policies
control automatic writer scheduling as well as the new finding-action path.

Global constraints: no GitHub Actions, no automatic merge/deployment by crews, no shell
granted to model turns, preserve budget/stop/membership checks. Verification machines
must be explicitly labelled by an operator; this label is an operator assertion of
isolation, not a sandbox implemented by this patch. Only existing configured Verify
products run, with secretless pinned specs and no changed build-definition files.

Interfaces:
- ProjectAutomation: mode ('report_only'|'suggest'|'automatic_fix'), fixerCrewId,
  testCrewId (string|null), maxFixAttempts (1..5), verification.enabled,
  verification.maxAttempts (1..5), verification.timeoutMinutes (1..60).
- projectAutomation(policy, projectId) returns defaults merged with configured policy.
- POST /crew/findings/:id/action { eventId, kind:'fix'|'regression_test', requestId }.
  Target comes from project policy, not untrusted findings. Response includes actionId,
  runId and state. Replays are idempotent; conflicting request reuse is refused.
- Event detail includes actions [{id,finding_id,event_id,kind,target_crew_id,run_id,
  state,reason,created_at}]. Run state and verification state are linked for review.

Tasks:
- [x] Model and role presets: validate policy, add failure-triage and
  dependency-maintenance server/client presets, test defaults and invalid input.
- [x] Finding actions: persisted audit rows, matching occurrence validation, deduplication,
  scoped/pinned enqueueing, evidence prompt, automatic mode, stop/pause/budget enforcement.
- [x] UI: per-project mode/target/attempt/verification form in Settings, finding action
  buttons and status in Events, preserve unrelated advanced project rules.
- [x] Verification: cap per-proposal attempts, reject concurrent duplicate builds, require
  labelled machine and time cap, automatically verify action proposals only when opted in,
  cancel automatic queued/running verification when Stop all crew is used.
- [x] Regression tests: authorization, stale head, duplicate clicks, policy downgrade,
  exhausted action/build budgets, stopped/paused crew, unsafe Verify inputs, labels/timeouts.
- [x] Local full verify (697 tests), independent review and Codex-authored commits.
- Delivery: PR #21 targets feature/cloudflare-experiment; merge after local verification.

Review focus: policy changes between queue/claim; retry counting; preserved exact evidence;
no feedback loop from verification builds; privilege boundaries on automatic code execution.
