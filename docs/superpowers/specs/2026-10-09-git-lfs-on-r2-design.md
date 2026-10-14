# Git LFS on Smith, stored in Cloudflare R2

**Status:** design approved 2026-10-09; implementation plan to follow.
**Scope:** the Cloudflare-hosted coordinator (`cloudflare/coordinator/`) and the hosted native agent
(`Modules/SmithAgent/Hosted*.cpp`). The LAN coordinator is unchanged.

## Context

Smith's hosted coordinator keeps a workspace's repositories on its own build machines and serves
them at `https://exp.redmarmosetstudios.com/git/<project>.git` (`2026-10-06-smith-hosted-git-design.md`).
That replaced Cloudflare Artifacts as "Smith's copy", and one thing Artifacts never offered was
Git LFS. Game projects carry large binaries (textures, audio, video, builds) that do not belong in
git objects, and nothing in Smith stores them today.

The request: Smith provides Git LFS, with Cloudflare R2 as the store.

### Decisions made with the owner (2026-10-09)

1. **Hosted Worker only.** The LAN C++ coordinator has no TLS and no crypto; the Worker already
   has an R2 bucket (`GIT`) and the git endpoint's authentication.
2. **Any project in the workspace** may use the endpoint, whether or not Smith keeps copies of
   it. A GitHub-hosted repository opts in with a one-line `.lfsconfig`.
3. **Hybrid transfer.** Objects move through the Worker by default (no setup, up to the Worker's
   request-body limit). When two R2 secrets are present the Worker presigns R2 URLs instead and the
   limit disappears.

### Facts that shaped the design (Cloudflare docs, 2026-10)

- A Worker's **inbound request body** is capped by the account plan: 100 MB on Free and Pro,
  200 MB on Business. Response bodies have no limit and a Worker may stream as long as the
  client stays connected.
- **R2** takes objects up to 5 GiB in one PUT and supports **presigned URLs** (SigV4, 1 s to 7
  days) for GET, HEAD, PUT and DELETE, on `https://<account>.r2.cloudflarestorage.com` only.
  Presigning needs an R2 API token (access key id + secret) and no call to R2.
- The R2 binding's `put()` takes a `ReadableStream` and an optional `sha256` to verify the body;
  multipart parts have no checksum option. The Workers runtime offers `crypto.DigestStream`.
- The **git-lfs batch API**: `POST <lfs url>/objects/batch` with
  `{operation, transfers?, ref?, objects:[{oid,size}], hash_algo?}`; the answer is
  `{transfer, objects:[{oid, size, authenticated?, actions:{download|upload|verify:{href, header?, expires_in?}}, error?:{code,message}}]}`
  with `Content-Type: application/vnd.git-lfs+json`. Request-level errors: 401 (credentials;
  `LFS-Authenticate: Basic realm="Git LFS"`), 403 (no write), 404 (no such repository), 422,
  413, 429, 507. Per-object errors keep the 200 and carry an HTTP-like code (404, 409, 410, 422).
- The **basic transfer**: upload is one `PUT href` with the action's headers and the raw bytes
  (`Content-Type: application/octet-stream`), download is `GET href`, and an optional `verify`
  action is `POST href` with `{oid, size}`; 200 means the server holds the object.
- git-lfs derives the endpoint by appending `/info/lfs` to the remote (`…/<repo>.git/info/lfs`);
  `lfs.url` in `.lfsconfig` points it elsewhere. It authenticates with HTTP Basic from git's
  credential helpers.

## Design

### 1. Endpoint and routing

The LFS API lives where git-lfs looks for it, under the git path:

| Route | Purpose |
|---|---|
| `POST /git/<project>[.git]/info/lfs/objects/batch` | the batch API |
| `PUT /git/<project>[.git]/info/lfs/objects/<oid>` | proxy-mode upload |
| `GET /git/<project>[.git]/info/lfs/objects/<oid>` | proxy-mode download |
| `POST /git/<project>[.git]/info/lfs/objects/<oid>/verify` | the verify action |
| anything else under `info/lfs/` (locks included) | 404 `{message}` so clients turn locking off |

A new module `src/lfs-route.ts` owns these. `GIT_PATH` in `git-route.ts` gains an `info/lfs/…`
alternative; `handleGit` hands those requests to `handleLfs` before doing anything else. `<project>`
is the workspace's project id (`REPO_ID` pattern), hosted or not; `<oid>` is 64 lowercase hex.
Every JSON answer is `application/vnd.git-lfs+json`; a request whose `Accept` lacks that type
gets 406.

Clients need no configuration for a Smith-hosted repository. A repository hosted elsewhere
commits `.lfsconfig`:

```ini
[lfs]
	url = https://exp.redmarmosetstudios.com/git/<project>.git/info/lfs
```

The Clone dialog (hosted projects) and a **Large files** row on every project card show that
line with a copy button.

### 2. Authentication, authorization, limits

Exactly the `/git/*` rules, shared with `git-route.ts` through exported helpers:

- `Authorization: Basic base64(<username>:<credential>)` or `Bearer`. The credential is a Smith
  token (`smith_pat_…`) or a git ticket (`smith_git_…`, with `X-Smith-Node`). Cookies, machine
  credentials (`smn.`) and crew run tokens are refused with the same texts as git.
- The 401 carries `WWW-Authenticate: Basic realm="Smith"` **and** `LFS-Authenticate: Basic realm="Smith"`.
- A 12-hex username is cross-checked against the workspace, as for git.
- **download** and **verify** need the `read` scope or a read ticket; **upload** (batch with
  `operation: upload`, the proxied PUT) needs the `build` scope (which carries push, by the
  owner's earlier decision) or a write ticket. A read-only token that asks to upload gets 403
  "This Smith token cannot upload large files. In the dashboard, create a token that can start
  builds and use it as the password".
- Rate limits: `GIT_RATE` per credential hash, `GIT_FAIL_RATE` per client IP on 401/403.
- A project that does not exist in the workspace is 404 "Repository not found"; the project's
  hosting state is irrelevant (LFS never needs a machine).

The Worker asks the workspace Durable Object once per request. New actions in `git-workspace.ts`:

| Action | Body | Answer |
|---|---|---|
| `lfs-batch` | `{repo, operation, objects:[{oid,size}], username, presign: boolean}` | per-object verdicts (below) |
| `lfs-authorize` | `{repo, oid, writer, username}` | the object's row, or a refusal |
| `lfs-stored` | `{repo, oid, size}` | marks the row `ready` (after a verified proxy PUT or a successful verify) |

Principals resolve as in `gitAction` (human: `requireHuman(userId, writer)`; ticket:
`resolveTicket(hash, repoId, scope, nodeHash)` without the repo-state checks that git applies).

### 3. Record and storage

New table in the workspace Durable Object (added to `HOSTED_GIT_SCHEMA`):

```sql
CREATE TABLE IF NOT EXISTS lfs_objects (
  repo_id TEXT NOT NULL, oid TEXT NOT NULL, size INTEGER NOT NULL,
  state TEXT NOT NULL,              -- pending | ready
  created_by TEXT NOT NULL,         -- 'member' | ticket label
  created_at INTEGER NOT NULL, ready_at INTEGER,
  PRIMARY KEY (repo_id, oid));
```

Objects live in the existing `GIT` bucket at `lfs/<workspaceId>/<project>/<oid>`. No lifecycle
rule applies to that prefix (objects are kept until the project is deleted).

**Batch verdicts** (`lfs-batch`), per object:

- `download`: row `ready` → a `download` action; otherwise per-object error 404 "Object not found".
- `upload`: row `ready` with the same size → no `actions` (the client skips it). Row `ready` with
  a different size → per-object 422 "Object exists with a different size". Otherwise, if the
  workspace's ready + pending bytes plus this object exceed the quota → the whole request is
  507 "Smith keeps N GB of large files for this workspace; this push needs M GB". In proxy
  mode an object larger than the proxy cap → per-object 413 "Objects over 100 MB need direct
  uploads to R2; see Settings → Large files". Otherwise the row becomes `pending` (inserted or
  refreshed) and the answer carries `upload` and `verify` actions.
- `hash_algo` other than `sha256` → request-level 422. `transfers` is ignored: the answer is
  always `transfer: "basic"`, which every client supports.
- A request with more than 1000 objects → 413.

**Quota**: a workspace setting `lfsQuotaBytes`, default 5 GiB, editable by owners in Settings.
Per-object proxy cap: `LFS_PROXY_MAX_BYTES` (Worker var, default 100 MiB, raised by an operator
on a Business plan). Objects larger than 5 GiB are refused in every mode (per-object 413).

**Pending rows** older than a day are swept by the existing alarm (`reconcileGit`) and deleted;
an abandoned upload's R2 object, if any, is deleted with the row.

### 4. Transfer modes

**Proxy mode** (default). `upload.href` and `download.href` are the Worker's own
`…/info/lfs/objects/<oid>`, with `header: {Authorization: <as received>}` and `authenticated: true`
so the client reuses the credential it already holds. The PUT streams the body through
`crypto.DigestStream('SHA-256')` on one branch of a `tee()` and into R2 on the other, using the
multipart writer already in `git-route.ts` (`storeBody`, moved to a shared module and given a
`sha256` option for the single-part case). A digest that differs from the oid deletes the object
and answers 422 "Uploaded data does not match the object id"; the row stays `pending`. Success
marks the row `ready` through `lfs-stored`. The GET streams `env.GIT.get(key).body` with
`Content-Type: application/octet-stream` and `Content-Length`.

**Presigned mode**. Active when the Worker has the secrets `R2_ACCESS_KEY_ID` and
`R2_SECRET_ACCESS_KEY` and the var `R2_ACCOUNT_ID` (the bucket name comes from the var
`GIT_BUCKET`, matching `wrangler.jsonc`). `src/r2-presign.ts` implements SigV4 query signing with
WebCrypto (HMAC-SHA256; no new dependency): `upload.href` is a presigned PUT, `download.href` a
presigned GET, both one hour, `authenticated: true`, no headers. Presigned uploads bypass the
Worker, so the **verify** action does the integrity check: it streams the stored object through
`DigestStream`, compares the digest to the oid and the length to the row's size, then marks the
row `ready` (200 `{}`); a mismatch deletes the object and answers 422; a missing object 404. In
proxy mode verify only confirms the row is `ready`.

**Setup for presigning** (shown in Settings → Large files when it is off):

```sh
npx wrangler secret put R2_ACCESS_KEY_ID        # from an R2 API token with Object Read & Write on smith-experiment-git
npx wrangler secret put R2_SECRET_ACCESS_KEY
```

Settings shows the active mode ("Large files move through Smith, up to 100 MB each" or
"Large files go straight to R2, up to 5 GB each"), objects and bytes used, and the quota.

### 5. Agents and builds

- The hosted agent advertises the label **`git-lfs`** when `git lfs version` succeeds
  (`Capabilities.cpp`, next to the other tool probes).
- A build job for a project with at least one `ready` LFS object requires the `git-lfs` label,
  so the scheduler never sends it to a machine that would check out bare pointers.
- Such a job carries an LFS **read ticket** for the project (`issueTicket(…, 'read', {nodeId,
  jobId, label: 'build'})`, repo-bound like the hosted-git ticket) in a new job-spec field
  `lfs: {url: "<origin>/git/<project>.git", authToken}`. The agent merges
  `HostedGitAuthEnv(lfs.url, lfs.authToken)` into the checkout's git environment, which sets
  `http.<origin>/git/<project>.git/.extraheader = Authorization: Bearer <ticket>` plus
  `X-Smith-Node`. For a Smith-hosted project that is the same URL the clone already uses, so
  nothing is added twice; for a GitHub-hosted project it sits beside the machine's own GitHub
  login. git-lfs reads git's `http.<url>.extraheader`, so the clone smudges pointers from Smith's
  LFS with no further setup. The plan's first agent test confirms this with a real git-lfs client;
  if a git-lfs version ignores the key, the same env map gains an inline `credential.helper` that
  prints the ticket, and nothing else changes.
- Deleting a project deletes its `lfs_objects` rows in the Durable Object and, in
  `ctx.waitUntil`, lists and deletes `lfs/<workspace>/<project>/` in R2.

### 6. Dashboard and documentation

- Project card: a **Large files** row ("12 objects · 340 MB") with the `.lfsconfig` snippet and
  a copy button; the Clone dialog adds "Large files (Git LFS) work out of the box: run `git lfs install` once".
- Settings: the **Large files** block from section 4, with the quota field for owners.
- `help.md`: a "Large files (Git LFS)" section; `docs/cloudflare/operations.md`: the two secrets,
  the vars, the quota, and the R2 prefix.

### 7. Testing

Workers-runtime vitest beside `git-host.test.ts`, in `test/lfs.test.ts` and `test/r2-presign.test.ts`:

- Batch shapes against the spec: download of a ready, pending and unknown object; upload of a
  new, known-same-size and known-different-size object; `hash_algo` refusal; 1000-object cap.
- Authentication: no credential → 401 with both challenge headers; cookie, machine credential
  and run token refusals; read token uploading → 403 with the exact text; wrong-workspace
  username → 401; unknown project → 404; rate-limit outcomes.
- Proxy upload: a correct body marks the row ready and the object exists in R2; a wrong body
  → 422, no object, row still pending; over the cap → 413; quota → 507 with the numbers.
- Proxy download: bytes, `Content-Type`, `Content-Length`; unknown object → 404.
- Verify: proxy mode confirms a ready row; presigned mode recomputes the digest (seeded by
  writing the object with the binding in the test) and marks ready, or deletes on mismatch.
- Presign: the SigV4 test vector from AWS's "Authenticating Requests: Using Query Parameters"
  example (`AKIAIOSFODNN7EXAMPLE`, 20130524T000000Z, `examplebucket/test.txt`, 86400 s →
  signature `aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404`), plus the
  mode switch when the secrets are present.
- Agent: `HostedGitAuthEnv` covers the LFS URL (pure test in `SmithFeaturesTest`); the `git-lfs`
  label appears only when the probe succeeds.
- Before any deploy: `git lfs push` and `git lfs pull` of a 1 MB and a 20 MB file by a real
  client against `wrangler dev --local` through both the hosted remote and a `.lfsconfig` remote.
  No real deploy by Claude (the safety rule in `CLAUDE.md`); the owner deploys and runs the first
  real push.

### 8. Copies on machines (redundancy, added 2026-10-09)

The owner asked for as much safety as possible: R2 must not be the only place an object exists.
Decisions: a **per-machine switch**, machines **show their free space**, and the coordinator
**keeps a reserve free** on them.

- **Switch**: each build machine's card gets **Keep large files here** (`host_lfs` on the node,
  action `node-lfs {nodeId, host}`), independent of "Keep copies of repositories here". The
  card shows the machine's free disk space (from the hosting report the heartbeat already
  carries: `hosting.free`) and how much it holds ("412 GB free · holds 340 MB of large files").
- **Reserve**: workspace setting `lfsMachineReserveBytes` (default 10 GiB, 1 GiB to 1 TiB,
  Settings → Large files: "Keep at least N GB free on machines"). A machine is handed an object
  only while `free − size ≥ reserve`; the card says "full: reserve reached" when it is not.
- **Store on the machine**: `<agent root>/lfs/<workspaceId>/<oid[0:2]>/<oid[2:4]>/<oid>`,
  content-addressed, shared by the workspace's projects, written via a temp file and rename,
  SHA-256 checked on arrival. Builds do not read it (git-lfs prune on a shared store is a risk;
  a fast path is future work).
- **Replicate**: `lfs_replicas(repo_id, oid, node_id, held_at)`. The hosting machine's existing
  `git/poll` reply carries up to 4 `lfs` tasks: `{kind: 'lfs-fetch', repo, oid, size, href}` where
  `href` is the proxied GET with a node-bound read ticket (presigned GET when enabled). The agent
  downloads, hashes, stores, and reports `lfs-held {repo, oid, size}`; a hash mismatch reports
  `lfs-failed` and the task is retried later. `reconcileGit` plans fetches so every switched-on,
  online machine with room holds every `ready` object, oldest-uploaded first. Objects whose
  rows are swept get `lfs-drop` tasks to every holder.
- **Lost objects**: `lfs_objects.state` gains `lost`. Set when (a) a proxied download finds R2
  without the object, or (b) **Settings → Large files → Check large files** (owners) runs an
  audit: the DO alarm `head()`s ready objects in batches of 200 per minute until done, marking
  misses `lost`. Downloads of a `lost` object answer per-object 404 "Object lost from storage;
  a machine holding a copy restores it" (or "...no machine holds a copy" when none does).
- **Restore**: a `lost` object with a holder gets an `lfs-restore {repo, oid, size, href}` task
  (presigned PUT when enabled, else the proxied PUT with a node-bound write ticket); the
  machine uploads from its store, the coordinator verifies as for any upload (hash in flight or
  the `verify` recompute), and the row returns to `ready`. Dashboard: project row shows "copies
  on DESKTOP-SEM, MAC-MINI (2 of 2 current)" and a `lost` count with the restore state.
- **Not done**: serving downloads from a machine while R2 is down (the relay mailbox is in R2;
  an outage pauses large-file traffic, nothing is lost).

## Out of scope (v1)

Garbage collection beyond project deletion, the locks API, SSH `git-lfs-authenticate`, LFS on
the LAN coordinator, Artifacts copies carrying LFS objects, builds reading a machine's store.
