# Add a project from a Git URL (hosted coordinator)

Date: 2026-10-05

Status: **design for review**. Scope is the **Cloudflare-hosted coordinator** and the
**hosted agent** only; the LAN coordinator is unchanged. Builds on the
[Cloudflare coordinator design](2026-10-04-cloudflare-coordinator-design.md).

## Goal

From the hosted dashboard, add a project by pasting a Git URL. Smith reads the repo's
`smith.json` and offers its build actions as **Build** buttons. It must work for our own
private repos (soccer-boy, senet, smith), all of which have a `smith.json`.

Success: an owner adds `git@github.com:Red-Marmoset/senet.git`, and without editing JSON
or calling the API, senet's build actions appear and `build-check / ci-build` builds the
current tip of the branch on a machine that can clone it.

## This is piece 1 of 3

| Piece | What | Status |
| --- | --- | --- |
| **1** | Add project from a Git URL; read `smith.json` (machine scan + GitHub API fast path); branch-tip builds; access-aware routing | **this spec** |
| 2 | Detection for repos without `smith.json` (`build.bat`/`build.sh`, Unity, Unreal, ...) | later spec |
| 3 | GitHub as a source: repo/branch dropdown, tokens from **Link GitHub** | later spec |

Piece 1 leaves a **source** choice in the dialog (only *Git URL* for now) and a
**reader** seam, so pieces 2 and 3 plug in without reshaping anything.

## Decisions already made (with the user, 2026-10-05)

1. Build actions come from the repo's **`smith.json`**; detection is piece 2.
2. A build checks out the **branch tip at build time** and records the commit it used.
3. `smith.json` is imported **as is**: every rule becomes an action, deploy rules included.
   Senet's `deploy-prod` becomes a real button that deploys production.
4. **Nothing blocks adding a project.** Saving needs only a URL; the build actions appear
   once something can read the repo. Until then the card says so.
5. A machine that cannot read the repo is skipped; the work **waits for a machine that can**.
6. Two readers: an online **machine scans** the repo with its own Git login (works for any
   host, private or not), and a **GitHub API fast path** when the workspace holds a GitHub
   token that can read the repo. The token comes from **workspace settings** now, and from
   **Link GitHub** in piece 3.

## User experience

### Adding

**Projects → Add project** (owners and admins, the same people who may add projects through
the API today). The dialog has:

- **Source**: a dropdown with one entry, *Git URL*.
- **Repository URL**: `https://…`, `ssh://…` or `git@host:owner/repo(.git)`, any host. No
  embedded credentials, no whitespace.
- **Branch** (optional): blank means the repo's default branch.

**Add** saves the project and closes the dialog. When the workspace's GitHub token can read
the repo, the same request reads `smith.json` through the GitHub API (time-limited to 5
seconds) and the card shows the actions straight away. Otherwise, or if that read fails or
times out, the request queues a machine scan instead and the card shows one of:

- *Waiting for a machine that can read this repo.* with the machines that tried and why
  (for example *DESKTOP-SEM: no access*). This sits where the build actions will go.
- *Scanning on DESKTOP-SEM…*, then the actions.
- An error with the scan's log: *no `smith.json` at <commit>* (detection is piece 2), or
  *`smith.json` is invalid: <reason>*.

### The project card (repo projects)

- Name (from `smith.json` `project.name`, else the repo name), URL, branch, the last commit
  Smith saw and when, and how it was read (*GitHub* or *machine name*).
- The build actions, each with a **Build** button and, where they apply, short notes:
  *handoff not run in hosted builds*, *needs another build's artifacts (not supported here
  yet)* (button disabled), *artifact globs/packaging not collected here yet*.
- *N actions not used on branch X* and *N disabled actions*, expandable.
- **Rescan** (re-reads `smith.json`; clears no-access marks for this project).
- *Builds are manual here; `smith.json` triggers are ignored.*

Operator-prepared projects (pinned commit, explicit products) keep their current card and
behaviour.

### Workspace settings

A **GitHub token** field beside the existing Cloudflare token, with the same write-only
behaviour: the page shows only whether it is set and when it was updated, with Replace and
Clear. The help text asks for a **fine-grained, read-only** token with *Contents: read* and
*Metadata: read* on the repos (or the organisation) Smith should read.

## How `smith.json` becomes build actions

One mapping, in TypeScript (`src/pipeline.ts`), used by every reader and at build time.

- Each `buildProducts[].rules[]` becomes one **action**. Its ID is `product/rule`; for a
  product with `discover`, one action per discovered variant, ID `product/rule/<variant-slug>`,
  label `product / rule · Variant Name`.
- `discover` `files`: glob over the repo's file list at that commit (variant = file stem);
  `list`: the declared values. `classify` sets each variant's OS, extra labels and preferred
  OS exactly as LAN Smith does (`Variants.cpp`).
- **OS**: the keys of the rule's `command`/`steps` (`windows`, `linux`, `mac`), narrowed by the
  variant's classified OS.
- **Labels**: `nodeSelector.labels` plus the variant's labels.
- `branches` globs are matched against the project's branch; non-matching rules and
  `enabled: false` rules are counted, not offered.
- Carried into the job: `workingDir`, `env`, `timeoutSeconds`, `successExitCodes`, the command
  or ordered `steps`, exact artifact paths. Variables substituted as in LAN Smith:
  `${VARIANT}`, `${VARIANT_SLUG}` (named by `discover.as`), `${OUTPUT}` from `outputPath`, and
  `SMITH_BRANCH` / `SMITH_COMMIT` in the environment.
- Not run here yet, and said so on the action: `handoff` steps, `inputs` (action disabled),
  artifact globs/packaging. `triggers` are ignored. LAN coordinator-provided env does not
  exist here; the workspace's own job env (Cloudflare token/account ID) still applies.
- Limits: `smith.json` ≤ 256 KB; ≤ 100 actions per project; file list ≤ 50,000 paths.

**Parity with LAN Smith.** Fixtures (`test/fixtures/smith-json/`: copies of soccer-boy, senet
and smith's `smith.json` plus edge cases, each with a file list and the expected actions) are
checked by the TypeScript tests and by a C++ test that runs `ParseProjectConfig` and
`DiscoverVariants` on the same inputs. The two cannot drift silently.

## Readers

Both readers produce the same **scan report**: `{ commit, branch, defaultBranch, smithJson:
string | null, paths: string[] }`. The coordinator maps it with `pipeline.ts` and stores the
result on the project.

### GitHub API fast path (Worker)

Used when the URL is a `github.com` repo and the workspace has a GitHub token:
`GET /repos/{o}/{r}` (default branch), `GET /repos/{o}/{r}/commits/{branch}` (tip SHA),
`GET /repos/{o}/{r}/contents/smith.json?ref={sha}` (raw), and
`GET /repos/{o}/{r}/git/trees/{sha}?recursive=1` (paths). All calls use `redirect: 'manual'`
(the Workers runtime rejects `redirect: 'error'`). A 401/403/404, a truncated tree that a
`discover` needs, or any other failure falls back to a machine scan with a note on the card;
it never blocks the project. The token is never sent to browsers, agents or MCP clients.

### Machine scan (hosted agent)

A **scan job** goes through the normal queue (claim, lease, logs, cancel, complete), so it is
visible in **Builds** as *Scan* with its log. Any online build machine with the new
`smith-repo-projects` capability can take it; it has a spec for every OS and no other labels.

The agent, in a temporary directory under its workspace, with `GIT_TERMINAL_PROMPT=0`:
`git clone --depth 1 --filter=blob:none --no-checkout [--branch <branch>] <url> <dir>`; with
no branch the clone follows the remote's default, which `git rev-parse --abbrev-ref HEAD`
then names. It reads `git show HEAD:smith.json` (fetches just that one blob; absent is fine)
and lists paths with `git ls-tree -r --name-only HEAD` (capped), then deletes the directory.
It completes with the scan report attached to the job result. No file contents are
downloaded beyond `smith.json`, so even a large Unity repo scans in seconds.

## Builds of repo projects

1. **Enqueue**: the job's specs carry the repo URL, the project branch, an empty commit, and
   `resolve: { action: "<action id>" }`; required labels are the action's labels plus
   `smith-repo-projects`. OS keys come from the action.
2. **Claim**: as today, plus repo-access routing (below).
3. **Checkout**: the agent clones and checks out the **branch tip** (the LAN branch-tip path,
   commit `a26e413`), then runs submodules.
4. **Resolve**: the agent posts `POST /resolve` with its lease and a scan report built from the
   checkout (`commit`, `smith.json`, paths). The coordinator maps it, finds the action for the
   node's OS, records `commit` and the resolved command on the job, updates the project's
   actions from this report (a free rescan), and returns the command, steps, working dir, env,
   timeout, success codes and artifacts. If the action no longer exists at that commit, it
   answers with an error and the build fails with *"<action> is not in smith.json at
   <commit>; the project was rescanned"*.
5. **Validate and run**: the agent runs `ValidateHostedSpec` on the resolved spec (commit now
   known) and executes it as any hosted job.
6. **Complete**: the result includes `commit`; **Builds** shows it.

Prepared projects keep enqueue-time freezing and the pinned-commit requirement.

## Repo access routing

- The agent classifies clone/fetch failures. Messages such as *Permission denied
  (publickey)*, *Repository not found*, *Authentication failed*, *could not read Username*
  and *Host key verification failed* complete the attempt with `failure: "repo_access"`;
  network errors (*Could not resolve host*, timeouts) are ordinary failures.
- On `repo_access` the coordinator records `(project, node, message, at)` in a new
  `repo_access` table and **returns the job to the queue** instead of finishing it.
- `claim` skips a queued scan or build whose project has a no-access mark for this node newer
  than one hour. **Rescan** clears the project's marks.
- The card and the queued build show *Waiting for a machine that can read this repo* with the
  marks. Cancel works as for any queued job.

## Compatibility and rollout

- Old agents never see the new jobs: scans and repo builds require the
  `smith-repo-projects` label, which only updated agents advertise.
- `ResolvedJobSpec` (`contracts.ts`) and `JobSpec` (`SmithProtocol/WireTypes.h`) gain an
  optional `resolve`; `JobResult` gains optional `commit`, `failure` and `scan`. Old fields and
  prepared projects are unchanged.
- Rollout: deploy the Worker, then update agents (`SmithAgent.bat update` or
  `PackageAgent.bat --install`). Until an updated agent is online, repo projects wait (or read
  via GitHub when a token is set).

## Security

- Adding and rescanning: owners and admins, as `put-project` today. Building: unchanged
  (anyone allowed to start builds, including coding-agent tokens with build scope). With
  decision 3, that includes deploy actions; see *Open points*.
- URLs: HTTPS/SSH/`git@` only, no credentials, ≤ 256 characters; the agent policy already
  enforces the same.
- The GitHub token is stored like the Cloudflare token (the workspace's `secrets` table),
  never added to job env, never returned by the API.
- Resolved commands come from the repo at the checked-out commit, which is the code being
  built anyway; the job records exactly what ran.

## Testing

- **TypeScript**: `pipeline.ts` mapping against the shared fixtures; add-project and rescan
  through the workspace (GitHub fast path with a fake GitHub whose `fetch` builds a real
  `Request`, fallback to machine scan, no-access requeue and the one-hour expiry, Rescan
  clearing marks, `/resolve` success, missing action, OS selection); permissions; the GitHub
  token never appearing in job env, API responses or logs.
- **C++**: scan and branch-tip checkout against a local bare repository; failure
  classification; `ValidateHostedSpec` with `resolve`; the parity test over the fixtures.
- **Hosted runtime test** (`Tests/SmithHostedAgentTest`): one end-to-end scan and build.
- **Manual**: add soccer-boy, senet and smith on the live experiment; build only
  non-deploying actions (for example senet's `build-check / ci-build`). **Never click a deploy
  action during testing.**

## Open points for review

1. **Who may add projects.** This spec keeps owners and admins. Opening it to operators is a
   one-line change.
2. **Deploy buttons and coding agents.** Importing deploy rules as-is means a coding agent
   holding a build-scoped token could start `deploy-prod`. A later option: mark actions with
   deploy-like names or handoffs as *people only*.
3. **Secret storage.** Workspace secrets, including this token, are stored as plain values in
   the workspace's Durable Object storage (encrypted at rest by Cloudflare), matching the
   existing Cloudflare token. Encrypting all workspace secrets with a Worker-held key is a
   separate change.
