# Check-in reviewers in Smith

Smith can select Crew members for a repository change, queue them within a shared budget, and keep their findings together in **Crew → Events**. This is a hosted-coordinator feature. It is disabled by default; existing manual, interval, and build-finished members keep their behavior.

## Enable it gradually

1. Install the updated hosted agent on an opted-in Crew machine. It advertises `crew-orchestration-v1` and the metadata-job label `checkin-metadata-v1`. Older agents still serve legacy Crew runs.
2. In workspace Settings, configure the check-in policy. Start with orchestration disabled, submit an exact base/head range under Events, and inspect verified metadata and **Dry run selection**.
3. Create read-only members from the standards, cleanup, bug, test, security, and architecture review presets. Configure filters for the work each should see. Merely enabling the feature creates no members.
4. Enable check-in orchestration in Settings. Existing workspace spend/concurrency limits, machine opt-in, member budgets, and Stop all crew remain authoritative.
5. Only after reader rollout, explicitly configure a writer with `acceptEdits`, `mode: "write"`, and literal directory scopes. No starter preset enables writes.

Example member policy (the editor accepts JSON):

```json
{
  "mode": "read_only",
  "events": ["push", "pr_ready"],
  "paths": ["src/auth/**", "package*.json"],
  "cooldownMs": 300000,
  "debounceMs": 30000,
  "maxDebounceWaitMs": 180000,
  "maxJitterMs": 5000,
  "priority": "high",
  "costClass": "expensive",
  "unitCost": 4,
  "canRequest": []
}
```

Filters combine with AND; alternatives within a filter combine with OR. Globs support `*`, `?`, and `**`. Both sides of renames count. Module filters require an operator-defined module map; missing required metadata defers the selection. For example, the workspace policy can contain:

```json
{
  "projectRules": {
    "smith": {
      "modules": { "agent": ["Modules/SmithAgent/**"] },
      "riskRules": [{ "paths": ["Modules/SmithAgent/**"], "risk": "high" }]
    }
  }
}
```

The highest matched configured risk wins. Without project overrides, dependency/auth/security/migration changes are high risk, documentation-only changes low, and other changes normal. Default event allowances are low 3, normal 8, high 15, PR-ready 25, release-candidate 50. These units are scheduling weights, separate from dollars. Default class concurrency is cheap 8, medium 3, expensive 1, additionally constrained by existing workspace limits. Requests share the root allowance, with depth 2 and at most 6 runs by default.

## Activity and cost controls

The Crew page links directly to Settings. Owners and admins can set cheap, medium,
and expensive check-in concurrency with normal number fields, plus a start cap per
hour. A class limit of **0** prevents new admissions in that class. The workspace
concurrency limit still applies across all classes. These controls apply when work
is admitted; they do not cancel already admitted work. Use **Stop all crew** to
stop current activity and prevent new starts.

The hourly check-in gate counts all crew starts over the preceding hour. Legacy
manual, interval, branch-change, and build-finished members are limited by their
own **runs per day**, duration and the workspace concurrency cap instead. Pause a
member to prevent further work from starting, including an unclaimed queued run.
Already running work retains its separate Stop control.

The daily dollar limit covers Anthropic API-key spending over a rolling 24 hours,
including reservations for queued/running jobs. **0** prevents new paid API runs;
it does not disable signed-in or local models. History cleanup preserves every run
still needed for the rolling run-count and dollar limits, even beyond the usual
30-session history cap. Event budgets, request depth, total runs and project rules
remain in the advanced policy editor.

## Finding actions and project automation

In workspace Settings, enable **Use project finding policy** for each project you
want to configure. Leaving it unchecked preserves existing member scheduling.
Newly enabled policies start in **Report only**:

- **Report only:** automatic writers are held; readers can still report findings.
- **Suggest:** operators can choose **Request fix** or **Add regression test** on
  an Events finding.
- **Automatically request fixes:** open findings queue the configured fixer
  without a click. Ordinary failed Smith builds contribute a finding after their
  exact checkout metadata is verified.

Choose named fixer and regression-test members. Each must be enabled, have this
project as its primary project, and explicitly allow scoped writes. Configured
action targets run through findings rather than also firing their old automatic
triggers. Manual Run now remains available. The **Failure triage** and
**Dependency maintenance** presets start read-only; configure relevant projects,
filters and budgets before enabling them.

Actions capture finding evidence and the exact commit, create a crew branch, and
use existing admission checks, unit budgets, scope leases and member limits.
Repeated requests for the same finding, commit and action are deduplicated.
Maximum fix attempts (1–5, default 1) bounds actions per check-in, including
regression-test actions. Blocked automatic requests appear in Events and require
a deliberate retry after correcting settings. Policy changes and paused targets
are rechecked before queued work starts.

## Bounded verification

**Automatically verify proposals** is off by default. With automatic-fix mode,
it permits one automatic Verify attempt after an action's branch is pushed.
Configure the target member's approved Verify product first. Subsequent manual
Verify retries share the proposal's attempt cap (1–5, default 1), member daily
build cap and workspace lifetime cap. Each bounded build has a timeout (1–60
minutes, default 10), is secretless, and is pinned to the proposed commit.

Bounded builds require a machine labelled `crew-verify-isolated`. Assign this
label only to a machine you have isolated for running proposed code: the label
selects machines; it does not create a sandbox. The model cannot select arbitrary
shell commands. Changes to build configuration or guarded build scripts remain
ineligible for Verify. Refusals and preparation failures appear on the proposal;
automatic preparation is not retried on every scheduler tick.

**Stop all crew** cancels queued and active automatic Verify jobs as well as crew
runs. Disabling check-in orchestration or project automatic verification prevents
new automatic verification. Accepting, merging and deploying remain separate
operator decisions.
## Event sources

Operators can submit registered project, branch, nonzero 40-hex base/head commits, kind, and a stable delivery ID. Supported kinds are commit, push, PR update, PR ready, failed test/build, merge, release candidate, and manual. A repeated delivery is idempotent; reusing its ID for different content returns a conflict.

For GitHub, configure the write-only check-in webhook secret in Settings and use the project-specific URL shown there:

`/api/v2/workspaces/<workspace-id>/crew/webhooks/github/<project-id>`

Use JSON with push and pull-request events and the same secret in GitHub. Smith verifies `X-Hub-Signature-256` against the raw body before accepting it. The webhook cannot choose an unregistered remote. Deleted branches and Crew output do not launch reviews. Automatic release-provider integration is not included; release candidates are submitted explicitly.

When orchestration is enabled, ordinary failed Smith builds generate test-failure events at the actual checked-out commit. Verify and Crew-created builds are excluded. Smith reuses a known change range for that commit; if none exists, it records an explicit zero-width range at the failed checkout. The metadata identifies the originating build.

## Metadata and execution

The GitHub reader uses the workspace credential when available. Otherwise, a metadata-only native job reads the exact commits with bounded Git operations. It runs no repository scripts, hooks, submodule updates, or AI CLI. Missing history, diverged ancestry, truncation, or failed access blocks automatic selection visibly. Retry metadata after resolving the cause. Interrupted provider attempts recover to a visible blocked state after their deadline.

All reviews run at the captured head SHA, even if the branch moves later. Contiguous waiting ranges may coalesce; ranges with findings or admitted work never retarget. Coalesced budgets take the maximum allowance rather than adding allowances. Queued members retain their captured policy; disable/stop and re-submit if replanning is required.

Readers cannot edit, create projects, or push. Writers require literal directory scopes (an empty string means the whole repository), matching the native path restrictions. Overlapping scopes on the same canonical repository and branch serialize, including aliases and case variants. Disjoint writers and readers can overlap. One member stays single-flight because its checkout is reused.

Writer leases survive the separate push turn. Expired or stopped turns cannot submit findings or request more work. Uncertain writers retain quarantined scopes until bounded execution plus grace has elapsed. Native checks validate all changed paths, including rename sources and untracked files, and reject unsafe links. These checks coordinate and constrain the supported runtime; they are not an operating-system sandbox.

## Findings and requests

Events shows eligibility explanations, queue reasons, pinned ranges, budget usage, measured or unknown cost, leases, requests, verified files, and deliveries. Findings are normalized across runs while keeping per-run occurrences and human disposition history.

`crew_request_review` is the only agent escalation path. It requires a target explicitly listed in `canRequest`, finding IDs, a reason, and an idempotency key. It queues through normal eligibility/admission and the original event budget. Chat text never starts agents. A human disposition such as second review or fixer requested records intent; it does not silently run a model. Merge-blocking is an internal review hold, not a GitHub branch-protection check. Existing human Verify/Accept/Dismiss remains in Review.

Claimed work consumes units even on failure; only unclaimed reservations refund. Exhausted roots record skipped decisions. Metadata intake and unresolved findings have explicit capacity limits; completed unreferenced aggregates retain at most 1,000 entries for 30 days. Active work, uncertain leases, proposals, and unresolved findings protect their event history.

## Verification and rollout limits

The implementation is tested locally through coordinator actions, metadata dispatch, six findings-only reviewer claims, scoped native runtime fixtures, and DOM UI fixtures. No live model spend, real deployment, merge, or GitHub Actions run is part of verification. Browser visual interaction still needs a manual smoke test on a host with an available browser; this session's browser provider exposes none.
