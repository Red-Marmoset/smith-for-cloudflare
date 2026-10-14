# Scheduler affinity (B) + chain-deploy artifact linkage (C) — design

**Date:** 2026-06-17
**Status:** approved (mechanisms chosen); deploy held until in-flight builds finish

## Background

Two utilization/correctness problems surfaced while running soccer-boy:

1. **A Linux build ran on a Windows agent (RMS-ONE) while the native Linux
   agent (Snorkels) sat idle.** Root cause: the Linux profile is classified
   `os:"any"`, and Windows boxes also advertise `unity-linux-il2cpp` (they can
   cross-build), so the job matched any such node and the scheduler is
   first-idle-poller-wins with **no affinity**.

2. **A `steam-release` chain's deploy staged stale artifacts** (`#43`/`#46`)
   instead of the run's own builds. Root cause: `ResolveArtifactInputs` picks
   the *latest successful build per variant on the deploy's branch* — entirely
   decoupled from the builds in the chain that triggered the deploy. A partial
   rebuild can therefore ship a mixed-commit "Frankenbuild."

(A separate config lever — pinning `os:"linux"` on `main` — is tracked
out-of-band as task A; it is the user's repo change, not a Smith change.)

## B — scheduler affinity via `preferOs`

**Model (chosen):** keep `os:"any"` (any capable node *can* run the job) but add
an optional `preferOs` hint. The native agent gets first dibs for a grace
window; after that, or if no preferred agent is online, any matching node may
take it. Preserves cross-build fallback while stopping the stranding.

**Schema:** add `preferOs` (string, default "") to:
- `ClassifyRule` (so `discover.classify[]` can set it, e.g.
  `{ "match": "\\(Linux\\)", "os": "any", "preferOs": "linux" }`)
- `NodeSelector` (so a rule's `nodeSelector` can set it directly)
- `ProductVariant` (resolved from the matching classify rule)

**Dispatch change (`HandleJobsNext`):** after the existing `NodeMatches` passes
for a polling node, apply the affinity gate:

```
if preferOs is set and != "any" and pollingNode.os != preferOs:
    queuedMs = now - rec.createdAt
    if queuedMs < graceMs and a preferOs agent is currently online:
        continue   # let the preferred agent grab it first
```

- `graceMs` = new config `preferOsGraceSec` (default 25s). Agents poll every
  ~1.5s, so this is ample for the preferred agent to claim the job; it is also
  short relative to multi-minute builds.
- "a preferOs agent is currently online" reuses `NodeOnlineLocked` over
  `m_nodes` (os match + `nodeOfflineAfterSec` liveness). If none is online, the
  gate does **not** defer — no pointless wait when the native agent is down.

The decision is extracted into a pure predicate
`ShouldDeferForAffinity(preferOs, nodeOs, queuedMs, graceMs, preferredOnline)`
for unit testing; the coordinator supplies `preferredOnline`.

## C — chain deploy consumes its own builds

**Model (chosen):** "pin to the chain's own builds." A chain's `then` deploy
resolves each declared input to the artifacts of the **matching build jobId in
its own batch**; only an input variant the chain did *not* build falls back to
the existing latest-success-on-branch lookup. Standalone (non-chain) deploys are
unchanged.

**Linkage:** add `batchId` (string) to `BuildRecord` (persisted). When
`BatchAdvance` queues a `then` deploy, stamp the new deploy record's `batchId`
with the batch id (set post-enqueue, then `SaveRecord`).

**Resolution (`Inputs.cpp`):** refactor the per-input picker into a helper
`PickLatestSuccess(history, projectId, product, variant, branch)`, then add:

```
ResolveArtifactInputsFromBatch(inputs, batchBuilds, history, projectId, branch, out, error)
  for each input:
    best = batchBuilds where product+variant match, status==success, has artifacts
    if !best: best = PickLatestSuccess(history, ...)   # fallback for un-built variants
    if !best: error
    emit best's artifacts
```

`ResolveArtifactInputs` keeps delegating to `PickLatestSuccess` (behavior
identical to today). In `HandleJobsNext`, when a deploy job has `rec.batchId`
and the batch is found, gather its `builds[].jobId` → `BuildRecord*` and call the
batch resolver; otherwise call the existing one.

Net: a `steam-release` run deploys exactly the windows/mac/linux builds from
that run, same commit — no stale or mixed-commit upload.

## Files

**B:** `Domain.h` (+`preferOs` x3), `RepoConfig.cpp` (parse), `Variants.cpp`
(classify→variant propagation), `Config.h` (`preferOsGraceSec`),
`CoordinatorJobs.cpp` (`HandleJobsNext` gate + `ShouldDeferForAffinity` +
`PreferredAgentOnlineLocked`), `Domain.h`/helper for the pure predicate.

**C:** `BuildRecord.h` (+`batchId`), `Store.cpp` (persist), `Inputs.{h,cpp}`
(refactor + batch resolver), `CoordinatorBatches.cpp` (stamp `batchId`),
`CoordinatorJobs.cpp` (`HandleJobsNext` branch to batch resolver).

## Testing

- `Inputs` unit test: a batch resolver prefers the run's build over an older
  latest-success of the same variant, and falls back for an un-built variant.
- `ShouldDeferForAffinity` unit test: defers a non-preferred node within grace
  when a preferred agent is online; does not defer after grace, when no
  preferred agent is online, or when the node IS the preferred os.
- Existing wire/store/coordinator suites stay green.

## Deployment

Per the user's instruction, **no rebuild/restart of the live coordinator or
agents while builds are running.** Build + test locally; deploy (and, for B to
take effect on remote agents, redeploy them) once in-flight builds finish.
Per `CLAUDE.md`, no real deploy/publish is run during this work.
