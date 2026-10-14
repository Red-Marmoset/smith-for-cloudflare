# Building and promoting a Smith fork

The `self-release` product builds and tests the coordinator/dashboard and Windows
agent from one pinned commit. Its output is `smith-release.zip`, available on the
completed job. **A successful build does not update a running installation.**

The hosted Smith project exposes this as **Build candidate**. Its project preset
records the source repository, requested branch and full commit. Provisioning
from the desired source branch with `cloudflare/coordinator/tools/prepare-tester.mjs`
updates that preset; an already queued job retains its original commit.

The initial hosted self-release run succeeded at `65f88d568834baeb2d491f312f93894842d2db7b`.
Its package passed read-only promotion validation and awaits explicit activation.
See [self-release-evidence.json](self-release-evidence.json) for the job, archive
digest and test results. The standalone operator tool additionally preserves fork
build settings as of `958b7b2`; it is deliberately maintained outside the package.

## Candidate contents and prerequisites

The build runs native tests, the Windows console build, release-tool tests and
Worker verification, then bundles the Worker and dashboard assets. The archive
contains a manifest recording source URL, branch, commit, protocol 2 and a SHA-256
inventory of every file. Agent identity is bound to its executable hash. The same
candidate is used for promotion; promotion does not rebuild branch HEAD.

A Windows build machine needs Git access to the fork, Visual Studio C++ tools,
a bootstrapped Una engine, Python and Node.js/npm. Dependencies are installed from
the checked-in lockfile. Direct invocation is also supported:

```powershell
.\tools\self-release\build.ps1 -Branch feature/cloudflare-experiment -CoordinatorUrl https://exp.redmarmosetstudios.com
```

For a fork, supply its branch and coordinator origin. The builder reads the source
repository from Git `origin`. The reusable `smith.json` product accepts these via
`SMITH_RELEASE_BRANCH` and `SMITH_COORDINATOR_URL` on the build machine.

## Explicit promotion

The standalone `tools/self-release/promote.py` runs outside Smith, so recovery is
available even when the coordinator or agent is unhealthy. Keep this tool and its
operator configuration outside a candidate archive and outside agent job folders.
Copy `target.example.json` into an owner-only directory and configure the exact
Cloudflare target, migration hashes, node identity and installed agent paths.
Never put Cloudflare credentials in project scripts, artifacts or job environment
variables. The operator supplies deployment credentials separately.

Review the downloaded candidate and the target with `plan`. Activation requires
`promote` with the exact package digest shown by that review. Target configuration
is local operator authority; a package cannot redirect the update to another
account, domain or node. For example:

```powershell
python tools/self-release/promote.py plan --target C:\SmithOperator\target.json --candidate C:\SmithOperator\smith-release.zip
python tools/self-release/promote.py promote --target C:\SmithOperator\target.json --candidate C:\SmithOperator\smith-release.zip --approve-sha256 <reviewed-package-sha256>
python tools/self-release/promote.py reconcile --target C:\SmithOperator\target.json
python tools/self-release/promote.py rollback --target C:\SmithOperator\target.json --approve-sha256 <promoted-package-sha256>
```

The updater records intent before changes, validates the coordinator's reported
release commit, drains the agent after its current result is acknowledged, then
starts the new binary from a versioned installation directory. It checks a fresh
heartbeat from that exact agent version. Existing enrollment and workspace remain
in place. It retains the old deployment and binary; interrupted or uncertain
operations require reconciliation rather than blindly deploying again.

For the first upgrade from a version without artifact upload, configure the
`self-release` product without artifact declarations and collect the package from
the successful job's workspace. After promoting both components, enable the exact
artifact path above. Later builds then publish authenticated downloads normally.
The legacy agent is paused by the new coordinator and stopped only after the
coordinator confirms that it has no active job.

## Failure behavior and boundaries

- Artifact publication is fenced by node, job, attempt and unexpired lease.
  Conflicting bytes cannot reuse an artifact name. Downloads require workspace
  membership and successful build completion. Uploads are limited to four exact
  files, 20 MiB each; workspace artifact reservations are capped at 256 MiB.
- ZIP paths, file counts/sizes and all hashes are validated before activation.
  No candidate install hooks or arbitrary deployment scripts execute.
- Initial promotion rejects migration changes. Code rollback does not undo D1
  or Durable Object data. Schema upgrades require a separate reviewed procedure.
- A failed health check must not be reported as a successful update. Previous
  versions and recovery records remain available. An ambiguous external outcome
  is reconciled before a retry or rollback.
- Interruption during local staging before deployment can leave a protected
  staging directory and journal. Reconciliation checks the running release;
  retrying that same package requires operator inspection and cleanup of those
  retained staging records. The tool does not silently delete recovery evidence.
- Windows agent promotion is implemented first. macOS/Linux hosted execution is
  enabled (process-group sentinel crash containment); their agent packages are
  published by hand until promotion covers them.
- Build machines execute trusted repository code under their OS account. They
  are not a sandbox for arbitrary customer code; give separate customers separate
  build machines/accounts and scoped source credentials. The updater strips its
  Cloudflare deployment credentials from the agent process environment.

This release workflow does not yet restore the original project-management UI,
automatically track branch tips, or provide unattended promotion. Those are
separate migration tasks; candidate builds remain explicitly pinned and activation
remains explicit.
