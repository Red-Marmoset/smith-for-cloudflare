# Smith self-release workflow — design and implementation plan

Date: 2026-10-04. Scope approved: coordinator/dashboard and native Windows agent,
with explicit promotion. Remains on feature/cloudflare-experiment; no merge.

## Design

A normal `self-release` project product checks out a full commit from the chosen
fork/branch, runs native and Worker tests, builds the agent and Worker bundle, and
produces one immutable `smith-release.zip` artifact. Its manifest identifies
repository URL, branch, full commit, protocol version and SHA-256 of every payload
file. Building never activates the candidate. Logs show URL, branch and commit.

The hosted agent uploads declared exact-file artifacts over authenticated HTTPS;
DO state fences writes by node/job/attempt/lease and records immutable hashes.
R2 stores the bytes. Workspace members can download only recorded artifacts.

A standalone Python promotion utility operates independently of the coordinator
and agent. `plan` verifies the archive and prints the exact targets, source and
hash; `promote` requires that digest as explicit approval. An owner-controlled
local target configuration supplies the Cloudflare account/resource bindings and
agent installation/workspace; candidates cannot choose deployment destinations.
It records an atomic recovery journal before changes, deploys the bundled Worker,
checks the exact release SHA through /health, drains the selected native agent,
then starts the new version from a separate release directory with saved identity.
It retains the previous Worker version and agent binary. Recovery never blindly
repeats an uncertain deployment. Schema-changing releases require a separately
reviewed migration; initial self-promotion only permits the existing binding and
migration shape. Worker rollback never claims to roll back D1/DO data.

The first release is Windows native + Cloudflare Workers. Customer forks configure
the source/branch, origin and deployment target; no Red-Marmoset identifiers are
hardcoded in reusable release/promote logic. Native artifacts and Worker assets
are tied to one tested revision. Coordinator-compatible protocol 2 is required.

## Implementation tasks

1. Native artifact transport and safe drain (HostedAgent, HostedPolicy, native
   tests): tests first; accept exact relative file artifacts package=none, upload
   bounded bytes with attempt headers, fail job if upload fails; recognize a
   protected drain marker only between acknowledged jobs. Clarify checkout logs.
2. Reusable candidate build/package (tools/self-release, smith.json, tests): run
   native suite/build and Worker verify, bundle Worker without executing anything
   during promotion, inventory payload hashes and package a versioned manifest.
3. Standalone promotion (tools/self-release/promote.py and tests): verify all ZIP
   paths/sizes/hashes, immutable source identity, explicit digest approval,
   configured targets, durable journal and recovery/rollback failure tests.
4. Hosted artifacts and visible self-release task: authorize bounded R2 uploads
   through DO attempt checks, immutable artifact records, authorized downloads,
   show candidate artifact links on completed jobs and setup the branch product.
5. Integration: full targeted suites, real self-release build through Smith,
   verify its downloadable manifest and promotion dry-run, commit/push and update
   PR. Do not activate the resulting candidate without explicit user promotion.

## Test obligations

Reject tampered/traversing/oversized archives; never promote failed builds or
unapproved digests. Lost upload responses replay immutably. Cancelled/revoked or
expired attempts cannot publish. Updates wait for job completion acknowledgement.
Test interrupted promotion and a failed new agent/Worker health check, preserve
old binaries and identity, and fail closed on incompatible migration/config.
A healthy new process must be verified before reporting promotion success.

Cloudflare reference: https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/
