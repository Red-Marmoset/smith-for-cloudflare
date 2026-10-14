# Artifact inputs (fan-in) — design

**Date:** 2026-06-10 · **Status:** approved (approach + matching semantics chosen by Sem)

## Problem

A deploy rule often needs the *outputs* of earlier build jobs that ran on other
nodes. Concretely: soccer-boy's `steam-deploy` runs on the Windows/steamcmd box
and must upload `builds/steam-{windows,mac,linux}`, but those are produced by
three `unity` builds on three different machines, whose artifacts only
`collect` up to the coordinator. There is no path from the coordinator's
artifact store back down into a later job's workspace — `steam-stage.ps1`'s
`-Share` ("Phase 2" SMB staging) was the placeholder.

## Decision

**Declarative artifact inputs** (chosen over copyShare/SMB staging and
script-side API pulls): a rule lists the builds it consumes; Smith moves the
bytes. Matching is **latest successful build per input, same project + branch,
warn on commit divergence** (chosen over strict same-commit).

## smith.json schema

A `BuildRuleDef` gains an optional `inputs` array:

```json
"inputs": [
  { "product": "unity", "variant": "Steam (Windows)" },
  { "product": "unity", "variant": "Steam (Mac)" },
  { "product": "unity", "variant": "Steam (Linux)" }
]
```

`product` is required; `variant` is optional (empty matches builds with no
variant). Inputs always resolve within the same project.

## Wire format (SmithProtocol)

`JobSpec` gains `std::vector<ArtifactInput> inputs` — fully resolved by the
coordinator, preserving the "no further lookups" contract:

```cpp
struct ArtifactInput
{
    std::string jobId;        // source build to download from
    std::string archiveName;  // stored artifact filename (one entry per artifact)
    std::string product;      // for logging
    std::string variant;      // for logging
    int buildNumber = 0;      // for logging
    std::string commit;       // for divergence warning
};
```

JSON-additive (old agents ignore the field), so `kProtocolVersion` stays 1.
Caveat documented in FEATURES.md: rules with `inputs` need agents running a
build that understands them — the coordinator cannot tell.

## Coordinator resolution (at dispatch)

When resolving a `JobSpec` from a rule with inputs, for each input pick the
**highest `buildNumber`** record with: same `projectId`, `product` ==
input.product, `variant` == input.variant, `branch` == the job's branch,
`status` == "success", non-empty `artifacts`. Every artifact of the chosen
build becomes one `ArtifactInput`.

If any input has **no** matching build, the job fails immediately ("error",
message names the unresolvable input) rather than dispatching a job that
cannot succeed.

New agent-facing route (mirrors the upload route, `guard` = token/loopback):
`GET /api/jobs/:jobId/artifacts/:name` → existing `HandleArtifactDownload`.

## Agent staging (after checkout, before the command)

For each `ArtifactInput`: log
`INPUTS: staging <archiveName> from <product>/<variant> build #<n> (<commit>)`,
download via the new route, then:

- `*.zip` → extract into the job's resolved **working dir** (engine
  `File::ZipExtract`). Zip entries are relative to the *producing* job's
  working dir, so producer and consumer using the same `workingDir`
  convention (both "." here) line up — this contract is documented.
- anything else → written as a file into the working dir under its name.

If the distinct non-empty `commit` values across inputs exceed one, log a
prominent `WARNING: inputs span N commits (...)` and continue. A failed
download/extract fails the job ("error") before the command runs.

## Failure modes

| Case | Behaviour |
|---|---|
| No successful build for an input | Job fails at dispatch with a clear message |
| Download/extract fails on the agent | Job "error" before the command runs |
| Inputs at different commits | Warning lines in the job log; proceed |
| Old agent receives inputs | Field ignored (documented caveat) |

## Tests

- **SmithProtocolTest**: `JobSpec.inputs` JSON round-trip (filled + absent).
- **SmithCoreTest**: `inputs` parsing from smith.json (present, missing, partial).
- **SmithCoordinatorTest**: resolution — picks latest success per variant,
  skips failed/foreign-branch/empty-artifact records, errors when unresolvable.

## Affected consumers

soccer-boy `publish-steam` gains the three-input block; `steam-stage.ps1` keeps
its no-`-Share` verify role unchanged. FEATURES.md gets an "Artifact inputs
(fan-in)" section; README's artifact contract paragraph gets a pointer.

## Out of scope (YAGNI)

Cross-project inputs, strict same-commit mode, renaming/`extractTo` targets,
auto-triggering deploys when all inputs are fresh.
