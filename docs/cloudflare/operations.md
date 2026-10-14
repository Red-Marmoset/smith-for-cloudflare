# Cloudflare experiment operations

The `smith-experiment` Worker serves **https://exp.redmarmosetstudios.com**.
The dashboard supports invitation sign-in, workspace selection, prepared project
builds, machine enrollment/status, cancellation and live output. A SQLite Durable
Object owns each workspace's membership, nodes, projects, frozen jobs, leases,
logs, events and projection outbox. D1 stores user sessions, invitations, workspace
directory and rebuildable history. Private R2 stores the downloadable agent
packages (`smith-experiment-{windows,mac,linux}.zip`; one not uploaded yet is
listed as *coming soon* by the dashboard). No tunnel or local coordinator is involved.

Native compilation runs on connected Windows, macOS and Linux agents. These
authenticate over HTTPS using protocol 2, check the full pinned Git revision out
into a fresh directory, execute the prepared repository script, renew leases and
forward output/results. A machine keeps **one Git store per repository**
(`repos/<hash>.git` under its agent directory, keyed by the repository URL alone):
every workspace, project, job, chat and crew member that uses that repository fetches
only what changed into the one store, and each job, chat or crew checkout (a crew
member's own copy, and the related projects a crew run reads) is a local clone of it
whose objects are hard links, so a project present in several workspaces is held
once per machine (a machine that keeps Smith's own copy of a Smith-hosted repository
clones that copy directly). Only the three most recent job directories are kept.
Credentials and recovery records are owner-only files. A Windows job object (kill-
on-close) or a POSIX process-group sentinel stops child processes if the agent dies;
a restarted agent reports interrupted work without re-executing it. A second agent
cannot use the same workspace directory.

## Verify and deploy

On Windows, run `DeployWorker.bat` from the repository root. It refuses
uncommitted or unpushed code, runs `npm ci` and `npm run verify`, checks your
Cloudflare login, shows the commit and asks before applying D1 migrations and
deploying with that commit as `RELEASE_SHA` and its version as `RELEASE_VERSION`, then
checks `/health` reports it.

Smith's version is semantic: the `VERSION` file at the repository root holds
`major.minor.patch` (starting at `0.1.0`), and the deploy appends the commit count
(`git rev-list --count HEAD`) as a fourth part, e.g. `0.1.0.239`. `/health` reports it
as `version`, and the dashboard shows it beside "Experiment" in the header, with the
full commit on hover. Bump `VERSION` by hand for a release; the fourth part moves by itself.

The same steps by hand, with Node.js 22+ (24 recommended) from `cloudflare/coordinator`:

```sh
npm ci
npm run verify
npx wrangler d1 migrations apply smith-experiment-identity --remote
npx wrangler deploy --tag <source-commit> --var RELEASE_SHA:<source-commit> --var RELEASE_VERSION:<VERSION>.<commit count>
```

Workspace Durable Objects migrate themselves on first use. Migration 9 is the chat's
`ai_turns.use_api_key`; the autonomous crew is 10 (members, sessions, tokens, machine
toggles), 11 (scheduler), 12 (proposals) 13 (crew-created projects), 14 (crew files and budgets), 15 (members) and 16
(Smith-hosted repositories: the per-machine hosting switch and the agent's hosting report). A local development
database that ran an early build of the crew branch has different tables under those numbers
and needs a reset (delete the `wrangler dev` state directory, then reseed).

Smith-hosted repositories (below) relay git through an R2 bucket and keep their backups
in it. Create it once, with two lifecycle rules (relay objects live a day; incomplete
multipart uploads are aborted after a day), before the first deploy that carries the `GIT`
binding; `DeployWorker.bat` refuses to deploy until the bucket exists:

```sh
npx wrangler r2 bucket create smith-experiment-git
npx wrangler r2 bucket lifecycle add smith-experiment-git relay-expiry --prefix relay/ --expire-days 1
npx wrangler r2 bucket lifecycle add smith-experiment-git abort-uploads --abort-multipart-days 1
npx wrangler r2 bucket lifecycle add smith-experiment-git import-expiry --prefix imports/ --expire-days 30
```

Large files (Git LFS) live in the same bucket under `lfs/<workspace>/<project>/<oid>`,
with no expiry rule. Two vars in `wrangler.jsonc` name the account and bucket
(`R2_ACCOUNT_ID`, `GIT_BUCKET`) and `LFS_PROXY_MAX_BYTES` is the per-object cap while
objects move through the Worker (100 MiB, the request-body limit on Free and Pro
plans; raise it on a Business plan). To send objects straight to R2 instead, create an
R2 API token with Object Read & Write on the bucket and set its pair once:

```sh
npx wrangler secret put R2_ACCESS_KEY_ID
npx wrangler secret put R2_SECRET_ACCESS_KEY
```

Settings → Large files then reads "Large files go straight to R2". Presigned URLs
last an hour; the coordinator verifies each upload by hashing the stored object.

Machines switched on for **Keep copies here** (`POST /nodes/:id/host`; one switch and one
budget for repositories and large files alike, see below) keep copies of large files
under `<agent root>/lfs/<workspace>/…` while the reserve from Settings stays free, take
fetch / restore / drop tasks on `git/poll` and move bytes through
`GET|POST|PUT /lfs/task/:id/{body,target,object,complete}` (node). `POST /lfs/check`
(owners) queues every ready object for a check against R2; a missing one is marked lost
and restored from a machine holding a copy.

Projects whose home is Cloudflare Artifacts are served through `/git/<project>.git` by proxy:
the Worker holds repo-scoped Artifacts tokens in the workspace object's `artifacts_tokens`
table (read tokens an hour, write tokens ten minutes) and passes smart-HTTP requests
through; machines fetch their copies through the same address with a ticket and never see
an Artifacts token. Artifacts down means reads fall over to a machine holding a current
copy and pushes are refused with "Smith's storage is unreachable". No bundle backups are
taken for Artifacts homes; the original history of a rewritten import is kept under
`backups/<workspace>/<repoUuid>/original-<jobId>.bundle` (a `git_backups` row of kind
`original`, counted in the backup budget, downloadable from the card).

Copies on machines share one switch and one budget per machine (`nodes.copy_budget_bytes`,
NULL for the workspace default `copyBudgetBytes`); the planner (`copies.ts`) places
`copiesPerItem` copies of every repository and large file by unused budget. The
`nodes/:id/lfs` route is gone; `nodes/:id/host` takes `{ host, budgetBytes }`.

Import from GitHub queues one `import` job per repository (`required_labels: smith-import,
git-lfs`; agents advertise `smith-import` when git-lfs is on PATH). The job pushes the
repository straight to the Artifacts remote with a 2-hour write token (the Worker's 100 MB
request cap would refuse a large first push) and the large files to Smith's LFS with a
job-bound write ticket. Schema version 22 adds `imports`, `import_repos`, `job_blobs`,
`artifacts_tokens`, `nodes.copy_budget_bytes` and `meta.homes_assigned`; the first alarm
after deploy assigns a home to every existing project (`home.ts`).

Projects started in Smith go to Smith's storage (Cloudflare Artifacts) first when the
workspace has it: the Worker unpacks the zip, makes the first commit and pushes it (smart
HTTP receive-pack, the only write Artifacts offers), so no machine is needed. Storage is
then the project's home: machines switched on for copies take theirs through the proxy and
pushes land in storage directly. Files over 32 MB or projects over 1 GB go to a machine
instead.

The third rule is a fallback: a zip uploaded to start a project (`imports/<workspace>/`) is deleted as soon as
its repository exists, and kept after a failed attempt so **Try again** needs no second upload.

Wrangler configuration contains only nonsecret resource IDs. Verify runs generated
type checks, Workers-runtime tests and a deployment dry-run. `workers.dev` and
preview URLs are disabled. This deploys the experiment coordinator, never the
applications that Smith builds. Retain existing D1/DO migrations on rollback;
use a forward migration for incompatible schema changes.

## Tester access and native package

Create an operator directory restricted to the current OS account, then run:

```sh
node tools/prepare-tester.mjs --state-dir <owner-only-directory>
```

The tool requires `CLOUDFLARE_API_TOKEN` with experiment D1 access. It creates an
individual user, a one-hour single-use invitation, a 24-hour operator API session,
and a Smith build preset pinned to the current Git HEAD. Push that commit first.
It saves credentials only in the restricted directory; do not check them in.
Repeated runs update that tester's preset and invitation. The browser receives a
Secure/HttpOnly/SameSite=Strict seven-day cookie. Mutations require same-origin
CSRF tokens. There is no public account registration or shared login credential.
Google and GitHub sign-in are available once configured; see [signing in](sign-in.md).
`NewInvite.bat` makes a sign-in code using your Wrangler login instead.

Build the native console and package from the repository root with
`PackageAgent.bat` (add `--install C:\SmithAgent` to update a local agent folder,
or `--upload` to publish the zip as the dashboard download after a confirmation).
By hand:

```powershell
.\Build.ps1 -Project Smith -Config Release
python tools/package-experiment.py
Compress-Archive -Path Build/SmithExperiment/Release/* -DestinationPath Build/SmithExperiment/smith-experiment-windows.zip -Force
```

Upload from the coordinator directory:

```sh
npx wrangler r2 object put smith-experiment-releases/smith-experiment-windows.zip --file ../../Build/SmithExperiment/smith-experiment-windows.zip --remote
```

Only signed-in users may download a package. The dashboard asks
`GET /api/v2/downloads` which of `smith-experiment-{windows,mac,linux}.zip` exist in
R2 and links those; the rest read *coming soon*, so publishing a macOS or Linux
package is the same `wrangler r2 object put` with that name - no Worker change or
redeploy needed. A macOS/Linux package is the `Smith` binary from that OS's
`Build.sh` run (e.g. collected from a LAN-coordinator build on the Mac) plus the
`config/experiment` launchers; `tools/package-experiment.py --zip <file>` writes the
zip itself so that `Smith` and `start-smith.sh` keep their execute bits even when
packaged on Windows:

```powershell
python tools/package-experiment.py --binary-dir <dir holding Smith> --output Build/SmithExperimentMac/Release --zip Build/SmithExperimentMac/smith-experiment-mac.zip
```

See `config/experiment/README.md` for machine requirements and enrollment. Keep running agents outside package
output directories so repackaging cannot overwrite runtime state.

## API and failure semantics

The branch also includes a [self-release build and explicit promotion workflow](self-release.md)
for both the hosted coordinator/dashboard and Windows agent. Building a candidate
does not activate it. Its artifact and drain routes below require promotion of
the new coordinator; the initial bootstrap build collects its package from the
successful agent workspace because the older running agent cannot upload it.

JSON mutations reject unknown fields and cap bodies at 64 KiB. Every human API
request checks current workspace membership. Node credentials authorize only
their workspace. Removing a D1 session revokes that session; node revocation fences
its active attempt. A D1 outage fails user sign-in closed while active node lease
operations continue against authoritative DO state.

Routes below are under `/api/v2/workspaces/:id`:

| Route | Behavior |
| --- | --- |
| `GET /projects`, `POST /projects` | Read presets; admins/owners may prepare pinned repository commands |
| `POST /projects` with `{ "source": "git", "url", "branch"? }` | Owners/admins add a project from a Git URL; Smith reads its smith.json via the workspace GitHub token or a machine scan (see below) |
| `GET /github/repos`, `GET /github/branches?repo=owner/name` | Owners/admins list what their GitHub link (else the Settings token) can see, for the add-project picker; `configured:false, reason:'link'` means link GitHub first |
| `POST /projects/:projectId/rescan` | Owners/admins re-read smith.json and clear the project's "no access" marks |
| `POST /resolve` (node) | A branch-tip build posts what it checked out (commit, smith.json, file list) and receives its command |
| `GET /settings`, `POST /settings` | Workspace settings (name, machine-offline threshold, queued-build supersede, Cloudflare account ID + API token, GitHub token, and the crew settings below); admins/owners may write |
| `GET /crew`, `POST /crew` | Crew members: list them with their status, or create/update one (see [Crew](#crew)); operators and above write, and only owners/admins may switch on `mayCreateProjects` |
| `POST /crew/:crewId/enable`, `/run`, `/delete` | Pause or resume a member, run it now (or as a dry run), delete it (refused while a run waits, is queued or running) |
| `GET /crew/:crewId/runs`, `GET /crew/:crewId/prompt` | A member's recent runs; the prompt a run would get, without running |
| `GET /crew/runs/:sessionId`, `/events`, `POST /crew/runs/:sessionId/stop` | A run's transcript, its events after a cursor, and Stop (operators and above) |
| `GET /crew/review`, `POST /crew/review/:sessionId`, `POST /crew/review/:sessionId/verify` | The proposal queue; accept or dismiss one (`{status, note?}`); queue its Verify build (`{requestId}`); operators and above |
| `GET /crew/messages`, `POST /crew/messages`, `POST /crew/messages/:seq/delete` | The crew's messages, a person's message to a member or everyone, and deletion |
| `POST /crew/projects/:projectId/delete` | Remove a project a crew member created |
| `POST /nodes/:nodeId/crew` | The machine's owner turns "Run crew members on this machine" (`run`) and, on build machines, "even while a build runs" (`whileBuilding`) on or off |
| `GET /nodes` | Machine capabilities, active state and last contact |
| `POST /enrollments`, `POST /nodes/enroll` | Ten-minute one-use enrollment; protocol 2 required |
| `POST /nodes/:nodeId/revoke` | Revoke and fence active work |
| `POST /nodes/:nodeId/drain` | Owner/admin pauses new assignments; current work can finish |
| `GET /jobs`, `POST /jobs` | List jobs or enqueue a project/product with an idempotent requestId |
| `GET /jobs/:jobId` | Authoritative state and completion result |
| `GET /jobs/:jobId/logs?after=-1` | Ordered output chunks after an exclusive sequence cursor |
| `GET /jobs/:jobId/artifacts/:name` | Authenticated download from a successful job |
| `POST /artifacts` | Node uploads a declared exact file with its active attempt and SHA-256 |
| `POST /projects/:projectId/mirror` | Owner/admin copies the project's repository into Cloudflare Artifacts and switches builds to the copy (`{requestId}`; see below) |
| `POST /projects/:projectId/sync` | Owner/admin pulls the linked repository into Smith's copy, or pushes the copy to it (`{requestId, direction: "pull" \| "push"}`; see *Linked repository* below) |
| `POST /projects/:projectId/upstream` | Owner/admin links a copied project to a repository (`{url}`) or detaches it (`{url: ""}`) |
| `POST /projects/:projectId/host` | Owner/admin copies the project's repository onto the build machines switched on to keep copies and switches builds to Smith's copy (`{requestId}`; see "Smith-hosted repositories") |
| `GET /projects/:projectId/clone-info` | The clone URL, username and default branch of Smith's copy |
| `POST /projects` with `{source: "empty", name, branch?}` | Owner/admin starts a project in Smith with one README commit; a machine that keeps copies (with an agent that advertises `smith-git-init`) creates the repository (see "Projects started in Smith") |
| `POST /projects/import?name=…&branch=…&file=…` (raw zip body, at most 100 MB) | Owner/admin starts a project in Smith from a zip; the Worker stores it under `imports/` in the `GIT` bucket and queues the host job |
| `POST /imports` `{org, repos[], thresholdBytes, link}`, `GET /imports`, `GET /imports/:id`, `POST /imports/:id/retry` `{fullName}`, `POST /imports/:id/cancel` | Owner/admin imports a GitHub organisation's repositories into Smith's storage, one `import` job per repository (see "Import from GitHub" in the user guide) |
| `GET /imports/github/orgs`, `GET /imports/github/repos?org=…&threshold=…` | The organisations the person's GitHub link (or the workspace token) can see, and one organisation's repositories with the large-file preflight |
| `POST /projects/:projectId/move-to-storage`, `POST /projects/:projectId/restore-to-storage` | Owner/admin moves a project's home into Smith's storage (every branch and tag), or pushes a machine's current copy back into storage after a loss |
| `GET /projects/:projectId/backups/:backupId` | Owner/admin downloads a rewritten import's original history (an `original` backup) |
| `POST /jobs/:jobId/blobs/:name?part=N`, `POST /jobs/:jobId/blobs/:name/complete` (node) | An import job uploads its original-history bundle in 5 MiB parts under its lease (`X-Smith-Lease-Token`) and completes it with size and SHA-256 |
| `GET /jobs/:jobId/import` (node) | The machine running a zip project's host job downloads the zip (`X-Smith-Attempt-Id`, `X-Smith-Lease-Token`) |
| `POST /nodes/:nodeId/host` | Owner/admin switches a build machine on or off for keeping copies (repositories and large files) in this workspace, and sets its budget (`{host: boolean, budgetBytes?: number | null}`, null for the workspace default) |
| `POST /git/poll`, `POST /git/tips` (node) | A hosting machine takes relayed git requests (renewing what it holds) and reports its copy's refs |
| `GET /git/relay/:id/body`, `POST /git/relay/:id/response?part=N`, `POST /git/relay/:id/complete` (node) | The machine fetches a relayed request body, uploads its response in 5 MiB parts and records the outcome (`X-Smith-Lease-Token`) |
| `GET /git/task/:id/body?backup=…`, `POST /git/task/:id/part?part=N`, `POST /git/task/:id/complete` (node) | A task handed out on `git/poll` (replicate, backup, restore, discard, promote): the machine downloads a bundle, uploads one in parts, and reports the outcome (`X-Smith-Lease-Token`) |
| `POST /projects/:projectId/restore` | Owner/admin restores Smith's copy from its backups onto a machine that keeps copies |
| `POST /projects/:projectId/accept-dataloss` | Owner/admin accepts a restored copy that is behind Smith's record as the repository |
| `POST /projects/:projectId/recovered` | Owner/admin decides about a ref a copy held that the record never had (`{nodeId, ref, action: "promote" \| "discard"}`) |
| `POST https://<origin>/git/<project>[.git]/info/lfs/objects/batch`, `PUT`/`GET …/objects/<oid>`, `POST …/objects/<oid>/verify` | Git LFS for any project of the workspace; the same credentials as git (see "Large files") |
| `GET https://<origin>/git/<project>[.git]/info/refs?service=…`, `POST …/git-upload-pack`, `POST …/git-receive-pack` | Smart-HTTP git for Smith's copies, HTTP Basic with a Smith token as the password (see "Smith-hosted repositories") |
| `POST /jobs/:jobId/cancel` | Cancel queued/active work; runner terminates on the next fenced request |
| `POST /claims`, `/renew`, `/logs`, `/complete` | Node lease, output and completion protocol |
| `POST /heartbeat` | Update detected machine capabilities and last contact |

Account routes: `GET /auth/me` returns the signed-in user's display name, e-mail
and display preferences; `POST /auth/profile` updates them (same-origin + CSRF).

Jobs freeze project commands and full commit SHA at enqueue. Scheduler matches OS
and all required labels. The browser retains an enqueue request ID after a lost
response, including across reloads. Claims replay the current assignment; identical
completion replay succeeds and conflicting replay fails. Leases last 90 seconds,
renew every 20 seconds, and the native watchdog stops execution before expiry.
Expired/revoked jobs become `lost`, with no automatic retries.

Limits: 20 workspaces/user, 20 project presets/workspace (projects a crew member creates
count too), 1,000 lifetime jobs and 50 nodes/workspace, 20 outstanding enrollment codes,
4 MiB output/job. Crew: 50 members/workspace, 30 runs kept per member, 1,000 lifetime Verify
builds/workspace, a report of at most 32 KiB in a run's finish (64 KiB through `crew_report`),
a member's memory of 32 KB, messages of 8,192 bytes with 20 per run and the newest 2,000 kept. Output is
currently stored in DO SQLite; browser display retains the newest 500,000
characters. Every transition writes an event and outbox entry atomically; alarms
retry monotonic D1 history projection independently of job completion.

## Projects from a Git URL

**Add project** is one form: pick a repository from the list your GitHub link can see
(or choose *Another Git repository* and paste an `https://`, `ssh://` or `git@host:owner/repo`
URL, no password), an optional branch (blank = the repo's default), and a **Store a copy on
Cloudflare Artifacts** checkbox (shown when Artifacts is available; the copy starts as soon
as Smith has read the repository). Operator-prepared pinned projects still come through the
API (`POST /projects` with a pinned commit); the dialog no longer offers that mode. Saving never
waits: the project appears at once and its build actions arrive when its `smith.json`
has been read, by one of two readers:

- **GitHub fast path.** A GitHub repo is read through the API within the same request
  using, in order, the GitHub link of the person adding the project, any other member's
  link, and finally the optional token in Settings → Workspace → GitHub. Tokens never
  reach jobs, browsers or MCP clients, and any failure (404, timeout) falls back to a scan.
  **Add project** also lists the repositories the person's link can see (`GET /github/repos`),
  so nobody types a URL; **Connect GitHub** starts the link from inside the dialog.
- **Machine scan.** Otherwise a `scan` job ("read smith.json" in Builds) goes to any
  online agent advertising the `smith-repo-projects` label. The agent makes a shallow,
  blob-less clone with its own Git login (or, for a repository already in its shared
  store, a local clone of that) and reports the commit, `smith.json` and the file list.

Actions follow LAN Smith: one per product (one per discovered variant for `discover`),
using the first enabled rule whose `branches` match the project's branch. A build
checks out the **branch tip**, posts what it found to `/resolve`, and runs the command
smith.json defines at that commit; the build records the commit. Deploy rules are
imported like any other (senet's `deploy-prod` is a real button).

**No smith.json needed for the obvious cases.** Without one, Smith detects a default from
the file list (`src/detect.ts`) and builds with it, using the same reader, card and
`/resolve` path. The first match wins:

| At the repository root | Action | What it runs |
|---|---|---|
| `build.bat` / `build.cmd` / `build.ps1` (Windows), `build.sh` (Linux, macOS) | `build` | that script |
| `package.json` | `build` | `npm ci` (with a lockfile, else `npm install`), then `npm run build --if-present`, `CI=true`, on a machine labelled `npm` |
| `index.html` | `site` | `tar` packs the site (no `.git`) into `site.tar.gz`, which the build keeps |

The card says what was detected and shows the default smith.json, ready to commit when
the project needs more. A smith.json in the repository always replaces the default.
Detection never infers a deploy or publish step. When nothing matches, the card says
what Smith looks for. Chats and crew runs are told when a project has no smith.json, is
building from a detected default, or has a smith.json Smith cannot read. The **Pipeline
setup** crew template writes or fixes smith.json and its scripts.

**Repo access routing.** When an agent's clone or fetch is refused (`Permission denied
(publickey)`, `Repository not found`, `could not read Username`…), it completes with
`failure: "repo_access"`; the coordinator marks that machine as unable to read the
project for an hour and returns the job to the queue, so another machine can take it.
**Rescan** clears the marks.

**Rollout order:** deploy the Worker first, then update agents (`SmithAgent.bat update`
or `PackageAgent.bat --install C:\SmithAgent`). Older coordinators reject the new
result fields, and older agents never receive scans or branch-tip builds because they
lack the `smith-repo-projects` label.

**Not supported here yet:** handoff steps (Steam, itch…), `inputs` (those actions show
as unavailable), artifact globs and zip packaging (exact files with `package: none` are
collected), `smith.json` `poll` and `schedule` triggers (`webhook` triggers run through
[Build on push](#build-on-push); everything else is a button).

## Build on push

A project added from a Git URL can build itself when its branch is pushed. A prepared (pinned) project cannot until it follows its branch: its card's **Follow its branch** (or **Edit**) does that in place. A project that builds from Smith's copy builds on push too (below). The card's
**Build on push** button (owners and admins) makes a secret and registers a push webhook on
the GitHub repository through the GitHub link of whoever pressed it (then any other member's
link, then the Settings token; the OAuth `repo` scope covers webhooks). Nothing is pasted
anywhere. Only when no link can register it (nobody linked GitHub, or the link has no admin
on the repository, or the repository is not on GitHub) does the card show the payload URL
and the secret, once, to add by hand: **Settings → Webhooks**, content type
`application/json`, just the push event. **Turn off** removes the hook from GitHub and
forgets the secret. The API is `POST /projects/:projectId/push` with `{ "enabled": true|false }`.

So a burst of pushes builds only the newest commit, tick **New build replaces a waiting build
of the same action** on the card (owners and admins; `POST /projects/:projectId/replace-queued`
with `{ "enabled": true|false }`, or `null` to follow the workspace's **New build replaces a
queued build** setting again). A new build of an action, from a push or the dashboard, then
cancels that project's build of the same action on the same branch still waiting for a machine;
running builds are never cancelled, and a chat's or crew's Verify build neither replaces nor is
replaced. `replaceQueued` in `GET /projects` is what applies, `replaceQueuedChosen` whether the
card's choice is in force.

What a push builds is ticked on the card, under **Choose what a push builds** (owners and
admins; `POST /projects/:projectId/push-actions` with `{ "actions": [ids] }`, or `null` to
go back). Until someone ticks, smith.json decides: its `webhook` triggers whose `branches`
match the project's branch (or name none), each naming a product, or no product for the
first one. `onPush` in `GET /projects` carries the action IDs a push builds, `onPushDefault`
smith.json's, and `pushChosen` whether the card's choice is in force. A ticked action that
smith.json drops, or that cannot run here, is left out; smith.json triggers that do not
build on the branch are warnings on the card.

Deliveries arrive at `POST /api/v2/hooks/github/<workspace id>/<project id>` with no
session, origin or CSRF token: the `X-Hub-Signature-256` HMAC over the raw body, checked
against the project's secret inside the workspace object, is the whole credential, and
nothing is read from a body that fails it. A `ping` is answered; a push to another branch,
a tag, or a branch deletion is recorded and ignored; a push to the project's branch
re-reads `smith.json` at the pushed commit through GitHub (when a link can) so the
triggers and actions follow the push, then queues a **branch-tip** build of every action
the triggers name, with the workspace's secrets as a dashboard build would have (never a
pinned, secretless build). With *new build replaces a queued build of the same product* on
in Settings, a burst of pushes builds once, on the newest commit; a redelivery (GitHub's
*Redeliver*) is answered with the builds it already queued. The card's last line shows the
latest delivery: branch, commit, outcome and the queued builds.

**Projects that build from Smith's copy.** A push to the repository the copy is linked to
(the webhook sits there) is pulled into the copy first: the card says "pulling …, then
building" while the Pull runs, and a push that lands during another Pull or Push waits for
it and pulls again. Once the commit is in the copy, smith.json is read at it — through
GitHub when GitHub's head is the copy's, otherwise by a machine — and the webhook triggers'
builds are queued. A copy with nothing linked needs no webhook at all (`via: "smith"`): a
push straight into the copy (`git push` to this site, or a merge in Smith) on the project's
branch is the trigger, read and built the same way. The same GitHub fast path means
**Follow its branch**, Rescan and a Pull usually finish without waiting for a machine.

**One at a time.** A rule with `"serial": true` in `smith.json` runs one build of its
product at a time across the workspace: a queued build of it is handed to a machine only
while no other build of that product is leased or running, whatever the number of
machines that could take it. Builds of other products are not held back. That is what a
deploy needs (two deploys of different commits must not overlap, or the older could finish
last), and it is honoured here and ignored by LAN Smith's parser. The card's action notes
say "One at a time".

**Smith deploying itself.** On `feature/cloudflare-experiment` the repository's
`smith.json` has a `webhook` trigger for the `deploy-experiment` product: `RunTests.ps1`
then `DeployWorker.bat --unattended` on a Windows machine labelled `una-engine` and
`smith-deploy`, serial, so any number of machines may carry the label. Unattended, the deploy script never logs in, prompts or pauses: it needs
`CLOUDFLARE_API_TOKEN` (the Cloudflare API token in workspace Settings reaches every
build; it needs Workers Scripts, D1 and R2 edit) or a Wrangler login already on that
machine, and fails with that message otherwise. The rest is the normal deploy: the
Windows agent package, `npm ci`, `npm run verify`, migrations, `wrangler deploy`, then the
package and its manifest to R2, after which every connected Windows agent (the one that
ran the deploy included) updates itself between builds. Label the machines that may deploy
`smith-deploy` (a queued deploy's page lists each machine that lacks it with an **Add
smith-deploy to <machine>** button for admins; labels added there show, and are removed, on the
machine's card — no agent restart or `--labels` needed), add the Smith project to the workspace from its Git URL on that branch,
press **Build on push**, and a push deploys. Nothing was deployed while this was
built (the development rule); the first push-driven deploy is the owner's.

## Working without GitHub

Nothing in Smith needs GitHub. A project can live entirely in Smith's copy, kept on the
build machines switched on to keep copies and served from this site:

- **Start one in Smith.** Add project → *A new repository in Smith (no GitHub needed)*,
  with a name and a branch (default `main`). A machine that keeps copies creates it empty
  (a host job whose source is Smith's own address; agents advertise `smith-git-new`, and an
  older agent is never handed one — the dialog says so while none can). Push your code to
  the clone address on its card; the first push is read for its `smith.json`.
- **Or bring one in from anywhere and cut the link.** Add it from any Git URL, copy it into
  Smith, then Detach it on its card: the copy is the only repository from then on.

Either way builds, AI chats and crew members clone from and push to the copy, Smith's own
pull requests review and merge in it, and Build on push needs no webhook: a push into the
copy (`git push` to this site, or a merge in Smith) is the trigger. GitHub stays optional:
link a copy to a repository to Pull and Push, and its pushes are pulled in and built.

## Editing projects

**Edit** (owners and admins, at the foot of each project card; `POST /projects/:projectId/edit`
with any of `name`, `branch`, `buildFrom: "copy" | "repository"`) changes a project in place:
its ID, crew members, build history and copy stay. Saving a prepared (pinned) project makes
it follow the newest commit on the branch, with its actions from that branch's `smith.json`.
*Builds, AI chats and crew work on* appears when the project has a copy in Smith, and is one
choice for all three: Smith's copy (recommended: chat and crew branches land in Smith, and a
push to the linked repository is pulled in, then built) or the repository it was copied
from (clones and pushes go straight to it, with each machine's own Git login). A changed branch or source is read again, GitHub first, and a scan of the old one
still queued is cancelled.

## Removing projects and machines

**Remove project** (owners and admins, at the foot of each project card; `POST /projects/:projectId/remove`)
stops Smith listing and building the project. Builds of it still queued are cancelled; one
already on a machine has to finish or be cancelled first, and a crew member whose main
project it is has to be given another (or deleted) first — the refusal says which. Its
Build on push hook is taken off GitHub, the machines throw away their copies of it (the
repository goes to `deleted`; each copy is a `discard` task) and its backups in R2 are
deleted. Other crew members stop reading it, and past builds stay listed. The Git
repository itself is never touched; an old Cloudflare Artifacts copy stays in that account.
A project a crew member created is removed the crew's way (owners only, keeping its
repository).

**Remove machine** (the machine's owner, or owners and admins; `POST /nodes/:nodeId/revoke`)
revokes its credential, so its agent is refused from then on, marks a build it was running
lost, hands its copies over to another machine where one has them, and takes it off the
list. A machine that is still alive has to be connected again to come back.

## Settings

The dashboard's **Settings** page (header button, or `#settings`) has two forms.

**Your account** is per user and stored in D1 (`users.display_name`, `email`,
`preferences`, migration `0005`): display name (shown in the header), e-mail
(reserved for notifications), time zone (IANA name or the browser's), 12/24-hour
clock, log timestamp style (off, time of day, date and time, ISO 8601 UTC, or
elapsed since first output), dashboard refresh cadence (2–60 s) and whether live
output auto-scrolls. Each output chunk carries the time the coordinator received it
(`logs.received_at`, DO schema version 2), which is what the stamps show.

**Workspace** is per workspace, stored in the Durable Object (`settings` and
`secrets` tables) and writable by owners and admins only: workspace name (also
shown in the picker), machine-offline threshold, "new build replaces a queued
build of the same product", and Cloudflare credentials. The API token is
write-only: `GET /settings` reports only `cloudflareApiTokenSet` and when it was
last changed, a blank token on save keeps the stored one, and
`clearCloudflareApiToken: true` removes it. The token never enters the frozen job
spec; it is merged into `spec.env` as `CLOUDFLARE_API_TOKEN` (plus
`CLOUDFLARE_ACCOUNT_ID`) when a machine **claims** a job, so a rotated token
reaches builds still queued and no stored job holds a secret. Project `env` wins
on a clash. Every build in the workspace can read the token, so scope it to what
the builds need (for example Pages:Edit or Workers Scripts:Edit) and keep the
development rule: no real deploy runs until Smith is trusted.

The **Crew** card under it holds the settings every crew run obeys (owners and admins):

| Setting | Meaning |
| --- | --- |
| Allow crew members to create projects | Off by default. The workspace-wide gate for `crew_create_project`; each member also needs its own flag, and the workspace needs its own Cloudflare account ID and API token above |
| Concurrent crew runs | 1 to 10 runs working at once across the workspace (default 1) |
| Daily crew spend limit (USD) | 0 to 1,000 whole dollars of API spend the crew may reserve in any 24 hours (default 10). It meters `api-key` runs only; `login` and `ollama` runs reserve nothing |
| Anthropic API key | Write-only like the Cloudflare token (`anthropicApiKeySet` in `GET /settings`; blank keeps it, `clearAnthropicApiKey: true` removes it). Only `api-key` crew runs on build machines receive it, never builds |
| Stop all crew | The kill switch: nothing starts, running crew turns are stopped and their run tokens end. Members keep their settings and start again once it is off |

Use a dedicated key with a spend cap set in the Anthropic console. The cap there is the real
limit, because every `api-key` member can use the key. Rotate it by saving a new one.

Local development: `wrangler dev --local` rewrites the request `Origin` header
to the configured custom domain (`http://exp.redmarmosetstudios.com`), so run it
with `--config` pointing at a copy of `wrangler.jsonc` whose `ORIGIN` var is that
exact value, apply D1 migrations with `--local`, and seed a user plus an
invitation hash into the local D1 before signing in.

## Cloudflare Artifacts (copy a project's repository)

A project can be copied from GitHub into [Cloudflare Artifacts](https://developers.cloudflare.com/artifacts/)
(git hosting, open beta on the Workers Paid plan) and then built from the copy.
The dashboard never names Artifacts: it offers the copy as **Keep a copy in Smith** in
**Add project** and as **Copy into Smith** on each project card (it starts at once, no confirmation); the API is `POST /api/v2/workspaces/<id>/projects/<project>/mirror`
with `{ "requestId": "<uuid>" }` (owner/admin only). Both project types qualify: a pinned
project is copied at its pinned commit, a Git-URL project at the commit Smith last read
(so its `smith.json` must have been read first; later rescans read the Artifacts copy on a
machine, using a read token Smith mints).

**Optional, capability-gated.** Smith works with GitHub alone; Artifacts is an extra.
Having credentials is not enough: before showing the copy options (`artifactsAvailable`
in workspace settings) and before any copy, the workspace object asks the Artifacts API
whether the account behind those credentials can use it (a lookup of a repository that
never exists: "not found" means yes, anything else means no). A yes is kept an hour, a
no five minutes, an unanswerable check retries after a minute, and saving new Cloudflare
credentials checks again at once. Without it the copy controls are hidden, copies are
refused (503 `artifacts_unconfigured`), and builds run straight from GitHub. Crew members do
not need a copy: without one they check the project out with the machine's own Git login,
as chats do.

Which Cloudflare account holds the copy:

- **The workspace's own account**, when its Settings hold a Cloudflare account ID
  and an API token with the **Artifacts Edit** permission (add it to the token build
  scripts already use, or store a token that has both).
- **Smith's backend account** otherwise: `SMITH_ARTIFACTS_ACCOUNT_ID` in
  `wrangler.jsonc` plus the Worker secret `SMITH_ARTIFACTS_TOKEN` (an API token
  with Artifacts Edit on that account), set once by the operator:

  ```sh
  npx wrangler secret put SMITH_ARTIFACTS_TOKEN
  ```

`GET /settings` reports `artifactsAvailable` and `artifactsSource`
(`workspace` | `smith` | `none`); the copy dialog says which account it will use.
A copy stays in the account it was made in (`artifacts.accountId`): adding or
removing a workspace token later changes where *new* copies go, not where an
existing project's builds read from. `ARTIFACTS_NAMESPACE` in `wrangler.jsonc`
names the Artifacts namespace (default `default`; create it in the Cloudflare
dashboard or via the REST API first).

How a copy runs. The Worker has no git, so:

1. The Worker looks the repository up (`<workspace id prefix>-<project id>` in the
   namespace) and creates it with the project branch as default branch if it is
   missing. If that branch already holds the project's pinned commit, nothing is
   pushed and the project is switched immediately.
2. Otherwise it mints a **write** token (2 h TTL) and queues a `mirror` job that any
   connected build machine can claim. The agent clones the source with the
   machine's own Git credentials (exactly as a build does), checks the Artifacts
   limits (1 GB per repository, 32 MB per blob), pushes the pinned commit as the
   branch plus tags, and confirms the remote branch head. The token reaches git
   only as an `Authorization` header through `GIT_CONFIG_*` environment variables;
   it is never in argv, `.git/config` or forwarded output (it is redacted like the
   node token).
3. On completion the Worker independently reads the branch head from the Artifacts
   API, revokes the write token, and only then switches the project's source to the
   Artifacts remote (`artifacts.status: done`). A failed or mismatching copy leaves
   the project building from GitHub (`status: failed` with the reason). A transient
   API error leaves it `verifying`; the workspace alarm retries.
4. Builds of a switched project carry a repository-scoped **read** token (7 day TTL,
   the longest a queued build may wait) in `repos[0].authToken`; the hosted agent
   accepts a token for `*.artifacts.cloudflare.net` remotes only. Workspace schema
   migration 6 adds `jobs.kind` (`build` | `mirror`).

A copy of a prepared project is one-shot: later commits on GitHub are not synced.
Re-pin the project (edit it) and copy again, or push to the Artifacts remote directly.
A project added from a Git URL stays **linked** to the repository it was copied from;
see below. Not supported:
Git LFS, submodules living in private repositories (the copy pushes the
superproject only), and Linux/macOS agents (hosted agents are Windows-only today).
Per `CLAUDE.md`, no real copy was run during development: the Workers tests use an
in-memory Artifacts fake and the native tests cover the agent policy and argv/env
construction. The first real copy is an operator action.

## Smith-hosted repositories

Smith can be the git host for a project: the copy lives on the workspace's own build
machines and people, builds, chats and crew runs reach it only through the coordinator,
at `https://exp.redmarmosetstudios.com/git/<project>.git`. Nothing on a machine is
reachable from the internet; agents keep polling outbound as they always have. The
design is `docs/superpowers/specs/2026-10-06-smith-hosted-git-design.md`; the milestone
plan is `docs/superpowers/plans/2026-10-06-smith-hosted-git.md`. Milestones 1 to 3 (host,
serve, build from the copy; replication and failover; backups to R2 and restore) are implemented.

**Which machines host.** Hosting is a per-machine, per-workspace switch: an owner or
admin ticks **Keep copies here** on a build machine's card
(`nodes.host_repos`, `POST /nodes/:id/host`). Personal machines cannot be switched on.
The machine's agent also has to be able to host: it advertises `smith-git-host` when
git is 2.36 or newer, `git --exec-path` exists, the store root could be made
owner-only and more than 2 GB are free, and its heartbeat carries
`hosting: { able, reason, free }` so the card can say why not ("git 2.34.1 is older
than 2.36", "only 1.2 GB free"). Agents from before hosting never advertise the label,
so no relay reaches them. Every agent on the new package advertises `smith-git-client`;
builds, scans, chats and crew runs of a hosted project require it.
`GET /settings` reports `hostingAvailable` (a switched-on, able machine is online) and
`cloneUsername`; `GET /nodes` reports `hostRepos`, `hostingReason`, `hostsOnline` and
the copies each machine keeps (`hosted: [{repoId, primary, state, bytes}]`).

**Copying a project in** (`POST /projects/:id/host`, "Copy into Smith" / "Keep a copy
in Smith"): the workspace object records the repository (`git_repos`, keyed by a fresh
UUID, state `bootstrapping`) and queues a `host` job (visible in Builds as "copy into
Smith") that only switched-on, able machines may claim. The agent clones the source
with the machine's own Git login into `<hosted-workspace>/git/<workspace prefix>/<uuid>.git`
as a bare mirror, drops the link to the source, applies Smith's config
(`receive/transfer/fetch.fsckObjects`, `receive.maxInputSize=100m`,
`receive.advertiseAtomic`, `uploadpack.allowFilter`, `core.logAllRefUpdates`,
`core.hooksPath` to an agent-owned hooks directory), snapshots that config beside the
store, sets `HEAD` to the recorded default branch (the source's HEAD, else the project
branch, else the first branch) and reports every ref (`[sha, ref]`, at most 10,000,
`refs/smith/*` excluded) and the store size. Whichever machine completes the job is the
repository's **primary**; the project's `repoUrl` switches to the Smith remote while
`hosted.sourceRepoUrl` keeps the GitHub address the card still shows. A failed, lost or
cancelled host job leaves the project where it was (`hosted.status: failed` with the
reason). Repositories over 1 GiB are refused.

**Serving.** Only the smart-HTTP paths exist under `/git/`: `GET info/refs` and the two
`POST` RPCs; everything else is 404, there is no dumb HTTP. Authentication is HTTP
Basic (or Bearer) with a Smith personal access token as the password: `read` clones and
fetches, the existing `build` scope pushes. The clone URL carries the first 12 characters
of the workspace id as the username, so credential helpers keep one credential per
workspace; a 12-hex username that is not this workspace's is refused (401). Node
credentials are rejected on `/git/*`, run tokens get 403, and tickets (`smith_git_…`,
minted for builds, chats and crew runs) are accepted only together with the
`X-Smith-Node` header of the machine they were bound to. Failures on `info/refs` are
pkt-line `ERR` texts git shows verbatim ("No machine holding this repository is online.
DESKTOP is offline; start it to restore service", "This Smith token cannot push. In the
dashboard, create a token that can start builds and use it as the password");
RPC failures are plain text with 401/403/404/413/429/503. Rate limits: `GIT_RATE`
(300 requests per minute per credential) and `GIT_FAIL_RATE` (30 refusals per minute
per client IP), both Workers rate-limiting bindings in `wrangler.jsonc`.

Each RPC is one rendezvous through the `GIT` R2 bucket (`smith-experiment-git`): the
Worker authorises, inflates a gzipped body (16 MiB cap for upload-pack, 100 MiB for
receive-pack; 413 beyond) into `relay/<workspace>/<relay>/req`, and asks the workspace
object for a relay addressed to the primary (writes) or to a current copy (reads). The
hosting machine's git thread polls `POST /git/poll` (every 3 s, every 500 ms for a minute
after activity), takes the oldest ready relay, downloads the body, runs
`git upload-pack --stateless-rpc` / `git receive-pack --stateless-rpc` /
`git <service> --http-backend-info-refs` on the bare store with stdin and stdout on
files, no system or user git config, `GIT_PROTOCOL` from the client, all `GIT_*` and
credential variables removed, uploads the output in 5 MiB parts and completes the relay
with the exit status and, after a push, the store's new refs. The Worker, which waited
on the workspace object (up to 25 s per hop; 180 s in all for reads, 600 s for writes),
streams the response object to the client. Leases are 120 s and every poll renews them;
a writer relay whose lease expires is terminal (504 "push outcome unknown; run git fetch
and push again"), but the coordinator still records the tips a late completion carries,
and the agent journals the refs after every push so a completion lost in transit is
reported through `POST /git/tips` on its next poll. Relay objects are deleted on
delivery; the bucket lifecycle rules catch the rest.

**A clone's first two requests need no machine.** With protocol v2 (every current git client),
the coordinator answers `GET info/refs` with a fixed capability advertisement and a plain
`ls-refs` RPC (HEAD as a symref to the default branch, refs filtered by the client's prefixes,
annotated tags with their peeled targets) from its own record, after the same authorisation a
relayed request gets and only while a copy able to serve the fetch is online. Agents report the
peeled targets with every tips report (`peeled: {ref: sha}`); a repository whose record has none
yet (copied by an older agent, before its first push) is still relayed for `ls-refs` when the
client asks for peeled values. The `fetch` RPC, pushes and protocol v0 advertisements are relayed
as before. A clone therefore costs one relay round trip instead of three.

**Ref policy is git-native.** The agent provisions one `update` hook (POSIX sh; Git for
Windows runs it with its bundled sh) and passes the relayed credential's policy in the
environment: `SMITH_ALLOWED_REFS` and `SMITH_PROTECTED_REFS` (space-separated globs) and
`SMITH_DENY_DELETE`. A person's token may push `refs/heads/*` and `refs/tags/*`; the
default branch is protected from force-pushes (`git merge-base --is-ancestor` over the
quarantine) and deletion; `refs/smith/*` is reserved. Crew runs push only
`refs/heads/smith/crew-<slug>-*` and may delete nothing. Signed pushes, pushes from
shallow clones and push options are refused before git runs.

**Linked repository.** A Smith-hosted copy keeps the same **Pull from GitHub / Push to GitHub /
Detach** buttons (and `POST /projects/:id/sync`, `POST /projects/:id/upstream`) as an Artifacts
copy: a pull is a `mirror` job whose target is the Smith remote with a write ticket bound to the
job (`refs/heads/<branch>` and tags only, never a delete), relayed to the primary like any push and
confirmed against Smith's own record before the pull counts; a push clones the copy on the machine
(its own store, or a ticket handed out at claim) and pushes to the linked repository with the
machine's Git login, never forced. Sync jobs of hosted copies need a machine with both
`smith-repo-sync` and `smith-git-client`.

**Builds on a hosting machine** clone from the local store (`git clone --no-hardlinks`)
when the coordinator names it at claim time (`repos[0].hostedUuid` plus the expected
`tip`), after checking the store's config snapshot and that the tip exists; otherwise they
clone through the coordinator with a read ticket bound to the machine and the job
attempt (TTL job timeout + 10 min, revoked at completion). Chats get read tickets, crew
push turns get write tickets with the crew branch policy. Tickets travel only as git
extra headers through `GIT_CONFIG_*` environment variables scoped to that one
repository's URL, with `credential.helper` switched off so a refused ticket can never
fall through to a person's stored login.

**Trust boundary.** A hosting machine's stores live under the OS user that also runs that
machine's builds, chats and crew runs, so hosting is only as trustworthy as the code the
machine builds. That is why hosting is a deliberate switch, stores sit outside the build
roots, the config snapshot is checked before every serve, and a copy whose config changed
is refused with a visible message. Do not switch hosting on for a machine that builds
untrusted projects. Relay bodies rest in R2 under its server-side encryption only.

**Copies on every switched-on machine.** Every machine switched on for hosting holds a copy of
every hosted repository, up to five copies per repository, placed by free disk (a machine needs
twice the repository plus 1 GB free). The coordinator's record of ref tips is the truth and
carries a generation counter; the primary alone takes pushes. After each push (and after the
first copy) the workspace object queues a `replicate` task for every other switched-on machine
(`git_tasks`, handed out on `git/poll` after relays, one task per machine at a time, leases
renewed by the polls, retried with capped backoff). The machine fetches
`+refs/heads/*:refs/heads/*` and `+refs/tags/*:refs/tags/*` with `--prune --atomic` from the
Smith remote through the coordinator, using a read ticket bound to it (the relay is never
addressed to the fetching machine itself), and reports its tips; a copy is **current** only when
its digest equals the record's, and reads are served by the primary or a current copy, never a
stale one. What a copy held that the record lacks is never pruned silently: a ref whose old tip
is not an ancestor of the new one and that no other ref still contains is kept under
`refs/smith/recovered/<time>/…` and listed on the project card, where an owner or admin can
**Push it** (the machine pushes it to the primary through the relay with a write ticket for that
ref alone; the hook's protection of the default branch still applies) or **Discard** it.
Switching a machine off marks its copies lost and, when another copy exists, queues a `discard`
task that moves the store to `git/trash/` on that machine, purged after seven days. The only copy
of a repository is never thrown away: the machine keeps it, and when it is switched on again its
agent reports the refs it holds (every copy the record calls lost or stale does, at most every ten
minutes) and the repository is hosting again without a restore. A machine that keeps nothing and owes
no task stops polling (`gitHost: false` on its heartbeat).

**Failover.** When the primary is gone (offline past `nodeOfflineSeconds`, switched off, revoked,
drained, or its agent lost the label), the newest current copy on an online machine becomes the
primary, at once when a push arrives and otherwise on the alarm; the old primary is marked stale
and syncs when it returns, keeping aside whatever it had beyond the record. With no current copy
online, pushes are refused with the offline machine's name and reads are served by whatever
current copy there is; a repository whose primary was switched off with no other copy is **lost**
until the machine returns or a restore runs.

**Backups to R2.** The primary bundles each hosted repository into the `GIT` bucket under
`backups/<workspace>/<repository uuid>/<backup id>.bundle`: a full `git bundle create --all`
weekly, and after pushes (once the repository has been quiet for five minutes) an incremental
bundle on the newest ready bundle's tips (`--all ^<tips>`; a base that was force-pushed away
falls back to a full). The machine verifies the bundle, uploads it in 5 MiB parts and completes;
the manifest (`git_backups`, with the tips it holds) becomes `ready` only once the object's size
matches. Retention keeps the two newest fulls and the incrementals chained on them, within an
8 GB budget (the older chain goes first; the newest full always stays); dropped bundles are
deleted from R2 after the transaction. Repositories over 1 GiB are not backed up or replicated.
The card shows "backed up N h ago" or "not backed up yet".

**Restore.** A lost repository (or one whose primary has been offline a day with no current
copy) is restored automatically onto an online machine that keeps copies and does not hold it;
**Restore from backup** on the card does it on request. The machine downloads the chain (the
newest full, then its incrementals) through the coordinator, verifies each bundle and applies it
with `fetch '+refs/*:refs/*'` into a fresh store, deletes refs the newest manifest lacks (bundles
cannot express deletions), sets `HEAD` to the recorded default branch, runs
`git fsck --connectivity-only`, and swaps the store into place, never over an existing copy. It
becomes the primary: **hosting** when its tips equal the record, otherwise **degraded**: reads
are served, pushes are refused ("restored from a backup and refuses pushes until an owner accepts
the restore") and the card says how many refs newer in the record may be lost. **Accept the
restore** (owner/admin) makes the restored tips the record; it is refused while an online copy
still holds the newer record, because promotion saves them instead. Honest limits: a lost
machine costs at most the pushes no other copy had fetched yet; off-machine bundles lag by up to
five minutes after the last push.

**Storage.** Workspace tables `git_repos`, `git_replicas`, `git_relays`, `git_tasks`,
`git_tickets`, `git_backups`, `git_recovered`, `git_audit` (schema version 11 also adds
`nodes.host_repos` and `nodes.hosting`); audit rows (who, repository, service, machine,
bytes, result; never a secret) are kept 30 days. Per `CLAUDE.md`, no real copy, clone or
push against the live coordinator ran during development: the Workers tests drive the
relay with a fake machine, and the native tests run real git against local bare stores.
### Linked repository: Pull, Push, Detach

Once a project added from a Git URL builds from Smith's copy, its card shows the
repository it is linked to (`artifacts.sourceRepoUrl`) with three buttons:

- **Pull from GitHub** (or the linked host) queues a `mirror` job (product
  `pull-from-linked-repo`) that clones the linked repository's branch tip with the
  machine's own Git login and pushes it into the copy with a fresh **write** token.
  On completion the Worker confirms the copy's branch head equals the commit the agent
  reported, revokes the token and rescans the project, so the build actions follow the
  new `smith.json`.
- **Push to GitHub** queues a `mirror` job (`push-to-linked-repo`) that clones the
  copy with a **read** token and pushes its branch tip and tags to the linked
  repository with the machine's own Git login. No GitHub token is involved; the push
  runs with `GIT_TERMINAL_PROMPT=0` and `GCM_INTERACTIVE=never`, so a machine that is
  not signed in fails with the reason instead of opening a window.
- **Detach** drops the link (`sourceRepoUrl` becomes the copy itself, the old URL is
  kept as `detachedFrom`). Smith keeps its copy and builds are unaffected; nothing on
  GitHub is touched. **Link a repository** / **Link again** links it (or a crew-made
  project) to a repository later.

Both pushes are ordinary, never forced: when the target branch has commits the source
lacks, git refuses, the agent reports "not a fast-forward" and the card names the one
next step (pull first, or push first). Branches that diverged on both sides need a
merge outside Smith today. Only one Pull or Push runs per project at a time, and
Detach waits for it. Both jobs require the agent label `smith-repo-sync`, which only
agents with this change advertise; with none connected the card says it is waiting for
a machine running the latest agent. The hosted agent accepts a non-Artifacts mirror
target only with no token and with Smith's copy as the source.

Per `CLAUDE.md`, no real Pull or Push was run during development: the Workers tests
use the in-memory Artifacts fake and the native tests cover the agent policy.

## Crew

The crew is a set of named, English-defined AI members that look after projects on a
schedule. Each run is an AI session of kind `crew` on a machine you chose, handled by the
same claim, lease, event and stop machinery as a chat turn. A member reports findings and
proposes changes on a branch; it never merges, builds or deploys. The dashboard's **Crew**
section has the tabs Members, Review and Messages. See [AI chat](ai-chat.md#crew) for what a
member is and what a run can and cannot do; this section covers running it.

**Machines and brains.** An owner turns on **Run crew members on this machine** on the
machine's card (off everywhere by default). That toggle is the consent that lets a member use
the machine's own Claude Code sign-in; a machine whose Claude Code reports itself signed out is
never chosen (`no signed-in machine`). Build machines also have **even while a build runs**.
A member's brain is `login` (the default), `api-key` or `ollama`; `api-key` members run only
on build machines, so enrolling a personal computer never hands anyone the workspace key.
Machines need an agent that reports the `crew` feature; update agents after deploying.
A machine connected in another of its owner's workspaces also appears here (linked-nodes.ts),
but takes this workspace's crew runs only once its owner turns the toggle on here too; the
toggle and the signed-in check are per workspace. Its busy check sees only this workspace's
work, so a run handed to it while it works for another workspace stays queued until it claims
it (or the turn is stopped after 15 minutes, as below). Agents update themselves only with no AI turn
running, so not during a crew turn; an agent that rolls back and stops reporting `crew` is
refused at the claim as above.

**Scheduling.** Triggers are manual, an interval (15 minutes or more) and build-finished
(failed builds, or every build). Windows missed while nothing could run collapse into one run.
A due run waits with a reason on its card: no machine online, machine busy (with a crew run, a
chat, or a build), concurrency, spend limit, project busy (one crew run per project at a time),
or no signed-in machine. It is looked at again at
least a minute later, and skipped if it still waits an hour after it was due. A queued crew
turn that no machine claims within 15 minutes is stopped. **Stop all crew** stops running and
queued crew turns. The machine is checked again when it claims a run: if its owner turned crew
work off, its agent lost the `crew` feature, a `login` run's Claude Code is signed out, an
`api-key` run's machine is no longer a build machine or the key is gone, the turn stops and
the run waits again with that reason. A member runs as the person who last saved it; while
they are out of the workspace or below operator its runs wait (`creator not in workspace`,
`creator demoted`) until an operator saves it, which makes it theirs. A metered run that
started Claude Code but reported no cost (a timeout or crash) counts its whole reservation
against the spend limit, and a run keeps the budget it was promoted with.

**Verify.** Verify is a human action from Review, never queued automatically. It builds the
member's Verify product at the proposal's commit, as a pinned build that carries none of the
workspace's secrets. The build still runs the branch's own script as the agent's OS user, so
read the files list first. Verify is refused when the proposal touches `smith.json` or a script
the product's commands run, or when the run changed more files than the agent could list (it
lists `smith.json` and build scripts first, but a cut list cannot rule them out). For a project added from a Git URL the Verify product is a
`smith.json` action; a project scanned before this feature guards only `smith.json` until you
rescan it. Each Verify counts against the member's builds per day and the workspace's 1,000
lifetime crew builds. Accept only marks a proposal and shows the branch to merge. A dismissal's
note is appended to the member's memory as feedback.

**Pushes.** After the CLI exits, Smith commits the change, scans it for the run's secrets and
for nested repositories, and pushes only `smith/crew-<slug>-<id>`, by explicit refspec and
never forced. To Smith's copy of the project it pushes with Smith's Artifacts token minted at
the push claim, and confirms the branch head through the Artifacts API: a proposal whose branch
Artifacts still does not show after 10 minutes fails, and so does one whose push cannot be
confirmed because Artifacts is unreachable for 2 hours. A project without Smith's copy is
pushed with the machine's own Git login, as a chat's Push branch is, and no Smith token goes
with it; Smith has nothing to confirm that head against, so the proposal is pending as soon as
the push reports ("Smith cannot confirm the head"), and Verify builds the commit the run
recorded. Crew Git commands use the member's own empty global Git config, so a credential
helper set only in the machine owner's `~/.gitconfig` (for example by `gh auth setup-git`) does
not apply; the Git installation's system config (Git Credential Manager on Windows) and SSH keys
do. A push no machine claims within 15 minutes fails the proposal.

**Retention.** Each member keeps its newest 30 runs; older sessions and their events are
deleted. Proposals stay in Review after their session is gone. A deleted member keeps its
reports and messages, labelled as a deleted member. The workspace keeps the newest 2,000
messages.

**Messages.** People and members write to everyone or to one member. A member's inbox is what
arrived since its previous run started, so a message that arrived during a run is delivered
again at the next one. Names show in the dashboard; the member's prompt says "a person (<role>)".

**Log events** for `wrangler tail`, each a JSON line:

| Event | Meaning |
| --- | --- |
| `crew_promote_failed` | Promoting waiting runs threw; the next alarm tries again. Carries the message |
| `crew_token_revoke_failed` | Revoking a run's Artifacts token failed; Smith retries until the token's own expiry |
| `crew_project_token_failed` | Minting the token for a crew-created project's push failed (`projectId`, `message`); the project is recorded as failed |
| `artifacts_token_revoke_failed` | A project copy's token could not be revoked |

Migration numbers for the crew are listed under [Verify and deploy](#verify-and-deploy).

## Remaining migration scope

The interactive build loop includes Google/GitHub account linking, `smith.json`
import through Add project, coding chats, crew, MCP tokens, account/workspace settings
and exact-file artifacts. Full LAN parity remains unfinished: pipeline editing,
`smith.json` triggers, membership administration, credential rotation, inputs, general
artifact packaging, deployment handoffs (the Cloudflare token is delivered, but
the native hosted agent still rejects handoff steps) and retention/compaction remain. Prepared projects currently use repository
scripts and local Git credentials. Do not add production deployment commands to
this test preset. Do not redirect production DNS or stop the independent LAN
coordinator at `C:\code\smith` as part of experiment testing.

Use `wrangler tail smith-experiment` for operational failures. Historical fixture
verification is retained in `deployment-evidence.json`; interactive verification
is recorded separately in `build-evidence.json`.
