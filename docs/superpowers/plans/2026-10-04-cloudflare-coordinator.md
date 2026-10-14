# Smith Cloudflare Coordinator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. The branch includes experimental native packaging and an A0 hosted-coordinator slice; Tasks 1, 2 and 4 are partially implemented. See [operations](../../cloudflare/operations.md) for current coverage and live evidence.

**Goal:** Move Smith's coordinator onto Cloudflare, connect native build agents securely, support user-selected sign-in, and then add concurrent AI coding and verified handoff.

**Architecture:** A TypeScript Worker serves the existing dashboard and routes authenticated requests to a workspace Durable Object. Each object owns durable scheduling and authorization, D1 stores global identity and rebuildable history projections, and R2 stores logs and outputs. Native C++ agents execute jobs; Artifacts and Workflows are added after the hosted build loop works reliably.

**Tech Stack:** TypeScript, Workers, SQLite-backed Durable Objects, D1, R2, Wrangler, Workers Vitest integration; existing C++/Una agents and vanilla web UI; later Cloudflare Artifacts and Workflows.

**Spec:** [Cloudflare coordinator design](../specs/2026-10-04-cloudflare-coordinator-design.md).

## Global Constraints

- Preserve the Smith name and System for Managed Integration, Testing & Handoff acronym.
- Build and deployment logic remains in repository-owned scripts and `smith.json`.
- Native headless agents remain free of wxWidgets; platform-specific code stays in platform files.
- Cloudflare-managed databases and HTTPS are deliberate hosted-only changes to the LAN deployment constraints.
- Keep the vanilla web UI; introduce no frontend framework for this migration.
- Persist authoritative state before acknowledging externally visible transitions.
- Every hosted resource belongs to a workspace, and authorization is enforced server-side.
- Use local emulation and dry-run fixtures during development, then deploy the isolated experimental coordinator to Cloudflare for milestone A0. Production deployment and real job handoff require separate authorization.
- Use isolated feature branches and commit with `git commit --author="Codex <codex@example.com>"`.

## Review Focus

1. A lost assignment response or restarted node must not produce two simultaneous assignments: Tasks 4 and 5.
2. A revoked user/node must not read another workspace's history, streams or outputs, including through stale projections: Tasks 2, 3, 6 and 9.
3. An old attempt returning after cancellation/expiry must not complete or deploy a replacement job: Tasks 4, 5 and 11.
4. Multi-repository projects, discovered variants and batch inputs must use the intended pinned source and output set: Tasks 1, 7 and 8.
5. A disconnect during a large upload, D1 outage or duplicate alarm must preserve recoverable state without repeating a handoff: Tasks 4, 6, 8 and 12.

## Delivery sequence

| Milestone | Tasks | Gate |
| --- | --- | --- |
| A0: coordinator runs on Cloudflare | 1, 2, 4 | Deploy Worker/API with durable state at exp.redmarmosetstudios.com; demonstrate fixture job lifecycle with the local coordinator stopped |
| A: reliable hosted build loop | 1–6 | Real native agent against the deployed experimental Worker; HTTPS transport tests; restart/retry/isolation tests in local emulation and hosted smoke checks |
| B: coordinator parity and onboarding | 7–9 | Existing pipeline fixtures, two sign-in providers, generic OIDC, multiple projects and nodes, documented migration coverage |
| C: concurrent AI experiment | 10–11 | Two concurrent isolated candidates, independent verification, explicit selection and dry-run handoff |
| D: controlled release | 12 | Recovery, quotas, cost evidence, migration/rollback rehearsal, authorized canary |

Prioritize Tasks 1, 2 and 4 for the first hosted coordinator; then complete
Tasks 3, 5 and 6 for native-agent integration. Implement by dependency, in small reviewed commits. Each numbered
task is a reviewable deliverable; do not mix the whole roadmap into one PR.
Task 3 can be developed independently after the contracts exist. No calendar
estimate is asserted until milestone A validates transport and persistence.

## Repository layout and verification conventions

All paths below are repository-relative. Existing C++ paths refer to the cloned
baseline, not the sometimes newer files in `C:\code\smith`. New paths are
proposed files to create during implementation, not files claimed to exist today.
Within task file lists, `src/`, `test/`, `migrations/`, `wrangler.jsonc` and
`contracts.ts` refer to paths under `cloudflare/coordinator/` (with `contracts.ts`
under `src/`). `Tests/` names the existing native projects; `tests/contracts/`
names the new shared fixture directory.

```text
cloudflare/coordinator/
  package.json, package-lock.json, tsconfig.json, wrangler.jsonc, vitest.config.ts
  src/index.ts, contracts.ts, errors.ts
  src/auth/                 # providers, sessions, identities
  src/workspaces/           # Durable Object, schema, permissions, outbox
  src/nodes/               # enrollment and node authentication
  src/jobs/                # transitions, leases, matching and routes
  src/storage/             # logs, manifests, R2 grants and history projection
  src/projects/            # pipeline parser, GitHub access and discovery
  src/triggers/            # webhooks and schedules
  src/batches/             # batch transitions and input resolution
  src/connections/         # external credentials and resource grants
  src/tasks/               # later AI candidates, verification and promotion
  migrations/              # D1 migrations; DO migrations live with workspace schema
  test/                    # Workers runtime tests and pure fixture tests
tests/contracts/           # JSON fixtures shared with native test projects
Modules/SmithAgent/         # native transport and hosted execution additions
docs/cloudflare/            # setup, compatibility, operations and recovery
```

Task 1 must establish these executable commands in `package.json`:

```json
{
  "scripts": {
    "dev": "wrangler dev --local",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "verify": "npm run typecheck && npm test && wrangler deploy --dry-run"
  }
}
```

From the repository root use `npm --prefix cloudflare/coordinator run verify`.
Use `npm --prefix cloudflare/coordinator test -- test/<name>.test.ts` for targeted
Workers tests. Native verification uses `./RunTests.ps1` on Windows and
`./RunTests.sh` on Linux/macOS. Both require a bootstrapped Una engine; record its
revision in test evidence. Changes to native layouts require the existing clean
build wrappers. Native packaging changes also require a Release build and a
packaged-launcher smoke check.

Test snippets below specify required behavior and expected assertions. Helpers
such as `fixture()` are test harness interfaces to implement in the owning task;
they are not existing repository APIs. Run a new test before implementation to
see the expected failure, then implement and rerun. Pin current supported package
versions and the Worker compatibility date in Task 1; do not copy stale SDK API
examples blindly.

The experimental origin is `https://exp.redmarmosetstudios.com`; name the Worker
`smith-experiment`, and provision isolated experiment bindings. Configure it as a
Workers Custom Domain, never as a tunnel to a local native coordinator. The
checked-in `config/experiment/target.json` describes the destination; change its
status from planned only when a live deployment has been verified. Cloud resource
creation/deployment is an explicit implementation step, not a side effect of
the preparatory native `build-experiment` product.

## Task 1: Freeze the contracts and establish the local Worker test harness

**Files:** Create `cloudflare/coordinator/{package.json,package-lock.json,tsconfig.json,wrangler.jsonc,vitest.config.ts}`, `src/{index.ts,contracts.ts,errors.ts}`, `test/contracts.test.ts`, `tests/contracts/{wire-v1.json,wire-v2.json,pipelines.json,scheduling.json,batches.json}`, and `docs/cloudflare/compatibility.md`. Modify `Tests/SmithProtocolTest/Main.cpp` and `Tests/SmithFeaturesTest/Main.cpp` to exercise shared fixtures. Read `WireTypes.h`, `WireJson.cpp`, `RepoConfig.cpp`, `NodeMatcher.cpp`, `Batches.cpp`, `Inputs.cpp` and their current tests.

**Interfaces:** Define the hosted contract in `contracts.ts` and document its C++ mapping:

```ts
export type JobState = 'queued' | 'leased' | 'running' | 'success' |
  'failed' | 'error' | 'cancelled' | 'lost';
export type Role = 'owner' | 'admin' | 'operator' | 'viewer';
export interface HumanPrincipal { kind: 'human'; userId: string }
export interface NodePrincipal { kind: 'node'; workspaceId: string; nodeId: string }
export interface AttemptRef { jobId: string; attemptId: string; leaseToken: string }
export interface Lease extends AttemptRef { leaseExpiresAt: number; nodeId: string }
export interface HostedEnvelope {
  protocolVersion: 2; workspaceId: string; lease: Lease;
  spec: ResolvedJobSpec;
}
export type HostedAssignment =
  | { hasJob: false }
  | { hasJob: true; envelope: HostedEnvelope };
```

`ResolvedJobSpec` is the TypeScript representation of every current `JobSpec`
field, including `steps`, inputs, handoff, per-repository commits and clean mode.
Define it by translating `WireTypes.h` in this task. Do not omit unknown fields
silently: reject unsupported configuration with its JSON field path.

- [ ] Capture representative wire messages and pipeline fixtures, including defaults, missing optional fields, explicit OS selection, multi-repo checkout, variants and fan-in. Remove real tokens and local machine paths.
- [ ] Add C++ fixture decoding checks before adding the hosted fields; confirm the baseline fixtures round-trip as expected.
- [ ] Create the Worker package with local DO/D1/R2 bindings and a non-sensitive `/health` route. Pin dependencies and compatibility date; serve `../../web` as static assets without exposing source/config files.
- [ ] Implement runtime input validation with explicit request-size bounds and a consistent `{error:{code,message}}` error shape. Hosted v1 registration returns an unsupported-version error rather than silently accepting weak semantics.
- [ ] Add a compatibility matrix listing every current coordinator endpoint as retain, version, local-only or later parity. Include Discord, Steam Guard, badges, settings, discovery and diagnostics.
- [ ] Run targeted fixtures, native protocol tests through the normal runner, and `run verify`; commit `test: define hosted coordinator contracts and local harness` with the required author flag.

**Required fixture assertions:**

```ts
expect(decodedV1.protocolVersion).toBe(1);
expect(decodedV2.lease.attemptId).toBe('attempt-fixture-1');
expect(decodedV2.spec.repos[0].commit).toBe(sourceCommit);
expect(hostedRegistrationV1.status).toBe(426);
expect(unsupportedPipeline.error.message).toContain('products[0]');
```

## Task 2: Establish workspace state and hosted human authorization

**Files:** Create `src/workspaces/{WorkspaceCoordinator.ts,schema.ts,permissions.ts}`, `src/auth/{google.ts,identities.ts,sessions.ts,routes.ts}`, `migrations/0001_identity.sql`, `test/{workspace-isolation,google-auth,sessions}.test.ts`, and `test/helpers/identity-fixture.ts`. Modify `src/index.ts` and `wrangler.jsonc`.

**Interfaces:** `authenticateHuman(request): Promise<HumanPrincipal>` resolves a
cookie session; `requireRole(userId, action, projectId?)` is checked in the
workspace object. `WorkspaceCoordinator` exposes authenticated commands, not
arbitrary SQL. D1 tables: users, external_identities with unique provider/issuer/
subject, sessions with token hashes and expiry, and a workspace directory.
Workspace SQLite tables initially contain membership, project grants, schema
version and audit events. Generated workspace IDs are bound to authenticated
membership; never route by an unchecked header alone.

- [ ] Build fixtures for Alice/workspace A and Bob/workspace B. Test denied cross-workspace reads and writes, removed memberships, viewer writes, last-owner deletion and unauthenticated requests.
- [ ] Implement Google login using a vetted Workers-compatible verifier, stable internal user IDs and opaque cookie sessions. Validate signature/issuer/audience/expiry/nonce/state and establish CSRF protection; test malformed and expired tokens without calling Google.
- [ ] Create workspace ownership and membership transactionally. Add an idempotent recovery path for interruption between global identity creation and workspace provisioning.
- [ ] Enforce current membership inside each workspace command. Do not authorize from D1's workspace directory projection. Make session revocation immediately effective on subsequent requests.
- [ ] Exercise object reconstruction from persisted SQLite and D1 storage. Verify no global in-memory map is needed for correct authorization.
- [ ] Run `test/workspace-isolation.test.ts`, `test/google-auth.test.ts`, `test/sessions.test.ts`, then `run verify`; commit `feat: add workspace-scoped hosted identity`.

```ts
expect(await alice.get(bob.workspaceUrl)).toHaveProperty('status', 403);
await fixture.removeMembership(alice.userId);
expect(await alice.get(fixture.workspaceUrl)).toHaveProperty('status', 403);
expect(await fixture.loginWithWrongAudience()).toHaveProperty('status', 401);
```

## Task 3: Add secure native-agent transport

**Files:** Create `Modules/SmithAgent/{AgentTransport.h,AgentTransport.cpp,CurlTransport.cpp}`, platform-specific temporary-file permission helpers, and `Tests/SmithAgentTest/TransportFixture.cpp`; modify `AgentUtil.h`, `Agent.cpp`, `Agent.h`, `Module.manifest`, `Modules/SmithCore/{Config.h,Config.cpp}`, `Tests/SmithAgentTest/{Main.cpp,Module.manifest}`, and `docs/cloudflare/agents.md`.

**Interfaces:** `AgentTransport` supplies `Request(method, path, body)`,
`Download(url, destination, authContext)` and `Upload(url, source, authContext)`.
Use a transport result containing HTTP status, transport error and bytes written;
do not treat HTTP 4xx/5xx as network success for job reporting. An explicit auth
context distinguishes coordinator calls from presigned object requests.

- [ ] Test HTTPS selection, missing curl, certificate rejection, non-2xx responses, cancellation, partial downloads, redirect/downgrade rejection and URL paths containing spaces/query parameters.
- [ ] Implement the direct-argv curl adapter with secure temporary files, bounded output and streaming transfers. Use owner-only permissions; clean up on success, error and restart. Test that tokens never appear in argv or captured logs.
- [ ] Replace all agent coordinator calls, including the direct `GetToFile` input-download path. Preserve the plain HTTP adapter for explicitly configured local v1 coordinators.
- [ ] Keep credentials scoped to the configured coordinator origin. R2 URLs carry no node Authorization header and cannot redirect to arbitrary origins; reject unexpected upload/download hosts.
- [ ] Add configuration and startup diagnostics. Verify certificate trust using a local HTTPS fixture with a trusted test CA and a rejected untrusted CA; never disable TLS verification as the passing test path.
- [ ] Run the native agent tests on Windows first and record Linux/macOS requirements; commit `feat: add HTTPS transport for hosted agents`. Require all three platforms before milestone B exits.

```cpp
ASSERT_TRUE(requestHeaders.find("node-secret") == std::string::npos);
ASSERT_TRUE(curlArgvText.find("node-secret") == std::string::npos);
ASSERT_EQ(untrustedCertificateResult.ok, false);
ASSERT_EQ(partialDownloadPublished, false);
```

The first assertion applies to the captured **presigned R2 request**, not the
authorized coordinator request. Define these fixture variables in the native
test and inspect the actual transport invocation, not a duplicate implementation.

## Task 4: Implement durable enrollment, assignment and attempt fencing

**Files:** Create `src/nodes/{enrollment.ts,credentials.ts,routes.ts}`, `src/jobs/{state.ts,leases.ts,matching.ts,routes.ts}`, `src/workspaces/outbox.ts`, `test/{enrollment,leases,recovery}.test.ts`, and `test/helpers/workspace-fixture.ts`; modify workspace schema/object and `contracts.ts`.

**Interfaces:** `enroll(code, registration)` returns a node credential once;
`enqueue(HumanPrincipal, projectId, specDigest, requestId)` returns a durable job ID;
`claim(NodePrincipal)` returns `HostedAssignment`;
`renew(NodePrincipal, AttemptRef)` returns expiry/cancel state;
`complete(NodePrincipal, AttemptRef, result)` returns an idempotent acknowledgment.
Add SQLite nodes, credential hashes, enrollment codes, jobs, attempts, command
deduplication, events and outbox tables with unique keys scoped to the workspace.

- [ ] Test concurrent claims on the same job and repeated claims from one busy node. One transaction creates one current lease; a lost response is replayable.
- [ ] Implement single-use enrollment, rotation, revocation and server-side node/project scope. Do not trust body `nodeId` independently of the credential.
- [ ] Add authorized trigger and current-job read routes using a frozen project specification. Until Task 7 implements repository import, provision the harmless smoke project through a local test seed tool; do not expose a public arbitrary-command or auth-bypass endpoint. Repeating an enqueue request ID returns the same job.
- [ ] Implement queued/leased/running/terminal transitions, server timestamps and 90-second renewable leases. Persist before returning; never await provider APIs within a SQLite transaction.
- [ ] Implement a single persisted earliest-due alarm covering lease expiry and outbox retries. Repeated alarms and reconstructed objects produce identical state.
- [ ] Fence results/status/uploads from old attempts. Duplicate identical completion is acknowledged; conflicting completion returns 409. Expired deployment attempts enter reconciliation rather than automatic retry.
- [ ] Test expired leases, node revocation during work, missing nodes, incompatible protocol, object eviction and a thrown projection write. Run the three targeted tests and `run verify`; commit `feat: persist hosted job leases and node identity`.
- [ ] Complete milestone A0 before extending the native runner: deploy the experiment Worker and isolated bindings, verify its Custom Domain, and execute an authenticated fixture lifecycle through HTTPS while the local coordinator is stopped. Recheck persisted job state after redeployment. This milestone requires actual Cloudflare execution; a local emulator or tunnel does not count. Record the deployment revision and update target.json only after this passes.

```ts
const [a, b] = await Promise.all([fixture.claim('node-a'), fixture.claim('node-b')]);
expect([a, b].filter(x => x.hasJob)).toHaveLength(1);
await fixture.expireLeaseAndRunAlarm();
expect(await fixture.completeOldAttempt()).toHaveProperty('status', 409);
expect(await fixture.claimForRevokedNode()).toHaveProperty('status', 401);
```

## Task 5: Connect the C++ agent to hosted protocol v2

**Files:** Modify `Modules/SmithProtocol/{WireTypes.h,WireJson.h,WireJson.cpp}`, `Modules/SmithAgent/{Agent.h,Agent.cpp,AgentHandoff.cpp}`, native protocol/agent tests and contract fixtures. Create `Modules/SmithAgent/HostedSession.{h,cpp}` and update its manifest.

**Interfaces:** Persist a hosted node enrollment and current attempt locally in
an owner-restricted state file. Add a v2 lease envelope without changing v1's
serialized messages. Hosted reporting includes the attempt and monotonic event
sequence; renewal is independent of log production.

- [ ] Add failing protocol tests for absent v2 fields, registration negotiation and round-trips, then implement explicit v1/v2 codecs.
- [ ] Implement enrollment, lease renewal and replay of accepted results after reconnect. Never start a second job while the first is running, even if registration is repeated.
- [ ] Stop the child process tree when cancellation or lease expiry requires it. Check authorization before each handoff; persist an uncertain handoff outcome for reconciliation after restart.
- [ ] Use workspace/project/job/attempt execution directories for hosted jobs. Validate all relative working/checkout paths, archive extraction paths and symlink boundaries against that root; keep local v1 behavior.
- [ ] Run a harmless fixture job through local Worker emulation using the native agent. Drop the assignment response, renewal response and result response in separate tests; verify one current assignment and one accepted outcome.
- [ ] Treat TLS tests and local-emulator job tests as separate evidence: local HTTP emulation alone does not prove HTTPS interoperability. The authorized hosted canary in Task 12 must exercise the combined path.
- [ ] Run native protocol/agent tests and Worker lease tests; commit `feat: run native agents with hosted attempt leases`.

```ts
expect(await fixture.runWithDroppedAssignmentReply()).toEqual({ starts: 1, completions: 1 });
expect(await fixture.runWithSilentProcessAndCancel()).toHaveProperty('childStopped', true);
expect(await fixture.restartAfterUncertainHandoff()).toHaveProperty('automaticDeploys', 0);
```

## Task 6: Make logs, artifacts and history durable

**Files:** Create `src/storage/{logs.ts,artifacts.ts,grants.ts,history.ts}`, `migrations/0002_history.sql`, `test/{logs,artifacts,projection}.test.ts`; modify workspace schema/outbox, native artifact collection and staged input download paths. Add a harmless `tests/fixtures/cloudflare-smoke/` pipeline/script that emits logs and a deterministic file.

**Interfaces:** `appendLog(node, attempt, seq, chunk)` acknowledges a durable
cursor; `beginUpload(node, attempt, manifest)` issues scoped part grants;
`commitUpload(node, attempt, uploadId)` checks object metadata and commits the
manifest. `getHistory(user, workspace, cursor)` authorizes via the workspace,
then reads a versioned D1 projection. Manifests include byte count, checksum,
source SHA and attempt. Required outputs are committed before success is accepted.

- [ ] Test duplicate/out-of-order log chunks, reconnect cursors and conflicting data for one sequence. Persist bytes before acknowledging; define bounded gaps and backpressure.
- [ ] Implement short-lived direct R2 transfer grants and multipart completion. Test an output larger than a normal edge request limit without sending it through the coordinator as one request. Verify size/checksum and reject truncated/mismatched objects.
- [ ] Enforce node/job ownership when issuing and committing grants. Fence cancelled attempts, prevent path traversal, and clean abandoned uploads by retention policy.
- [ ] Persist an outbox event with each operational transition; idempotently project to D1. Test D1 outage, duplicate delivery, reordered revisions and repair from retained events. Authorize downloads at grant time and document the short expiry window of an issued URL.
- [ ] Stream dashboard logs using authenticated fetch/SSE with cursor replay; store no session bearer in URLs. Close/recheck streams on membership revocation. Keep live output bounded and archive immutable chunks in R2.
- [ ] Run the full smoke job, reconstruction tests and all targeted storage tests; commit `feat: persist hosted build logs and artifacts`.

```ts
await fixture.appendSameLogChunkTwice();
expect(await fixture.readLogLines()).toEqual(['first', 'second']);
expect(await fixture.commitWrongChecksum()).toHaveProperty('status', 409);
await fixture.deliverProjectionEvents([3, 1, 3, 2]);
expect(await fixture.historyRevision()).toBe(3);
```

**Milestone A gate:** One authenticated user enrolls a native node, triggers the
fixture job, sees logs and downloads its verified output. Two workspaces cannot
cross-access any endpoint. Eviction and dropped replies do not duplicate jobs.
This is the first usable experiment; it is not broad coordinator feature parity.

## Task 7: Add GitHub connections and pinned pipeline import

**Files:** Create `src/connections/{github.ts,secrets.ts,grants.ts}`, `src/projects/{github-repository.ts,pipeline.ts,variants.ts,routes.ts}`, `test/{connections,pipeline,discovery}.test.ts`; extend workspace schema. Read `RepoConfig.cpp`, `Variants.cpp`, `CoordinatorProjects.cpp` and fixtures from Task 1.

**Interfaces:** `RepositoryAdapter` exposes `resolveRef`, `readFileAtCommit` and
`listTreeAtCommit` with workspace-scoped connection context. `resolvePipeline`
produces a validated `ResolvedJobSpec` plus source/spec digests; `connectionId`
never substitutes for an ownership check. GitHub App access is distinct from
GitHub login.

- [ ] Test a private installation with two allowed repositories and one denied repository, installation revocation, rate limits and an expired installation token.
- [ ] Implement encrypted connection records, key versioning and short-lived scoped tokens. Audit metadata only; test that tokens do not occur in logs, D1 history or browser API responses.
- [ ] Read pipeline files and trees at a concrete commit through APIs; port parser/variant semantics with fixture comparisons. Resolve secondary repositories separately and record every selected SHA.
- [ ] Handle bounded pagination and dynamic discovery explicitly. Run any executable discovery on an authorized runner using a dedicated discovery job; do not execute repository content in the Worker.
- [ ] Reject unsupported pipeline fields with actionable paths. Guard credentials against attacker-selected secondary repository URLs and private-network destinations.
- [ ] Run connection/pipeline/discovery tests and the smoke pipeline using a mocked GitHub API; commit `feat: import pinned pipelines through GitHub connections`.

```ts
expect(await fixture.readUninstalledRepository()).toHaveProperty('status', 403);
expect(await fixture.resolveWhileBranchMoves()).toHaveProperty('commit', originalSha);
expect(await fixture.resolveMultiRepo()).toHaveProperty('repos.1.commit', dependencySha);
```

## Task 8: Restore scheduling, triggers, batches and fan-in behavior

**Files:** Create `src/triggers/{github-webhooks.ts,schedules.ts,polling.ts}`, `src/batches/{state.ts,inputs.ts,routes.ts}`, `test/{triggers,scheduling,batches}.test.ts`; extend matching, workspace alarms and contract fixtures.

**Interfaces:** Triggers submit an idempotent enqueue command keyed by provider
delivery or schedule occurrence. `advanceBatch` returns persisted follow-up
intentions, not immediate external deployments. Artifact input resolution returns
concrete committed manifests. All queue mutations remain in the workspace object.

- [ ] Port OS/labels/soft affinity, pinned target OS, avoid-failed-node behavior, manual/rerun preservation and automatic-trigger coalescing from fixture results.
- [ ] Verify GitHub webhook signatures against raw bytes and deduplicate deliveries. Persist the enqueue intention before acknowledging; use the event's SHA.
- [ ] Implement UTC schedules and fallback polling with jitter/backoff. Persist occurrence keys; duplicate alarms enqueue once. Display timezone and missed-run policy: coalesce missed scheduled runs to one latest due occurrence.
- [ ] Port parallel batches, fail-fast versus finish-siblings, pinned commits and one-time follow-ups. Preserve same-run fan-in preference and surface any permitted historical fallback with its source SHA.
- [ ] Require committed artifact manifests before a downstream job becomes eligible. A D1 outage must not change input selection; read authoritative manifests in the workspace object.
- [ ] Test simultaneous finishes, cancelled/lost children, duplicate completions, moving refs and missing outputs. Run targeted tests and `run verify`; commit `feat: restore hosted triggers and batch pipelines`.

```ts
await fixture.deliverWebhookTwice('delivery-1');
expect(await fixture.queuedCount()).toBe(1);
await fixture.finishBatchChildrenConcurrently();
expect(await fixture.followupCount()).toBe(1);
expect(await fixture.followupInputShas()).toEqual([batchSha, batchSha]);
```

## Task 9: Complete sign-in choice and hosted dashboard onboarding

**Files:** Create `src/auth/{provider.ts,github.ts,oidc.ts,linking.ts}`, `test/{providers,linking,permissions}.test.ts`, and `docs/cloudflare/authentication.md`; modify `web/{app.js,index.html,style.css}`, auth routes and workspace settings. Keep changes organized by existing UI boundaries.

**Interfaces:** Each provider returns a verified identity `{provider, issuer,
subject, verifiedEmail?, displayName}` to the common identity service. Provider
configuration belongs to the service or a workspace admin; login requests name
a configured provider, never arbitrary discovery URLs. Connections have separate
screens and grants.

- [ ] Test Google and GitHub logins yielding the same internal user only after explicit linking. Same-email accounts stay distinct until linked; reject linking a provider identity already owned by another user.
- [ ] Add GitHub OAuth and generic OIDC using state/PKCE/nonce as appropriate, safe callback allowlists and server-side provider configuration. Test issuer/audience/signature errors, stale keys and unavailable discovery.
- [ ] Add administrator OIDC setup with HTTPS/SSRF validation, a test-login step and rollback to the last working provider configuration. Preserve an existing owner login until a replacement has succeeded.
- [ ] Implement first-run flow: sign in, create/select workspace, connect repositories, enroll node, import pipeline, run first build. Workspace switching must clear cached sensitive state and close old streams.
- [ ] Replace hosted browser localStorage bearer handling with cookie sessions. Expose role-appropriate actions while enforcing permissions on the server. Add a capability response so local-only settings are not misleadingly editable.
- [ ] Test viewer/operator/admin/owner behavior, final-owner removal, revoked sessions and cross-workspace deep links. Run targeted tests and browser smoke checks; commit `feat: add provider choice and hosted onboarding`.

```ts
expect(await fixture.sameEmailAcrossProviders()).toHaveProperty('distinctUsers', true);
expect(await fixture.linkWithExpiredSession()).toHaveProperty('status', 401);
expect(await fixture.configurePrivateNetworkIssuer()).toHaveProperty('status', 400);
expect(await fixture.viewerTriggersBuild()).toHaveProperty('status', 403);
```

**Milestone B gate:** Hosted projects support documented pipeline semantics,
triggers, batches, outputs and roles. Native HTTPS tests pass on Windows, Linux
and macOS. Publish an explicit parity table; unsupported legacy services return
clear errors and do not block the build-core experiment.

## Task 10: Add Artifacts workspaces and isolated concurrent coding jobs

**Files:** Create `src/projects/artifacts-repository.ts`, `src/tasks/{candidates.ts,budgets.ts,runner-policy.ts}`, `test/{artifacts-repositories,candidates}.test.ts`, `docs/cloudflare/ai-runners.md`; modify native job-class dispatch, hosted workspace selection and workspace schema.

**Interfaces:** `createCandidates(taskId, sourceSha, count)` produces separately
owned repo IDs and coding jobs. Each candidate records source SHA, runner,
attempt, result SHA, budget and lifecycle. Credentials are scoped to that
candidate. `coding` jobs cannot request `handoff` grants or run on an unapproved
runner class.

- [ ] Test repo/fork idempotency, token expiry, delayed creation, cancellation and cleanup using a fake Artifacts adapter before calling the live service.
- [ ] Implement the Artifacts binding adapter after checking current API types. For private GitHub repos, use an authorized runner to copy explicitly selected refs into a baseline; verify its SHA. Do not assume public-import APIs accept private authentication.
- [ ] Define a coding-runner adapter that invokes the selected CLI/tool via an argument array, captures exit status/output and enforces time/token/cost budgets where supported. Record unsupported budget enforcement explicitly.
- [ ] Require isolated disposable runner environments for untrusted work, with restricted network/credentials and per-candidate working directories. Keep platform builds on appropriate native runners. Test termination of child processes and cleanup after failure.
- [ ] Run two harmless fixture candidates concurrently, starting from the same pinned SHA and writing distinct commits. Verify neither can access the other's workspace or production credentials.
- [ ] Run adapter/candidate tests and a dry-run demonstration; commit `feat: coordinate isolated Artifacts coding candidates`.

```ts
expect(await fixture.candidateStartShas()).toEqual([baselineSha, baselineSha]);
expect(new Set(await fixture.candidateRepoIds()).size).toBe(2);
expect(await fixture.candidateRequestsProductionGrant()).toHaveProperty('status', 403);
expect(await fixture.activeChildrenAfterCancel()).toBe(0);
```

## Task 11: Verify candidates and bind approval to a specific handoff

**Files:** Create `src/tasks/{verification.ts,evidence.ts,promotion.ts,TaskWorkflow.ts}`, `test/{verification,promotion}.test.ts`; modify workspace approval schema, candidate UI and handoff dispatch. Add a fake deployment target for tests.

**Interfaces:** Evidence identifies candidate SHA, spec digest, verified test
definition, runner and artifact manifests. `approve` binds an authorized user to
candidate SHA, target base SHA, environment and evidence digest. `promote` consumes
that approval once through the workspace object; Workflow retries cannot bypass
the same deduplication/fencing rules.

- [ ] Run verification as separate jobs with protected test definitions, no candidate write credential and explicit time limits. Reject agent prose as sufficient evidence of success.
- [ ] Build a comparison view showing tests, diagnostics, duration, cost when measured and output links. Identify unknown/unverified observations rather than inventing scores or guarantees.
- [ ] Add a Workflow for candidate completion and approval waits. Persist a promotion intent in the workspace before invoking any external action; reconcile ambiguous outcomes rather than blindly retrying.
- [ ] Invalidate approval when source/candidate/evidence/environment changes. Confirm the target base immediately before promotion using provider-supported conditional operations; reject a moved base.
- [ ] Test expired/replayed approvals, duplicate workflow events, missing outputs, concurrent approvers, revoked membership and an external timeout after a successful fake publish.
- [ ] Run targeted tests and the two-candidate demonstration with a fake handoff; commit `feat: verify and approve candidate handoffs`.

```ts
await fixture.approveCandidate();
await fixture.moveTargetBranch();
expect(await fixture.promote()).toHaveProperty('status', 409);
await fixture.simulatePublishSuccessWithLostReply();
expect(await fixture.retryPromotion()).toHaveProperty('state', 'reconciliation_required');
expect(await fixture.publishCount()).toBe(1);
```

## Task 12: Rehearse migration, recovery and the release boundary

**Files:** Create `tools/cloudflare-import.ts`, `docs/cloudflare/{operations.md,migration.md,release-checklist.md}`, `test/{import,retention,quotas}.test.ts`, and CI configuration for Worker verification. Update `README.md`, compatibility documentation and native setup docs.

**Interfaces:** Import is explicit dry-run/apply with a run ID, source snapshot
digest, record counts and checksums. Repeating an import does not duplicate
records. Imported users are account-linking candidates, not authenticated users;
sessions/shared tokens are excluded. Archive namespaces and live attempt IDs
cannot collide.

- [ ] Build fixtures from scrubbed local data: projects, pipeline configs, build history, logs and artifacts. Dry-run reports unsupported settings and missing files without mutating either coordinator.
- [ ] Implement resumable import and verification. Reauthenticate humans and reenroll nodes; never copy sessions or automatically link accounts by email.
- [ ] Add workspace quotas for nodes, concurrent jobs, pending queue, log throughput, stored bytes and AI budgets. Rate-limit login, enrollment, webhooks and job ingress with clear retry responses.
- [ ] Rehearse object eviction, D1/R2/provider outage, lost node, key rotation, database migration and schema rollback compatibility. Retain operational events/manifests until projection and archive reconciliation complete; test retention cannot erase an active job's inputs.
- [ ] Measure request/storage/compute usage with a representative fleet and artifact sizes. Record an observed cost model and limits; defer WebSockets or scheduler sharding until those measurements justify them.
- [ ] Account for later parity features explicitly: Discord and Steam Guard need their own scoped delivery/expiry tests; LAN discovery, dynamic DNS and embedded execution remain local-only. Record parity decisions in release notes.
- [ ] Document canary cutover: drain selected local projects, fence local assignments, enroll dedicated canary nodes, authorize a hosted test deployment separately, verify outputs, then expand. Document rollback and reconciliation of external actions.
- [ ] Run Worker verification, native regression suites on all supported platforms, migration dry-run and disaster-recovery rehearsal. Commit `docs: add hosted coordinator operations and release gates` with associated tested tooling.

```ts
await fixture.importSameSnapshotTwice();
expect(await fixture.importedRecordCount()).toBe(snapshotRecordCount);
expect(await fixture.importedSessionCount()).toBe(0);
await fixture.runRetention();
expect(await fixture.activeInputStillExists()).toBe(true);
```

## Completion evidence and rollout limits

For every task, record the exact commands/results and relevant source/engine
revisions in its PR. Use current official Cloudflare docs linked in the spec.
Do not mark a milestone complete from mocked tests alone when its gate requires
native transport or a real fleet. Do not claim old v1 agents work against hosted
v2 without an explicit compatibility implementation and passing tests.

This planning branch contains no Worker scaffold, dependency installation,
Cloudflare provisioning or production deployment. The next implementation work
starts at Task 1, followed by workspace authorization and transport. Review the
architecture and this plan before choosing the execution method.
