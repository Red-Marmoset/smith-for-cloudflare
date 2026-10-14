# Agent fleet management: epoch versioning + remote rebuild/restart — design

**Date:** 2026-06-17
**Status:** design for review (decisions captured); deploy held until in-flight builds finish

## Motivation

The fleet is underused and the cause is **stale agents advertising the wrong
capabilities**, not scheduling:

- **DRIPS (Windows)** never takes unity builds — almost certainly missing the
  `unity6` label the rule requires.
- **Snorkels (Linux)** never takes the Linux build — missing `unity-linux-il2cpp`
  (which the Linux variant requires), so Windows cross-builders grab it instead.

Both are old binaries (pre capability-detection) and/or boxes missing a Unity
module. Today nothing surfaces that staleness, and updating an agent means
hand-touching its box. Two features fix this:

1. **Epoch versioning + quarantine** — make staleness visible and stop dispatching
   to agents too old to trust.
2. **Remote rebuild/restart** — update an agent from the coordinator.

> **Operational note (not code):** versioning surfaces a stale *binary*, but an
> agent can still lack a *Unity module* the box never installed. Smith can flag
> "agent behind" and "label missing"; it cannot install Unity. DRIPS/Snorkels
> likely need BOTH a binary update AND the right Unity modules installed.

## Part 1 — Epoch versioning + quarantine

A monotonic **agent epoch** (int), bumped each release that changes agent runtime
behavior (e.g. clean build, pinned-checkout worktree reset, capability detection).
Distinct from `kProtocolVersion` (wire format, hard-rejected on mismatch).

- `WireTypes.h`: `constexpr int kAgentEpoch = 1;` (old agents omit it → 0).
- `RegisterRequest.agentEpoch`, `NodeInfo.agentEpoch` (+ JSON).
- Agent sends `rr.agentEpoch = kAgentEpoch`.
- `Config.minAgentEpoch` (default **0** = accept all; set to N to enforce).
- `HandleRegister` stores the epoch (still registers — quarantine, not reject).
- `HandleJobsNext`: if the polling node's `agentEpoch < minAgentEpoch`, return no
  job (quarantined). One log line on first quarantine.
- Nodes API + web UI: show `agentEpoch`, the coordinator's `kAgentEpoch`, and a
  `STALE`/`QUARANTINED` badge (`agentEpoch < kAgentEpoch` = behind;
  `< minAgentEpoch` = quarantined).
- Test: `ShouldDispatchToNode(epoch, minEpoch)` pure predicate; wire round-trip;
  a SmithCoordinatorTest case asserting a sub-min node is offered no job.

Rollout caveat: set `minAgentEpoch` only **after** the agents you want to keep are
rebuilt to the current epoch, else they all quarantine at once.

## Part 2 — Self-update capability self-report

The agent reports whether it *can* rebuild itself, so the coordinator only offers
the update command where it'll actually work:

- Agent at startup probes: source dir present (a `smith` git checkout), a build
  script (`Build.bat`/`Build.sh`), and `UNA_ENGINE_PATH` resolvable.
- `RegisterRequest.canSelfUpdate` (bool) + `NodeInfo.canSelfUpdate`; shown in UI.
- New agent config `--source-dir` (default: auto-detect relative to the running
  exe / a known location).

## Part 3 — Remote rebuild/restart command

**Channel (already exists):** the coordinator pushes one-shot directives on the
heartbeat *response* (this is how Steam Guard works — `HeartbeatLoop` →
`RunSteamGuardTask`, off-thread). Reuse it.

- `POST /api/agents/:id/update` (coordinator-auth) → sets a pending-update flag for
  that node.
- Next heartbeat response carries an `update` directive (a new field on
  `HeartbeatResponse`, analogous to `steamGuard`).
- Agent acts **only when idle** (never mid-build): spawns a **detached updater**
  script and exits. If busy, it defers until the current job finishes.
- Web UI / `/agents`: an "Update" action per node (enabled only when
  `canSelfUpdate`), plus status feedback (updating / updated to epoch N / failed).

### The detached updater (`tools/smith-self-update.{ps1,sh}`)

Runs independently of the agent process so it can swap the binary:

```
1. wait for the agent PID to exit (released file lock)
2. git -C <source-dir> pull --ff-only
3. build to a STAGING output (Build.bat/-Config Release), not over the live exe
4. verify: staged exe runs `smith --version` and prints an epoch >= the old one
5. on success: swap staged exe -> live path; relaunch `smith agent` (same args)
6. on ANY failure (pull/build/verify): DO NOT swap; relaunch the OLD binary
7. report outcome back to the coordinator (POST /api/agents/:id/update-result)
```

Guarantees: a broken pull/build/verify never bricks an agent — the old binary
always comes back up. The swap is the only destructive step and only runs after
verify passes.

### Bootstrap caveat

The *first* hop to a self-update-capable binary is still **manual** per agent
(today's agents don't know how to self-update). After that, updates are remote.

## Security

Remote "git pull + build + exec" is effectively RCE on the agent box. Mitigations:
coordinator-auth on the endpoint; idle-only; per-agent opt-in
(`canSelfUpdate` + a config allow); `--ff-only` pull (no arbitrary refs); build +
verify before swap. LAN-only, trusted coordinator — consistent with Smith's
existing trust model, but called out explicitly.

## Suggested build order

1. **Part 1** (epoch + quarantine + UI) — low risk, mostly coordinator-side;
   immediately shows DRIPS/Snorkels as stale and lets you quarantine them.
2. **Part 2** (capability self-report) — small; prerequisite for Part 3's UI.
3. **Part 3** (update command + updater script) — higher risk; build with
   staging/verify/rollback and trial on ONE agent before fleet-wide.

## Deployment

Per the live-builds hold: build + test locally only; no agent/coordinator restart
until builds finish. Part 1's quarantine and Part 3's command are coordinator-side;
the epoch/capability fields and the updater are agent-side (need the agent binary).
Per CLAUDE.md, no real deploy is run as part of this work.
