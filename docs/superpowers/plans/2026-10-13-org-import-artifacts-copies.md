# Import a GitHub organisation, Artifacts as the home, budgeted copies on machines: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every repository of a GitHub organisation becomes a Smith project whose git lives on Cloudflare Artifacts behind Smith's own URL and whose large files live in Smith's R2 LFS, while build machines keep budgeted, spread-out copies instead of everything.

**Architecture:** The Worker's git endpoint proxies to Artifacts for projects whose `home` is `'artifacts'` and relays to a machine otherwise; Artifacts-home repositories reuse the hosted-git record (`git_repos` in a new `artifacts` state, replicas in `git_replicas`). A pure planner (`copies.ts`) places repository and LFS copies on machines by unused budget. An `import` job per repository (new job kind, agent-side `HostedImport.cpp`) mirror-clones from GitHub, rewrites large files into LFS, pushes objects to Smith's LFS and the mirror to Artifacts.

**Tech Stack:** Cloudflare Workers + Durable Object SQLite (TypeScript, vitest in the Workers runtime), vanilla ES-module dashboard, C++17 hosted agent (Una engine, `Tests/SmithHostedAgentTest`), git and git-lfs CLIs.

**Spec:** `docs/superpowers/specs/2026-10-12-org-import-artifacts-copies-design.md`

**Worktree:** `C:\code\.worktrees\smith-org-import`, branch `claude/org-import` (cut from the merged LFS pull request #12 at `a9cf881`). Commit with `--author="Claude Fable 5 <noreply@anthropic.com>"` and the `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` trailer. Push after every task; the PR targets `feature/cloudflare-experiment`.

## Global Constraints

- One git URL for every project with a home: `smithRemote(origin, id)` = `<origin>/git/<id>.git`. Artifacts remotes never reach browsers, machines (except the bulk push of an `import` or mirror job) or MCP clients.
- Artifacts limits: 32 MB per blob, 1 GB per repository (`MAX_REPO_BYTES` in `git-host.ts`); import thresholds are 1 MiB to 32 MiB, default 10 MiB.
- Copies: one per-machine switch `host_repos` (`host_lfs` mirrors it), budget `nodes.copy_budget_bytes` (NULL = workspace `copyBudgetBytes`, default 50 GiB, 1 GiB to 10 TiB), `copiesPerItem` default 2 (1 to 5), reserve `lfsMachineReserveBytes` unchanged. Per machine: one git task and `LFS_TASKS_PER_POLL` (4) LFS tasks leased at a time; `LFS_PLAN_LIMIT` (50) new LFS tasks per machine per pass.
- Schema version **22** adds `nodes.copy_budget_bytes`, `imports`, `import_repos`, `artifacts_tokens`; repo states gain `'artifacts'` and `'importing'`.
- Artifacts tokens: read tokens cached one hour, write tokens ten minutes, bulk push tokens `WRITE_TOKEN_TTL` (2 h); revoked when replaced, when the job ends, when the project is removed.
- Texts are exact where the spec quotes them (storage unreachable, push cap, token refusal, oversize, retry); tests pin them.
- Old agents never see `import` jobs: required labels `['smith-import', 'git-lfs']`; the agent advertises `smith-import` only when `git-lfs` is on PATH.
- No real deploy, no real organisation import, no push to a real Artifacts account by the implementer (CLAUDE.md safety rule). Tests use `ARTIFACTS_MODE=fake`, `GITHUB_MODE=fake`, local bare repositories and a stubbed `fetch`.
- Engine coding standards for C++ (PascalCase, `m_` members, 4 spaces, platform code in `*_Windows.cpp`/`*_Posix.cpp`); TypeScript follows the file it lives in (2 spaces, single quotes, one-line SQL).
- `npm run verify` in `cloudflare/coordinator` and `Build.ps1` + `RunTests.ps1` at the repository root must pass before any "done" claim. From this harness, run the native build and tests as child processes with `C:\Program Files (x86)\Microsoft Visual Studio\Installer` on PATH (see `Build.ps1`'s vcvars detection).

## Review Focus

1. **A push through the proxy that Artifacts accepts but whose tips fetch fails** (Artifacts answers the push, then times out on `info/refs`): the record must stay as it was and the next alarm pass must refresh it, never mark the repository lost or fire Build on push twice. Test: Task 4, "a failed tips fetch after a push leaves the record for the alarm".
2. **A machine whose budget is set below what it already holds**: shedding must move exactly one item per pass and never the last current copy, even when every other machine is full (then nothing moves and the card says so). Test: Task 6, "shedding stops at the last current copy".
3. **An import whose repository already uses LFS and whose `.gitattributes` tracks a pattern below the threshold** (say `*.png` at 2 MB each): those objects must be fetched from GitHub and pushed to Smith unchanged, with no rewrite and no detach. Test: Task 13, "existing LFS objects move without a rewrite".
4. **A repository that is oversize only before the rewrite** (1.2 GB with 400 MB of large blobs): the job must measure after the rewrite, go to Artifacts, and never queue a `host` job. Test: Task 13, "measured again after the rewrite".
5. **Re-running Import from GitHub for the same organisation after one row failed and one was removed by a person**: the dialog must offer the removed one again, skip the ones in Smith, and Retry must not create a second project for the failed row. Test: Task 8, "re-running lists only what is not in Smith" and "retry reuses the project".

---

## File structure

**Worker (`cloudflare/coordinator/src`)**

| File | Responsibility |
|---|---|
| `contracts.ts` (modify) | `JobKind` gains `'import'`; `ImportSpec`, `ImportReport`; `JobResult.failure` gains `'oversize'`, `JobResult.import`. |
| `settings.ts` (modify) | `copyBudgetBytes`, `copiesPerItem`, `lfsImportThresholdBytes` with validation and defaults. |
| `projects.ts`, `repo-projects.ts` (modify) | `home?: 'artifacts' \| 'machines'` on both project shapes (server-owned). |
| `upstream.ts` (modify) | `copyOf` reads `home`; `syncSpecs` uses tickets for both homes. |
| `home.ts` (new) | `homeOf`, `assignHomes` (the upgrade pass, pure), `fitsArtifacts`. |
| `artifacts-repos.ts` (modify) | `deleteRepo` on every client; `ARTIFACTS_FAKE_REMOTE` for the drill. |
| `artifacts-tokens.ts` (new) | `ArtifactsTokens`: the `artifacts_tokens` cache (get, store, expire, revoke list). |
| `git-host.ts` (modify) | states `artifacts`/`importing`; `startArtifactsHome`, `artifactsReady`, `adoptArtifactsTips`; `servers` for an Artifacts home; `publicRepo` texts. |
| `git-proxy.ts` (new) | `proxyGit` (streamed pass-through with a first-byte timeout), `parseAdvertisement`, `fetchTips`. |
| `git-route.ts` (modify) | the `backend` branch: proxy, failover to relay, storage-unreachable texts. |
| `git-workspace.ts` (modify) | `backend` in `git-read/write/advertise/ls-refs`; `git-artifacts-tips`; `moveToStorage`, `restoreToStorage`; `reconcileArtifactsHomes` (daily refresh, loss probe); `planCopies` wiring; remove `reconcileSmithCopies`, `queueDupe`, `keepArtifactsCurrent`, `artifactsCredential`. |
| `copies.ts` (new) | the pure planner `planCopies` and `nodeBudget`/`repoCost`. |
| `git-tasks.ts`, `lfs-tasks.ts` (modify) | `planReplicas` and `LfsTasks.plan` removed in favour of the planner; `LfsTasks.full` keeps its signature. |
| `github-reader.ts` (modify) | `listGitHubOrgs`, `listOrgRepos`, `largeBlobsOnBranch`; fakes. |
| `imports.ts` (new) | `IMPORT_SCHEMA`, `Imports` (rows, states, public view), `importSpecs`, `validateImportReport`. |
| `job-blob-route.ts` (new) | `POST /api/v2/workspaces/:ws/jobs/:id/blobs/:name?part=N` and `.../complete`, lease-authorised. |
| `workspace.ts` (modify) | schema 22; `NodeRow.copy_budget_bytes`; `node-host` with budget; `nodes` fields; dispatch for `import-*`, `move-to-storage`, `restore-to-storage`, `job-blob-*`, `backup-download`; `artifactsToken` and `artifactsPushed` RPC methods; `attachImportTicket` at claim; `reconcileImports`; `removeProject` deletes the Artifacts repository; `copyPushed` for both homes. |
| `index.ts` (modify) | routes for imports, move/restore to storage, backup download, job blobs; `nodes/:id/lfs` and `artifacts-credential` removed. |
| `crew.ts`, `sessions.ts` (modify) | `hasSmithCopy` and `pushNeedsBuilder` recognise both homes. |

**Dashboard (`cloudflare/coordinator/public`)**: `copies.js` (new, pure texts), `imports.js` (new, dialog and panel), `app.js`, `index.html`, `lfs.js` (machine text), `repo-projects.js` (`copyOf` reads `home`).

**Agent (`Modules/`)**: `SmithProtocol/WireTypes.h`, `WireJson.cpp` (`ImportSpec`); `SmithAgent/HostedPolicy.cpp` (validation); `SmithAgent/HostedImport.h/.cpp` (new: pure helpers and the step runner); `SmithAgent/HostedAgent.cpp` (label, dispatch, bundle upload, redaction); `SmithAgent/Module.manifest`.

**Tests**: `cloudflare/coordinator/test/{home,copies,git-proxy,imports,job-blobs,artifacts-tokens,github-org}.test.ts`, `copies-dashboard.test.js`, `imports-dashboard.test.js`; `Tests/SmithProtocolTest/Main.cpp`, `Tests/SmithHostedAgentTest/Main.cpp`.

**Docs and tools**: `docs/user-guide.md` (feeds `help.html`), `docs/cloudflare/operations.md`, `cloudflare/coordinator/tools/import-e2e.ps1`.

---

### Task 1: Contracts, settings and the project home field

**Files:**
- Modify: `cloudflare/coordinator/src/contracts.ts`
- Modify: `cloudflare/coordinator/src/settings.ts`
- Modify: `cloudflare/coordinator/src/projects.ts:25-33`, `cloudflare/coordinator/src/repo-projects.ts:22-34`
- Modify: `cloudflare/coordinator/src/upstream.ts:17-25`
- Create: `cloudflare/coordinator/src/home.ts`
- Test: `cloudflare/coordinator/test/home.test.ts`, `cloudflare/coordinator/test/settings.test.ts`

**Interfaces:**
- Produces: `ImportSpec { source: string; artifactsRemote: string; artifactsToken: string; smithRemote: string; thresholdBytes: number; maxRepoBytes: number; originalBlob: string }`, `ImportReport { commit; branch; scan: ScanReport; rewritten; movedFiles; movedBytes; lfsObjects; lfsBytes; originalBundle?: { size; sha256 } }`, `JobResult.failure?: 'repo_access' | 'oversize'`, `JobResult.import?: ImportReport`; `Home = 'artifacts' | 'machines'`; `homeOf(project): Home | undefined`; `fitsArtifacts(bytes)`; settings `copyBudgetBytes`, `copiesPerItem`, `lfsImportThresholdBytes` and the constants `DEFAULT_COPY_BUDGET_BYTES`, `DEFAULT_COPIES_PER_ITEM`, `DEFAULT_IMPORT_THRESHOLD_BYTES`, `MAX_IMPORT_THRESHOLD_BYTES`.

- [ ] **Step 1: Write the failing tests**

`test/home.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { homeOf, fitsArtifacts, assignHome } from '../src/home';
import { copyOf } from '../src/upstream';

const origin = 'https://exp.redmarmosetstudios.com';
const artifacts = { repo: 'ws-senet', namespace: 'default', remote: 'https://bab833826312fe2b0c81bd7608a6dbf7.artifacts.cloudflare.net/git/default/ws-senet.git', status: 'done' as const, accountId: 'bab833826312fe2b0c81bd7608a6dbf7', source: 'smith' as const, sourceRepoUrl: 'git@github.com:Red-Marmoset/senet.git', updatedAt: 1 };
const hosted = { repoId: 'senet', uuid: 'u', status: 'ready' as const, sourceRepoUrl: 'git@github.com:Red-Marmoset/senet.git', updatedAt: 1 };
const base = { id: 'senet', name: 'Senet', branch: 'master', commit: 'a'.repeat(40), products: [] };

describe('home', () => {
  it('reads the stored home and nothing else', () => {
    expect(homeOf({ ...base, repoUrl: `${origin}/git/senet.git`, home: 'artifacts', artifacts })).toBe('artifacts');
    expect(homeOf({ ...base, repoUrl: `${origin}/git/senet.git`, home: 'machines', hosted })).toBe('machines');
    expect(homeOf({ ...base, repoUrl: 'git@github.com:Red-Marmoset/senet.git' })).toBeUndefined();
  });
  it('copyOf answers Smith’s URL for an Artifacts home and keeps the link and sync', () => {
    const copy = copyOf({ ...base, repoUrl: `${origin}/git/senet.git`, home: 'artifacts', artifacts: { ...artifacts, detachedFrom: 'x' } }, origin);
    expect(copy).toEqual({ kind: 'artifacts', remote: `${origin}/git/senet.git`, sourceRepoUrl: artifacts.sourceRepoUrl, detachedFrom: 'x', sync: undefined });
    expect(copyOf({ ...base, repoUrl: `${origin}/git/senet.git`, home: 'machines', hosted }, origin)?.kind).toBe('hosted');
    // The old shape (an Artifacts remote as repoUrl, no home) is still a copy until the upgrade pass runs.
    expect(copyOf({ ...base, repoUrl: artifacts.remote, artifacts }, origin)?.kind).toBe('artifacts');
  });
  it('assigns a home to the three legacy shapes without moving bytes', () => {
    expect(assignHome({ ...base, repoUrl: artifacts.remote, artifacts }, origin)).toEqual({ home: 'artifacts', repoUrl: `${origin}/git/senet.git` });
    expect(assignHome({ ...base, repoUrl: `${origin}/git/senet.git`, hosted }, origin)).toEqual({ home: 'machines', repoUrl: `${origin}/git/senet.git` });
    expect(assignHome({ ...base, repoUrl: `${origin}/git/senet.git`, hosted, artifacts }, origin)).toEqual({ home: 'machines', repoUrl: `${origin}/git/senet.git` });
    expect(assignHome({ ...base, repoUrl: 'git@github.com:Red-Marmoset/senet.git' }, origin)).toBeNull();
    expect(assignHome({ ...base, repoUrl: `${origin}/git/senet.git`, home: 'artifacts', artifacts }, origin)).toBeNull();   // already assigned
  });
  it('knows what Artifacts can hold', () => {
    expect(fitsArtifacts(1024 * 1024 * 1024)).toBe(true);
    expect(fitsArtifacts(1024 * 1024 * 1024 + 1)).toBe(false);
  });
});
```

Add to `test/settings.test.ts` inside the existing `describe` of `validateWorkspaceSettings` (the file already imports `DEFAULT_WORKSPACE_SETTINGS` and `validateWorkspaceSettings`):

```ts
it('validates the copies settings and the import threshold', () => {
  const s = validateWorkspaceSettings({ copyBudgetBytes: 50 * 1073741824, copiesPerItem: 3, lfsImportThresholdBytes: 10 * 1048576 }, DEFAULT_WORKSPACE_SETTINGS).settings;
  expect([s.copyBudgetBytes, s.copiesPerItem, s.lfsImportThresholdBytes]).toEqual([50 * 1073741824, 3, 10 * 1048576]);
  expect(DEFAULT_WORKSPACE_SETTINGS).toMatchObject({ copyBudgetBytes: 50 * 1073741824, copiesPerItem: 2, lfsImportThresholdBytes: 10 * 1048576 });
  expect(() => validateWorkspaceSettings({ copiesPerItem: 6 }, DEFAULT_WORKSPACE_SETTINGS)).toThrow(/copiesPerItem must be 1–5/);
  expect(() => validateWorkspaceSettings({ copyBudgetBytes: 1 }, DEFAULT_WORKSPACE_SETTINGS)).toThrow(/copyBudgetBytes must be/);
  expect(() => validateWorkspaceSettings({ lfsImportThresholdBytes: 33 * 1048576 }, DEFAULT_WORKSPACE_SETTINGS)).toThrow(/lfsImportThresholdBytes must be/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd cloudflare/coordinator && npx vitest run test/home.test.ts test/settings.test.ts`
Expected: FAIL (`../src/home` cannot be resolved; the settings test throws on an unknown field).

- [ ] **Step 3: Add the contracts**

In `src/contracts.ts`:

```ts
export type JobKind = 'build' | 'mirror' | 'scan' | 'checkin' | 'host' | 'diff' | 'merge' | 'publish' | 'import';
// An import job (src/imports.ts): mirror-clone `source` with the machine's own login, move blobs over `thresholdBytes`
// to LFS (bundling the original history to the job blob `originalBlob` first), push the objects to `smithRemote`'s LFS
// (the ticket rides in `lfs`) and the mirror to `artifactsRemote` with `artifactsToken`. Over `maxRepoBytes` after the
// rewrite: the job reports failure 'oversize' and the coordinator hosts the repository on a machine instead.
export interface ImportSpec { source: string; artifactsRemote: string; artifactsToken: string; smithRemote: string; thresholdBytes: number; maxRepoBytes: number; originalBlob: string }
// What an import job reports: the scan of the rewritten (or untouched) default branch, what moved, what it pushed.
export interface ImportReport { commit: string; branch: string; scan: ScanReport; rewritten: boolean; movedFiles: number; movedBytes: number; lfsObjects: number; lfsBytes: number; originalBundle?: { size: number; sha256: string } }
```

Add `import?: ImportSpec;` after `pull?: PullSpec;` in `ResolvedJobSpec`. In `JobResult`, change `failure?: 'repo_access'` to `failure?: 'repo_access' | 'oversize'` and add `import?: ImportReport;` after `host?`.

- [ ] **Step 4: Add the settings**

In `src/settings.ts`, after the `aiOrder` line in `WorkspaceSettings`:

```ts
  copyBudgetBytes: number;                           // copies (repositories and large files) a machine may keep unless its card says otherwise (1 GiB–10 TiB)
  copiesPerItem: number;                             // machines that should hold each repository and each large file (1–5)
  lfsImportThresholdBytes: number;                   // Import from GitHub moves files over this to large files (1–32 MiB)
```

Constants above `DEFAULT_WORKSPACE_SETTINGS`:

```ts
export const DEFAULT_COPY_BUDGET_BYTES = 50 * 1024 * 1024 * 1024;
export const DEFAULT_COPIES_PER_ITEM = 2;
export const DEFAULT_IMPORT_THRESHOLD_BYTES = 10 * 1024 * 1024;
export const MAX_IMPORT_THRESHOLD_BYTES = 32 * 1024 * 1024;   // Artifacts refuses larger blobs
```

Add to the default object: `copyBudgetBytes: DEFAULT_COPY_BUDGET_BYTES, copiesPerItem: DEFAULT_COPIES_PER_ITEM, lfsImportThresholdBytes: DEFAULT_IMPORT_THRESHOLD_BYTES`. In `validateWorkspaceSettings`, after the `lfsMachineReserveBytes` line:

```ts
  if ('copyBudgetBytes' in body) settings.copyBudgetBytes = integer(body, 'copyBudgetBytes', 1073741824, 10995116277760);
  if ('copiesPerItem' in body) settings.copiesPerItem = integer(body, 'copiesPerItem', 1, 5);
  if ('lfsImportThresholdBytes' in body) settings.lfsImportThresholdBytes = integer(body, 'lfsImportThresholdBytes', 1048576, MAX_IMPORT_THRESHOLD_BYTES);
```

- [ ] **Step 5: The home field and `home.ts`**

In `src/projects.ts` add to `Project` after `hosted?`: `home?: 'artifacts' | 'machines';   // server-owned: where the project's git lives (home.ts); never accepted from a caller`. In `src/repo-projects.ts` add the same line to `RepoProject` after `hosted?`. `validateProject` already lists its accepted fields explicitly, so `home` is refused from callers with no change. In `workspace.ts`'s `put-project` branch (the block that copies `previous.artifacts` and `previous.hosted` onto an edited project, around line 700), add `if (previous?.home) project.home = previous.home;`.

Create `src/home.ts`:

```ts
// Where a project's git lives (spec §1): on Cloudflare Artifacts behind Smith's URL, or on the workspace's own machines.
// Artifacts whenever the workspace can use it and the repository fits; machines only otherwise, or by an owner's choice.
import { MAX_REPO_BYTES, smithRemote, smithRemoteRepo } from './git-host';
import { isArtifactsRemote } from './artifacts-repos';
import type { Project } from './projects';
import type { RepoProject } from './repo-projects';

export type Home = 'artifacts' | 'machines';
export function homeOf(project: Project | RepoProject | undefined): Home | undefined { return project?.home; }
export function fitsArtifacts(bytes: number): boolean { return bytes <= MAX_REPO_BYTES; }
// The upgrade pass (one alarm after deploy): the home a legacy project gets, with the repoUrl it should have, or null when
// nothing changes. Both copies present keeps the machines (Move to storage is offered on the card); only an Artifacts
// copy becomes an Artifacts home behind Smith's URL; only a machine copy becomes a machines home.
export function assignHome(project: Project | RepoProject, origin: string): { home: Home; repoUrl: string } | null {
  if (project.home) return null;
  const onMachines = project.hosted?.status === 'ready' && smithRemoteRepo(project.repoUrl, origin) === project.id;
  if (onMachines) return { home: 'machines', repoUrl: project.repoUrl };
  const copy = project.artifacts;
  if (copy?.status === 'done' && (project.repoUrl === copy.remote || isArtifactsRemote(project.repoUrl))) return { home: 'artifacts', repoUrl: smithRemote(origin, project.id) };
  return null;
}
```

- [ ] **Step 6: `copyOf` reads the home**

Replace `copyOf` in `src/upstream.ts`:

```ts
export function copyOf(project: Project | RepoProject | undefined, origin: string): CopyInfo | undefined {
  if (!project) return undefined;
  const hosted = project.hosted, copy = project.artifacts;
  if (project.home === 'artifacts' && copy?.status === 'done') return { kind: 'artifacts', remote: smithRemote(origin, project.id), sourceRepoUrl: copy.sourceRepoUrl, detachedFrom: copy.detachedFrom, sync: copy.sync };
  if (hosted?.status === 'ready' && smithRemoteRepo(project.repoUrl, origin) === project.id) return { kind: 'hosted', remote: smithRemote(origin, project.id), sourceRepoUrl: hosted.sourceRepoUrl, detachedFrom: hosted.detachedFrom, sync: hosted.sync };
  // Before the upgrade pass (home.ts assignHome): an Artifacts copy still addressed directly.
  if (copy?.status === 'done' && project.repoUrl === copy.remote) return { kind: 'artifacts', remote: copy.remote, sourceRepoUrl: copy.sourceRepoUrl, detachedFrom: copy.detachedFrom, sync: copy.sync };
  return undefined;
}
```

`upstreamOf` already treats `sourceRepoUrl === remote` as "no upstream" and excludes Artifacts and Smith remotes; it needs no change.

- [ ] **Step 7: Run the tests and typecheck**

Run: `cd cloudflare/coordinator && npx vitest run test/home.test.ts test/settings.test.ts && npm run typecheck`
Expected: PASS; typecheck clean (nothing reads the new fields yet).

- [ ] **Step 8: Commit**

```bash
git add cloudflare/coordinator/src/contracts.ts cloudflare/coordinator/src/settings.ts cloudflare/coordinator/src/projects.ts cloudflare/coordinator/src/repo-projects.ts cloudflare/coordinator/src/upstream.ts cloudflare/coordinator/src/home.ts cloudflare/coordinator/src/workspace.ts cloudflare/coordinator/test/home.test.ts cloudflare/coordinator/test/settings.test.ts
git commit --author="Claude Fable 5 <noreply@anthropic.com>" -m "feat(home): a project's home, the import contracts and the copies settings

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Artifacts client additions and the token cache

**Files:**
- Modify: `cloudflare/coordinator/src/artifacts-repos.ts`
- Create: `cloudflare/coordinator/src/artifacts-tokens.ts`
- Test: `cloudflare/coordinator/test/artifacts-tokens.test.ts`, `cloudflare/coordinator/test/artifacts-repos.test.ts`

**Interfaces:**
- Consumes: `ArtifactsClient` (`artifacts-repos.ts`).
- Produces: `ArtifactsClient.deleteRepo(name): Promise<void>` (REST `DELETE …/repos/:name`, binding `delete(name)`, fake removes the map entry; a missing repository is not an error); `fakeArtifacts.remoteBase` honouring `ARTIFACTS_FAKE_REMOTE`; `ARTIFACTS_TOKEN_SCHEMA`; `class ArtifactsTokens { constructor(sql); get(projectId, scope, now): { tokenId; plaintext; expiresAt } | undefined; store(projectId, scope, tokenId, plaintext, expiresAt): void; drop(projectId, scope): { tokenId } | undefined; forProject(projectId): { scope; tokenId }[]; expired(now): { projectId; scope; tokenId }[] }`; `READ_CACHE_MS = 3600000`, `WRITE_CACHE_MS = 600000`.

- [ ] **Step 1: Write the failing tests**

`test/artifacts-tokens.test.ts`:

```ts
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { setup } from './lfs-fixture';
import { ArtifactsTokens, ARTIFACTS_TOKEN_SCHEMA, READ_CACHE_MS, WRITE_CACHE_MS } from '../src/artifacts-tokens';
import schema from '../migrations/0001_identity.sql?raw';
import browserSchema from '../migrations/0002_browser_auth.sql?raw';
import directorySchema from '../migrations/0003_workspace_directory.sql?raw';

beforeAll(async () => { await env.DB.exec(schema); await env.DB.exec(browserSchema); await env.DB.exec(directorySchema); });

describe('the Artifacts token cache', () => {
  it('stores, reuses until expiry, replaces and lists per project', async () => {
    const f = await setup();
    await runInDurableObject(f.stub, (instance: { ctx: DurableObjectState }) => {
      const sql = instance.ctx.storage.sql; sql.exec(ARTIFACTS_TOKEN_SCHEMA);
      const tokens = new ArtifactsTokens(sql); const now = 1_000_000;
      expect(tokens.get('senet', 'read', now)).toBeUndefined();
      tokens.store('senet', 'read', 'tok_1', 'art_v1_a', now + READ_CACHE_MS);
      expect(tokens.get('senet', 'read', now + READ_CACHE_MS - 1)).toMatchObject({ tokenId: 'tok_1', plaintext: 'art_v1_a' });
      expect(tokens.get('senet', 'read', now + READ_CACHE_MS)).toBeUndefined();   // a token about to lapse is not handed out
      tokens.store('senet', 'write', 'tok_2', 'art_v1_b', now + WRITE_CACHE_MS);
      expect(tokens.forProject('senet').map(t => t.scope).sort()).toEqual(['read', 'write']);
      expect(tokens.drop('senet', 'read')).toEqual({ tokenId: 'tok_1' });
      expect(tokens.get('senet', 'read', now)).toBeUndefined();
      expect(tokens.expired(now + WRITE_CACHE_MS + 1)).toEqual([{ projectId: 'senet', scope: 'write', tokenId: 'tok_2' }]);
    });
  });
});
```

Add to `test/artifacts-repos.test.ts` (it already exercises `fakeArtifacts` and `createArtifacts`):

```ts
it('deletes a repository, tolerating one that is already gone', async () => {
  fakeArtifacts.reset();
  const client = createArtifacts({ ARTIFACTS_MODE: 'fake' }, { accountId: fakeArtifacts.account, apiToken: 't', source: 'smith' });
  await client.createRepo('ws-senet', 'main', '');
  await client.deleteRepo('ws-senet');
  expect(await client.getRepo('ws-senet')).toBeNull();
  await expect(client.deleteRepo('ws-senet')).resolves.toBeUndefined();
});
it('lets the drill point the fake at a local git server', () => {
  fakeArtifacts.remoteBase = 'http://127.0.0.1:8418/git';
  expect(fakeArtifacts.remote('ws-senet')).toBe('http://127.0.0.1:8418/git/ws-senet.git');
  fakeArtifacts.remoteBase = '';
  expect(fakeArtifacts.remote('ws-senet')).toBe(`https://${fakeArtifacts.account}.artifacts.cloudflare.net/git/default/ws-senet.git`);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/artifacts-tokens.test.ts test/artifacts-repos.test.ts`
Expected: FAIL (`deleteRepo` and `remoteBase` do not exist; `../src/artifacts-tokens` missing).

- [ ] **Step 3: `deleteRepo` and the fake's remote base**

In `src/artifacts-repos.ts`: add `deleteRepo(name: string): Promise<void>;` to `ArtifactsClient`. `RestClient`:

```ts
  async deleteRepo(name: string): Promise<void> {
    const { status, envelope } = await this.call('DELETE', `/repos/${encodeURIComponent(name)}`);
    if (status === 404 || envelope?.errors?.some(e => e.code === 10200)) return;
    this.okOrFail(status, envelope, 'repository deletion');
  }
```

`BindingClient`:

```ts
  async deleteRepo(name: string): Promise<void> {
    try { await this.artifacts.delete(name); }
    catch (error) { if (!NOT_FOUND.test(errorText(error))) this.failed(error, 'repository deletion'); }
  }
```

Add `delete(name: string): Promise<boolean>;` to the `ArtifactsBinding` interface. `Unconfigured`: `deleteRepo(): Promise<void> { return this.off(); }`. `Fake`: `async deleteRepo(name: string): Promise<void> { this.gate(); fakeArtifacts.repos.delete(this.key(name)); }`. In `fakeArtifacts` add `remoteBase: '' as string` and change `remote()` to:

```ts
  remote(name: string, account = FAKE_ACCOUNT): string { return this.remoteBase ? `${this.remoteBase}/${name}.git` : `https://${account}.artifacts.cloudflare.net/git/${this.namespace}/${name}.git`; },
```

In `createArtifacts`, before `return new Fake(...)`: `if (e.ARTIFACTS_MODE === 'fake') { fakeArtifacts.remoteBase = (e as { ARTIFACTS_FAKE_REMOTE?: string }).ARTIFACTS_FAKE_REMOTE ?? fakeArtifacts.remoteBase; return new Fake(credentials.accountId); }`. Add `ARTIFACTS_FAKE_REMOTE?: string` to `src/env.d.ts`'s `Env` augmentation. `isArtifactsRemote` stays strict: in the drill the proxy decides by `home`, not by the URL's shape.

- [ ] **Step 4: The token cache**

Create `src/artifacts-tokens.ts`:

```ts
// Repo-scoped Artifacts tokens the Worker uses to proxy git (spec §2): minted through ArtifactsClient outside any
// transaction, cached here, and handed out until shortly before they lapse. Machines and browsers never see one.
export const ARTIFACTS_TOKEN_SCHEMA = 'CREATE TABLE IF NOT EXISTS artifacts_tokens (project_id TEXT NOT NULL, scope TEXT NOT NULL, token_id TEXT NOT NULL, plaintext TEXT NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY (project_id, scope))';
export const READ_CACHE_MS = 3600000;
export const WRITE_CACHE_MS = 600000;
export type TokenScope = 'read' | 'write';
type Row = { project_id: string; scope: TokenScope; token_id: string; plaintext: string; expires_at: number };

export class ArtifactsTokens {
  constructor(private readonly sql: SqlStorage) {}
  get(projectId: string, scope: TokenScope, now: number): { tokenId: string; plaintext: string; expiresAt: number } | undefined {
    const row = this.sql.exec<Row>('SELECT * FROM artifacts_tokens WHERE project_id = ? AND scope = ? AND expires_at > ?', projectId, scope, now).toArray()[0];
    return row ? { tokenId: row.token_id, plaintext: row.plaintext, expiresAt: row.expires_at } : undefined;
  }
  store(projectId: string, scope: TokenScope, tokenId: string, plaintext: string, expiresAt: number): void {
    this.sql.exec('INSERT INTO artifacts_tokens (project_id, scope, token_id, plaintext, expires_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(project_id, scope) DO UPDATE SET token_id = excluded.token_id, plaintext = excluded.plaintext, expires_at = excluded.expires_at', projectId, scope, tokenId, plaintext, expiresAt);
  }
  drop(projectId: string, scope: TokenScope): { tokenId: string } | undefined {
    const row = this.sql.exec<Row>('SELECT * FROM artifacts_tokens WHERE project_id = ? AND scope = ?', projectId, scope).toArray()[0];
    if (row) this.sql.exec('DELETE FROM artifacts_tokens WHERE project_id = ? AND scope = ?', projectId, scope);
    return row ? { tokenId: row.token_id } : undefined;
  }
  forProject(projectId: string): { scope: TokenScope; tokenId: string }[] {
    return this.sql.exec<Row>('SELECT * FROM artifacts_tokens WHERE project_id = ?', projectId).toArray().map(r => ({ scope: r.scope, tokenId: r.token_id }));
  }
  expired(now: number): { projectId: string; scope: TokenScope; tokenId: string }[] {
    return this.sql.exec<Row>('SELECT * FROM artifacts_tokens WHERE expires_at <= ?', now).toArray().map(r => ({ projectId: r.project_id, scope: r.scope, tokenId: r.token_id }));
  }
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/artifacts-tokens.test.ts test/artifacts-repos.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add cloudflare/coordinator/src/artifacts-repos.ts cloudflare/coordinator/src/artifacts-tokens.ts cloudflare/coordinator/src/env.d.ts cloudflare/coordinator/test/artifacts-tokens.test.ts cloudflare/coordinator/test/artifacts-repos.test.ts
git commit --author="Claude Fable 5 <noreply@anthropic.com>" -m "feat(artifacts): delete repositories, cache proxy tokens, point the fake at a local server

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: The record of an Artifacts home

**Files:**
- Modify: `cloudflare/coordinator/src/git-host.ts` (states, `startArtifactsHome`, `artifactsReady`, `adoptArtifactsTips`, `servers`, `publicRepo`)
- Create: `cloudflare/coordinator/src/git-proxy.ts` (`parseAdvertisement`, `fetchTips`; `proxyGit` comes in Task 4)
- Test: `cloudflare/coordinator/test/git-proxy.test.ts` (the pure parts), `cloudflare/coordinator/test/git-host.test.ts`

**Interfaces:**
- Consumes: `Tips`, `Peeled`, `tipsDigest`, `validateTips`, `RepoRow`, `ReplicaRow`, `HostedGit` from `git-host.ts`.
- Produces: `RepoState` gains `'artifacts' | 'importing'`; `HostedGit.startArtifactsHome(repoId, uuid, sourceUrl, defaultBranch, now): RepoRow` (state `importing`); `HostedGit.artifactsReady(repoId, tips, digest, peeled, defaultBranch, bytes, now): RepoRow` (state `artifacts`, generation + 1, copies stale); `HostedGit.adoptArtifactsTips(repo, tips, digest, peeled, now): { changed: boolean; before: string; after: string }`; `HostedGit.servers` answers `[]` for a writer on an Artifacts home and the current replicas for a reader; `parseAdvertisement(text): { tips: Tips; peeled: Peeled }`; `fetchTips(remote, token): Promise<{ tips; peeled; digest }>` (throws on anything but 200).

- [ ] **Step 1: Write the failing tests**

`test/git-proxy.test.ts` (pure parts; the proxy tests join in Task 4):

```ts
import { describe, expect, it } from 'vitest';
import { parseAdvertisement } from '../src/git-proxy';

const sha = (c: string) => c.repeat(40);
const pkt = (s: string) => (s.length + 4).toString(16).padStart(4, '0') + s;
describe('parseAdvertisement', () => {
  it('reads a v1 upload-pack advertisement into sorted tips and peeled tags', () => {
    const body = pkt('# service=git-upload-pack\n') + '0000' + pkt(`${sha('a')} HEAD\0multi_ack symref=HEAD:refs/heads/main agent=git/2.46\n`) +
      pkt(`${sha('a')} refs/heads/main\n`) + pkt(`${sha('b')} refs/heads/dev\n`) + pkt(`${sha('c')} refs/tags/v1\n`) + pkt(`${sha('d')} refs/tags/v1^{}\n`) + '0000';
    expect(parseAdvertisement(body)).toEqual({ tips: [[sha('b'), 'refs/heads/dev'], [sha('a'), 'refs/heads/main'], [sha('c'), 'refs/tags/v1']], peeled: { 'refs/tags/v1': sha('d') } });
  });
  it('answers no tips for an empty repository and refuses a malformed body', () => {
    expect(parseAdvertisement(pkt('# service=git-upload-pack\n') + '0000' + pkt(`${'0'.repeat(40)} capabilities^{}\0multi_ack\n`) + '0000')).toEqual({ tips: [], peeled: {} });
    expect(() => parseAdvertisement('not git')).toThrow(/advertisement/);
  });
});
```

Add to `test/git-host.test.ts` (inside its top-level `describe`, using the existing `setup`, `hosted`, `runInDurableObject` helpers):

```ts
it('records an Artifacts home: importing, then ready with tips, and never hands a writer a server', async () => {
  const f = await setup();
  await runInDurableObject(f.stub, async (instance: { ctx: DurableObjectState }) => {
    const { HostedGit } = await import('../src/git-host');
    const git = new HostedGit(instance.ctx.storage.sql, f.workspaceId, origin);
    const started = git.startArtifactsHome('senet', 'u-1', 'https://x.artifacts.cloudflare.net/git/default/ws-senet.git', '', 1000);
    expect([started.state, started.primary_node_id, started.generation]).toEqual(['importing', null, 0]);
    const digest = await tipsDigest(tips);
    const ready = git.artifactsReady('senet', tips, digest, {}, 'master', 123, 2000);
    expect([ready.state, ready.generation, ready.default_branch, ready.bytes, JSON.parse(ready.refs_json)]).toEqual(['artifacts', 1, 'master', 123, tips]);
    expect(git.servers(ready, [], 2000, 60000, true)).toEqual([]);
    const moved: [string, string][] = [[other, 'refs/heads/master'], [other, 'refs/tags/v1']];
    const adopted = git.adoptArtifactsTips(ready, moved, await tipsDigest(moved), {}, 3000);
    expect(adopted.changed).toBe(true);
    expect(git.repo('senet')!.generation).toBe(2);
    expect(git.adoptArtifactsTips(git.repo('senet')!, moved, await tipsDigest(moved), {}, 4000).changed).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/git-proxy.test.ts test/git-host.test.ts -t "Artifacts home|parseAdvertisement"`
Expected: FAIL (module and methods missing).

- [ ] **Step 3: States and record methods in `git-host.ts`**

Change `RepoState` to `'bootstrapping' | 'hosting' | 'degraded' | 'lost' | 'oversize' | 'failed' | 'deleted' | 'importing' | 'artifacts'`. Add to `HostedGit` after `failHost`:

```ts
  // An Artifacts home (spec §3): the row exists from the moment an import or a Move to storage starts (`importing`), and
  // becomes `artifacts` once the repository is there with its tips. No primary: Artifacts serves; machines hold copies.
  startArtifactsHome(repoId: string, uuid: string, sourceUrl: string, defaultBranch: string, now: number): RepoRow {
    const existing = this.repo(repoId);
    if (existing && existing.state !== 'deleted' && existing.state !== 'failed') fail(409, 'already_hosted', 'This project already has a copy in Smith');
    this.sql.exec('DELETE FROM git_repos WHERE id = ?', repoId);
    this.sql.exec("INSERT INTO git_repos (id, uuid, default_branch, primary_node_id, generation, state, source_url, created_at, updated_at) VALUES (?, ?, ?, NULL, 0, 'importing', ?, ?, ?)", repoId, uuid, defaultBranch, sourceUrl, now, now);
    return this.repo(repoId)!;
  }
  artifactsReady(repoId: string, tips: Tips, digest: string, peeled: Peeled, defaultBranch: string, bytes: number, now: number): RepoRow {
    this.sql.exec("UPDATE git_repos SET state = 'artifacts', refs_json = ?, refs_digest = ?, peeled_json = ?, default_branch = ?, bytes = ?, generation = generation + 1, message = '', updated_at = ? WHERE id = ?", JSON.stringify(tips), digest, JSON.stringify(peeled), defaultBranch, bytes, now, repoId);
    this.sql.exec("UPDATE git_replicas SET state = 'stale' WHERE repo_id = ? AND state = 'current'", repoId);
    return this.repo(repoId)!;
  }
  // The advertisement says what Artifacts holds now. A changed digest bumps the generation and marks every copy stale.
  adoptArtifactsTips(repo: RepoRow, tips: Tips, digest: string, peeled: Peeled, now: number): { changed: boolean; before: string; after: string } {
    if (repo.refs_digest === digest) return { changed: false, before: repo.refs_json, after: repo.refs_json };
    const after = JSON.stringify(tips);
    this.sql.exec("UPDATE git_repos SET refs_json = ?, refs_digest = ?, peeled_json = ?, generation = generation + 1, last_push_at = ?, updated_at = ? WHERE id = ?", after, digest, JSON.stringify(peeled), now, now, repo.id);
    this.sql.exec("UPDATE git_replicas SET state = 'stale' WHERE repo_id = ? AND state = 'current'", repo.id);
    return { changed: true, before: repo.refs_json, after };
  }
```

In `servers(...)`, first line: `if (repo.state === 'artifacts') return writer ? [] : this.replicas(repo.id).filter(r => r.state === 'current' && r.generation === repo.generation).map(r => nodes.find(n => n.id === r.node_id)).filter((n): n is HostNode => Boolean(n) && hostEligible(n!, now, offlineMs) && n!.id !== excludeNodeId);`. In `publicRepo`, add to the returned object `home: repo.state === 'artifacts' || repo.state === 'importing' ? 'artifacts' : 'machines'` and, for `artifacts`/`importing`, `primaryHost: null` and the existing copies list unchanged. Every place that lists live states for hosting work (`promote`, `planBackup`, `planRestore`, `hostEligible` callers in `reconcileGit`, `attachHostedSource`) keeps its explicit state lists, so an Artifacts home is skipped by them without change; `attachHostedSource` must also learn the local fast path for a current copy of an Artifacts home: change its state check to `!['hosting', 'oversize', 'degraded', 'artifacts'].includes(repo.state)`.

- [ ] **Step 4: `parseAdvertisement` and `fetchTips`**

Create `src/git-proxy.ts` (the `proxyGit` half is added in Task 4):

```ts
// The git endpoint's Artifacts backend (spec §2 and §3): pass-through of smart-HTTP requests to the Artifacts remote with
// a repo-scoped token, and the v1 advertisement read as the record's tips (Artifacts has no refs API).
import { canonicalTips, tipsDigest, validateTips, validatePeeled, type Peeled, type Tips } from './git-host';

const ZERO = '0'.repeat(40);
// pkt-lines: four hex digits of length (the four included), "0000" is a flush.
function* pktLines(text: string): Generator<string> {
  let at = 0;
  while (at + 4 <= text.length) {
    const length = parseInt(text.slice(at, at + 4), 16);
    if (Number.isNaN(length)) throw new Error('Not a git advertisement');
    if (length === 0) { at += 4; continue; }
    if (length < 4 || at + length > text.length) throw new Error('Not a git advertisement');
    yield text.slice(at + 4, at + length); at += length;
  }
}
export function parseAdvertisement(text: string): { tips: Tips; peeled: Peeled } {
  const lines = [...pktLines(text)];
  if (!lines.length || !lines[0].startsWith('# service=git-upload-pack')) throw new Error('Not a git-upload-pack advertisement');
  const refs: [string, string][] = []; const peeled: Record<string, string> = {};
  for (const raw of lines.slice(1)) {
    const line = raw.split('\0')[0].replace(/\n$/, '');
    const match = /^([a-f0-9]{40}) (\S+)$/.exec(line);
    if (!match) continue;
    const [, sha, ref] = match;
    if (sha === ZERO || ref === 'HEAD' || ref === 'capabilities^{}') continue;
    if (ref.endsWith('^{}')) { peeled[ref.slice(0, -3)] = sha; continue; }
    refs.push([sha, ref]);
  }
  const tips = validateTips(refs.sort((a, b) => a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return { tips, peeled: validatePeeled(peeled, tips) };
}
export async function fetchTips(remote: string, token: string): Promise<{ tips: Tips; peeled: Peeled; digest: string }> {
  const response = await fetch(`${remote}/info/refs?service=git-upload-pack`, { redirect: 'manual', signal: AbortSignal.timeout(30000),
    headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'smith-coordinator' } });
  if (!response.ok) throw new Error(`Artifacts answered ${response.status} for the advertisement`);
  const parsed = parseAdvertisement(await response.text());
  return { ...parsed, digest: await tipsDigest(parsed.tips) };
}
export { canonicalTips };
```

`validatePeeled(value, tips)` already exists in `git-host.ts` (line 112); if its signature takes `unknown`, pass the record as-is.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/git-proxy.test.ts test/git-host.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add cloudflare/coordinator/src/git-host.ts cloudflare/coordinator/src/git-proxy.ts cloudflare/coordinator/test/git-proxy.test.ts cloudflare/coordinator/test/git-host.test.ts
git commit --author="Claude Fable 5 <noreply@anthropic.com>" -m "feat(git): the record of an Artifacts home, and tips read from the advertisement

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: The git endpoint proxies an Artifacts home

**Files:**
- Modify: `cloudflare/coordinator/src/git-proxy.ts` (add `proxyGit`)
- Modify: `cloudflare/coordinator/src/git-route.ts:98-135` (the `backend` branch)
- Modify: `cloudflare/coordinator/src/git-workspace.ts:578-612` (`git-read`/`git-write`/`git-advertise`/`git-ls-refs` answer the backend) and the `gitAction` list for `git-artifacts-tips`
- Modify: `cloudflare/coordinator/src/workspace.ts` (schema 22 with `ARTIFACTS_TOKEN_SCHEMA`; RPC methods `artifactsToken`, `artifactsPushed`; `copyPushed` for both homes)
- Test: `cloudflare/coordinator/test/git-proxy.test.ts`

**Interfaces:**
- Consumes: `ArtifactsTokens` (Task 2), `fetchTips`, `adoptArtifactsTips` (Task 3), `authenticateGit`, `refusal`, `NO_CACHE`, `text` in `git-route.ts`.
- Produces: `proxyGit(request, remote, token, path, search): Promise<ProxyOutcome>` where `ProxyOutcome = { kind: 'response'; response: Response } | { kind: 'unavailable'; reason: string } | { kind: 'refused'; status: 401 | 403 }`; `STORAGE_UNREACHABLE = "Smith's storage is unreachable; nothing was pushed. Try again in a few minutes"`; Durable Object actions `git-read`/`git-write`/`git-advertise`/`git-ls-refs` answer `{ backend: 'artifacts', repoId, remote, scope: 'read' | 'write' }` for an Artifacts home (and `backend: 'relay'` plus the relay fields otherwise); request field `backend: 'relay'` forces the relay for a reader; `git-artifacts-tips { repo, tips, peeled }` (Worker-internal, principal `{ kind: 'worker' }` is not needed: the RPC method below calls the record directly); `WorkspaceCoordinator.artifactsToken(projectId, scope, force?)` and `WorkspaceCoordinator.artifactsPushed(repoId)` RPC methods (Worker only, like `gitRelay`).

- [ ] **Step 1: Write the failing tests**

Append to `test/git-proxy.test.ts`:

```ts
import { env } from 'cloudflare:workers';
import { afterEach, beforeAll, vi } from 'vitest';
import worker from '../src/index';
import { setup, origin, type Fixture } from './lfs-fixture';
import { fakeArtifacts } from '../src/artifacts-repos';
import { tipsDigest } from '../src/git-host';
import schema from '../migrations/0001_identity.sql?raw';
import browserSchema from '../migrations/0002_browser_auth.sql?raw';
import directorySchema from '../migrations/0003_workspace_directory.sql?raw';
import { runInDurableObject } from 'cloudflare:test';

beforeAll(async () => { await env.DB.exec(schema); await env.DB.exec(browserSchema); await env.DB.exec(directorySchema); });
afterEach(() => vi.unstubAllGlobals());

// A stand-in for Artifacts' git server: the v1 advertisement from `heads`, an echo of RPC bodies, and whatever
// `mode` says: 'ok', 'down' (connection refused), 'slow' (never answers), 'reject' (401 once, then ok).
function fakeGitServer(heads: Record<string, string>, mode: { value: string } = { value: 'ok' }) {
  const real = globalThis.fetch; const seen: { url: string; method: string; headers: Record<string, string>; body: string }[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init); const url = request.url;
    if (!url.includes('.artifacts.cloudflare.net/')) return real(input, init);
    seen.push({ url, method: request.method, headers: Object.fromEntries(request.headers), body: request.body ? await request.text() : '' });
    if (mode.value === 'down') throw new TypeError('connection refused');
    if (mode.value === 'slow') return new Promise<Response>(() => {});
    if (mode.value === 'reject') { mode.value = 'ok'; return new Response('bad token', { status: 401 }); }
    if (url.includes('/info/refs')) {
      const lines = Object.entries(heads).map(([ref, sha]) => pkt(`${sha} ${ref}\n`)).join('');
      return new Response(pkt('# service=git-upload-pack\n') + '0000' + lines + '0000', { headers: { 'Content-Type': 'application/x-git-upload-pack-advertisement' } });
    }
    if (url.endsWith('/git-receive-pack')) { heads['refs/heads/master'] = sha('e'); return new Response('000eunpack ok\n0000', { headers: { 'Content-Type': 'application/x-git-receive-pack-result' } }); }
    return new Response('echo:' + seen[seen.length - 1].body, { headers: { 'Content-Type': 'application/x-git-upload-pack-result' } });
  });
  return seen;
}
// A project whose home is Artifacts, as an import or Move to storage leaves it (Task 5 adds the real path; this seeds the record).
async function artifactsHome(f: Fixture) {
  const remote = fakeArtifacts.remote(`${f.workspaceId.slice(0, 12)}-senet`);
  fakeArtifacts.seed(`${f.workspaceId.slice(0, 12)}-senet`, 'master', sha('a'));
  await runInDurableObject(f.stub, async (instance: { ctx: DurableObjectState; seedArtifactsHomeForTest: (id: string, remote: string, tips: [string, string][]) => Promise<void> }) => {
    await instance.seedArtifactsHomeForTest('senet', remote, [[sha('a'), 'refs/heads/master']]);
  });
  return remote;
}
const git = (f: Fixture, token: string, path: string, init: RequestInit = {}) => worker.fetch(new Request(`${origin}/git/senet.git/${path}`, { ...init, headers: { Authorization: `Basic ${btoa(`${f.workspaceId.slice(0, 12)}:${token}`)}`, ...(init.headers ?? {}) } }), env);

describe('the proxy', () => {
  it('passes the advertisement and both RPCs through with headers, bodies and a cached token', async () => {
    const f = await setup(); const token = await f.pat(); const remote = await artifactsHome(f);
    const seen = fakeGitServer({ 'refs/heads/master': sha('a') });
    const adv = await git(f, token, 'info/refs?service=git-upload-pack', { headers: { 'Git-Protocol': 'version=2' } });
    expect([adv.status, adv.headers.get('Content-Type')]).toEqual([200, 'application/x-git-upload-pack-advertisement']);
    expect((await adv.text()).includes(sha('a'))).toBe(true);
    const rpc = await git(f, token, 'git-upload-pack', { method: 'POST', body: 'want', headers: { 'Content-Type': 'application/x-git-upload-pack-request', 'Content-Encoding': 'identity' } });
    expect([rpc.status, await rpc.text()]).toEqual([200, 'echo:want']);
    expect(seen.map(s => s.url)).toEqual([`${remote}/info/refs?service=git-upload-pack`, `${remote}/git-upload-pack`]);
    expect(seen[0].headers['git-protocol']).toBe('version=2');
    expect(seen[1].headers['content-type']).toBe('application/x-git-upload-pack-request');
    expect(seen[0].headers.authorization).toBe(seen[1].headers.authorization);   // one read token, reused
    expect(seen[0].headers.authorization).toMatch(/^Bearer art_v1_/);
    expect(adv.headers.get('Cache-Control')).toContain('no-cache');
  });
  it('a push refreshes the tips, bumps the generation and reads smith.json at the new commit', async () => {
    const f = await setup(); const token = await f.pat(); await artifactsHome(f);
    fakeGitServer({ 'refs/heads/master': sha('a') });
    const push = await git(f, token, 'git-receive-pack', { method: 'POST', body: 'pack', headers: { 'Content-Type': 'application/x-git-receive-pack-request' } });
    expect(push.status).toBe(200);
    await new Promise(resolve => setTimeout(resolve, 200));   // ctx.waitUntil
    await runInDurableObject(f.stub, async (instance: { ctx: DurableObjectState }) => {
      const row = instance.ctx.storage.sql.exec<{ generation: number; refs_json: string }>("SELECT generation, refs_json FROM git_repos WHERE id = 'senet'").one();
      expect([row.generation, JSON.parse(row.refs_json)]).toEqual([2, [[sha('e'), 'refs/heads/master']]]);
    });
    const shown = (await (await f.stub.execute(f.human, 'projects', {})).json() as { projects: { id: string; scan: { state: string } }[] }).projects.find(p => p.id === 'senet')!;
    expect(['waiting', 'scanning']).toContain(shown.scan.state);
  });
  it('a failed tips fetch after a push leaves the record for the alarm', async () => {
    const f = await setup(); const token = await f.pat(); await artifactsHome(f);
    const mode = { value: 'ok' }; fakeGitServer({ 'refs/heads/master': sha('a') }, mode);
    const seen = fakeGitServer({ 'refs/heads/master': sha('a') }, mode);
    void seen;
    const pushPromise = git(f, token, 'git-receive-pack', { method: 'POST', body: 'pack', headers: { 'Content-Type': 'application/x-git-receive-pack-request' } });
    mode.value = 'down';   // Artifacts answered the push; the advertisement that follows cannot be fetched
    expect((await pushPromise).status).toBe(200);
    await new Promise(resolve => setTimeout(resolve, 200));
    await runInDurableObject(f.stub, async (instance: { ctx: DurableObjectState }) => {
      expect(instance.ctx.storage.sql.exec<{ generation: number; state: string }>("SELECT generation, state FROM git_repos WHERE id = 'senet'").one()).toEqual({ generation: 1, state: 'artifacts' });
    });
  });
  it('refuses a push and falls a read over to a copy when Artifacts is unreachable', async () => {
    const f = await setup(); const token = await f.pat(); await artifactsHome(f);
    fakeGitServer({}, { value: 'down' });
    const adv = await git(f, token, 'info/refs?service=git-receive-pack');
    expect(await adv.text()).toContain("ERR Smith's storage is unreachable; nothing was pushed. Try again in a few minutes");
    const rpc = await git(f, token, 'git-receive-pack', { method: 'POST', body: 'pack', headers: { 'Content-Type': 'application/x-git-receive-pack-request' } });
    expect([rpc.status, (await rpc.text()).trim()]).toEqual([503, "Smith's storage is unreachable; nothing was pushed. Try again in a few minutes"]);
    // No machine holds a current copy: the read says so too.
    const read = await git(f, token, 'info/refs?service=git-upload-pack');
    expect(await read.text()).toContain('ERR No machine holding a copy of this repository is online');
  });
  it('re-mints once when Artifacts rejects the token, then gives up with a 502', async () => {
    const f = await setup(); const token = await f.pat(); await artifactsHome(f);
    const mode = { value: 'reject' }; const seen = fakeGitServer({ 'refs/heads/master': sha('a') }, mode);
    expect((await git(f, token, 'info/refs?service=git-upload-pack')).status).toBe(200);
    expect(seen.length).toBe(2);
    expect(seen[0].headers.authorization).not.toBe(seen[1].headers.authorization);
    fakeArtifacts.failNext = { status: 502, code: 'artifacts_failed' };   // the second mint fails
    mode.value = 'reject'; const again = await git(f, token, 'info/refs?service=git-upload-pack');
    expect(again.status).toBe(502);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/git-proxy.test.ts`
Expected: FAIL (`seedArtifactsHomeForTest` missing; the route still relays).

- [ ] **Step 3: `proxyGit`**

Append to `src/git-proxy.ts`:

```ts
export const STORAGE_UNREACHABLE = "Smith's storage is unreachable; nothing was pushed. Try again in a few minutes";
export const FIRST_BYTE_MS = 30000;
export type ProxyOutcome = { kind: 'response'; response: Response } | { kind: 'unavailable'; reason: string } | { kind: 'refused'; status: 401 | 403 };
const FORWARDED = ['content-type', 'content-encoding', 'accept', 'git-protocol', 'user-agent'];
// Streams one smart-HTTP request to the Artifacts remote and its answer back. Only the time to the first byte is bounded:
// a clone's pack streams for as long as it takes. A 5xx or no answer is 'unavailable'; a 401/403 means the token is bad.
export async function proxyGit(request: Request, remote: string, token: string, path: 'info/refs' | 'git-upload-pack' | 'git-receive-pack', search: string): Promise<ProxyOutcome> {
  const headers = new Headers({ Authorization: `Bearer ${token}` });
  for (const name of FORWARDED) { const value = request.headers.get(name); if (value) headers.set(name, value); }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FIRST_BYTE_MS);
  try {
    const upstream = await fetch(`${remote}/${path}${search}`, { method: request.method, headers, body: request.method === 'POST' ? request.body : undefined, redirect: 'manual', signal: controller.signal });
    clearTimeout(timer);
    if (upstream.status === 401 || upstream.status === 403) return { kind: 'refused', status: upstream.status };
    if (upstream.status >= 500 || upstream.status === 429 || upstream.status === 0) return { kind: 'unavailable', reason: `Artifacts answered ${upstream.status}` };
    const out = new Headers({ 'Cache-Control': 'no-cache, max-age=0, must-revalidate', Pragma: 'no-cache', Expires: 'Fri, 01 Jan 1980 00:00:00 GMT', 'X-Content-Type-Options': 'nosniff' });
    const type = upstream.headers.get('Content-Type'); if (type) out.set('Content-Type', type);
    return { kind: 'response', response: new Response(upstream.body, { status: upstream.status, headers: out }) };
  } catch (error) {
    clearTimeout(timer);
    return { kind: 'unavailable', reason: error instanceof Error ? error.message.slice(0, 200) : 'no answer' };
  }
}
```

- [ ] **Step 4: The workspace side**

In `src/workspace.ts`: import `ARTIFACTS_TOKEN_SCHEMA, ArtifactsTokens, READ_CACHE_MS, WRITE_CACHE_MS` from `./artifacts-tokens`; in the constructor's schema block add `this.ctx.storage.sql.exec(ARTIFACTS_TOKEN_SCHEMA);` beside `LFS_SCHEMA`; add the migration (after version 21):

```ts
      if (version < 22) {
        // Copies on machines share one budget per machine (copies.ts); NULL means the workspace default.
        this.sql.exec('ALTER TABLE nodes ADD COLUMN copy_budget_bytes INTEGER');
        this.sql.exec('INSERT INTO schema_migrations VALUES (22)');
      }
```

(`imports`, `import_repos` are `CREATE TABLE IF NOT EXISTS` in Task 8's schema constant, run from the constructor like the others.) Add `copy_budget_bytes: number | null;` to `NodeRow`.

Add two RPC methods beside `gitRelay`:

```ts
  // A repo-scoped Artifacts token for the proxy (spec §2), cached until shortly before it lapses; `force` drops the cached
  // one first (Artifacts rejected it). Worker only, outside any transaction because minting is a network call.
  async artifactsToken(projectId: string, scope: 'read' | 'write', force = false): Promise<Response> {
    const now = Date.now();
    const project = this.anyProject(projectId);
    if (!project?.artifacts || project.artifacts.status !== 'done') return json({ error: { code: 'not_on_artifacts', message: 'This project has no copy in Smith’s storage' } }, 404);
    const cache = new ArtifactsTokens(this.sql);
    const dropped = force ? this.ctx.storage.transactionSync(() => cache.drop(projectId, scope)) : undefined;
    if (dropped) { try { await this.artifactsFor(project.artifacts.accountId).revokeToken(project.artifacts.repo, dropped.tokenId); } catch { /* it lapses by itself */ } }
    const cached = force ? undefined : cache.get(projectId, scope, now + 60000);
    if (cached) return json({ token: cached.plaintext, expiresAt: cached.expiresAt });
    const ttl = scope === 'read' ? READ_CACHE_MS : WRITE_CACHE_MS;
    const issued = await this.artifactsFor(project.artifacts.accountId).issueToken(project.artifacts.repo, scope, Math.ceil(ttl / 1000) + 300);
    const previous = this.ctx.storage.transactionSync(() => { const old = cache.drop(projectId, scope); cache.store(projectId, scope, issued.id, issued.plaintext, now + ttl); return old; });
    if (previous) { try { await this.artifactsFor(project.artifacts.accountId).revokeToken(project.artifacts.repo, previous.tokenId); } catch { /* lapses */ } }
    return json({ token: issued.plaintext, expiresAt: now + ttl });
  }
  // After a proxied push answered OK (spec §2): the advertisement becomes the record's tips; Build on push and copy
  // refreshes follow. A failed fetch changes nothing; the alarm's daily refresh catches up.
  async artifactsPushed(repoId: string): Promise<void> {
    try { await this.gitOps.refreshArtifactsTips(repoId, 'push'); }
    catch (error) { console.error(JSON.stringify({ event: 'artifacts_tips_failed', repoId, message: error instanceof Error ? error.message.slice(0, 200) : 'unknown' })); }
  }
  // Tests seed an Artifacts home without running an import.
  async seedArtifactsHomeForTest(projectId: string, remote: string, tips: [string, string][]): Promise<void> {
    const digest = await tipsDigest(tips);
    this.ctx.storage.transactionSync(() => {
      const project = this.anyProject(projectId)!; const now = Date.now();
      const name = repoNameFor(this.workspaceId(), projectId);
      this.hostedGit.startArtifactsHome(projectId, crypto.randomUUID(), remote, project.branch, now);
      this.hostedGit.artifactsReady(projectId, tips, digest, {}, project.branch, 0, now);
      this.saveProject({ ...project, home: 'artifacts', repoUrl: smithRemote(this.env.ORIGIN, projectId), artifacts: { repo: name, namespace: 'default', remote, status: 'done', accountId: this.artifactsCredentials().accountId, source: 'smith', sourceRepoUrl: project.repoUrl, updatedAt: now } } as Project);
    });
  }
```

In `GitOps` (`git-workspace.ts`) add, with `fetchTips` imported from `./git-proxy` and a `GitContext` addition `artifactsToken(projectId: string, scope: 'read' | 'write'): Promise<string>` (implemented in `workspace.ts`'s context object as `async (id, scope) => { const r = await this.artifactsToken(id, scope); if (!r.ok) throw new Error('no token'); return (await r.json() as { token: string }).token; }`):

```ts
  // The advertisement of an Artifacts home as the record's tips (spec §3): after a proxied push, daily from the alarm,
  // after Move to storage, and when a copy reports a digest the record lacks.
  async refreshArtifactsTips(repoId: string, reason: 'push' | 'alarm' | 'move' | 'copy'): Promise<boolean> {
    const repo = this.c.hostedGit.repo(repoId);
    const project = this.c.anyProject(repoId);
    if (!repo || repo.state !== 'artifacts' || !project?.artifacts) return false;
    const token = await this.c.artifactsToken(repoId, 'read');
    const fetched = await fetchTips(project.artifacts.remote, token);
    let changed = false;
    this.c.storage.transactionSync(() => {
      const now = Date.now(); const current = this.c.hostedGit.repo(repoId); if (!current || current.state !== 'artifacts') return;
      const adopted = this.c.hostedGit.adoptArtifactsTips(current, fetched.tips, fetched.digest, fetched.peeled, now);
      changed = adopted.changed;
      if (!adopted.changed) return;
      this.c.hostedGit.audit(now, reason, repoId, 'tips', '', 0, 'adopted from Artifacts');
      if (reason === 'push') this.c.copyPushed(repoId, adopted.before, adopted.after, now);
      this.reconcileGit(now);   // copies of the new generation
    });
    if (changed) await this.c.schedule();
    return changed;
  }
```

In `gitAction`'s `git-read`/`git-write`/`git-advertise`/`git-ls-refs` block, after `let repo = git.repo(repoId);` and the `not_found`/`bootstrapping` checks, add:

```ts
        if (repo.state === 'importing') fail(503, 'copying', 'Smith is still importing this repository; try again in a few minutes');
        if (repo.state === 'artifacts' && body.backend !== 'relay') {
          const project = this.c.anyProject(repoId);
          if (!project?.artifacts) fail(404, 'not_found', 'Repository not found');
          git.audit(now, who, repo.id, service, '', 0, 'proxied to storage');
          return json({ backend: 'artifacts', repoId: repo.id, remote: project.artifacts.remote, scope: writer ? 'write' : 'read', writer });
        }
        if (repo.state === 'artifacts' && writer) fail(503, 'storage_unreachable', STORAGE_UNREACHABLE);
```

Add `'backend'` to that block's `fields(body, [...])` list. Below, where `servers` is empty for an Artifacts home being relayed, the existing `no_host` failure text is replaced for that state: `if (!servers.length && repo.state === 'artifacts') fail(503, 'no_host', 'No machine holding a copy of this repository is online, and Smith’s storage did not answer; try again in a few minutes');` (the test checks the leading words).

In `copyPushed` (`workspace.ts`), change the guard `if (copy?.kind !== 'hosted' || ...)` to `if (!copy || (syncRunning(copy) && copy.sync!.direction === 'pull')) return;`.

- [ ] **Step 5: The route**

In `src/git-route.ts`, import `proxyGit, STORAGE_UNREACHABLE` from `./git-proxy`. Add a type `type ProxyOpen = { backend: 'artifacts'; repoId: string; remote: string; scope: 'read' | 'write'; writer: boolean }` and a helper above `handleGit`:

```ts
// The Artifacts backend (spec §2): a token from the workspace object's cache, the request passed through; a rejected token
// is re-minted once; Artifacts down lets a reader fall over to a machine copy and tells a writer to try later.
async function viaArtifacts(request: Request, stub: GitAuth extends { ok: true; stub: infer S } ? S : never, open: ProxyOpen, path: 'info/refs' | 'git-upload-pack' | 'git-receive-pack', search: string, op: RelayOp, service: GitService): Promise<Response | 'relay'> {
  let force = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    const minted = await stub.artifactsToken(open.repoId, open.scope, force);
    if (!minted.ok) return text(502, 'Smith could not reach its copy of this project');
    const { token } = await minted.json() as { token: string };
    const outcome = await proxyGit(request, open.remote, token, path, search);
    if (outcome.kind === 'response') return outcome.response;
    if (outcome.kind === 'refused') { console.error(JSON.stringify({ event: 'artifacts_token_refused', repoId: open.repoId, attempt })); force = true; continue; }
    console.error(JSON.stringify({ event: 'artifacts_unavailable', repoId: open.repoId, reason: outcome.reason }));
    if (open.writer) return op === 'info-refs' ? new Response(pktErr(STORAGE_UNREACHABLE), { status: 200, headers: { 'Content-Type': `application/x-git-${service}-advertisement`, ...NO_CACHE } }) : text(503, STORAGE_UNREACHABLE);
    return 'relay';
  }
  return text(502, 'Smith could not reach its copy of this project');
}
```

In `handleGit`: the v2 advertisement branch becomes `const allowed = await stub.execute(principal, 'git-advertise', {...}); if (!allowed.ok) return await refuse(allowed); const answer = await allowed.json() as { backend?: string } & ProxyOpen; if (answer.backend === 'artifacts') { const r = await viaArtifacts(request, stub, answer, 'info/refs', url.search, op, service); if (r !== 'relay') return r; } else return new Response(v2Advertisement(), ...)` (when `'relay'` comes back, fall through to the `git-read` opening below with `backend: 'relay'`). The `ls-refs` branch likewise proxies when the answer says `backend: 'artifacts'` (the peeked request is re-sent: `peekBody` already returns a request whose body is whole). Then the main opening:

```ts
  let forced: Record<string, unknown> = {};
  for (;;) {
    const opened = await stub.execute(principal, service === 'receive-pack' ? 'git-write' : 'git-read', { repo: repoId, service, op, username, gitProtocol, label: ticket ? undefined : 'member', ...forced });
    if (!opened.ok) return await refuse(opened);
    const answer = await opened.json() as Opened | ProxyOpen;
    if ('backend' in answer && answer.backend === 'artifacts') {
      const proxied = await viaArtifacts(request, stub, answer, route === 'info/refs' ? 'info/refs' : route as 'git-upload-pack' | 'git-receive-pack', url.search, op, service);
      if (proxied !== 'relay') { if (service === 'receive-pack' && proxied.status === 200) ctx.waitUntil(stub.artifactsPushed(answer.repoId)); return proxied; }
      forced = { backend: 'relay' }; continue;
    }
    relay = answer as Opened; break;
  }
```

(`let relay: Opened;` declared before the loop; the code after it is unchanged.) Note the body: `proxyGit` consumes `request.body`; on failover to the relay for a read, the body must still be available. `info/refs` has none; for an `upload-pack` RPC after an `unavailable` outcome the body may have been partly consumed, so for `op === 'rpc'` reads the route first buffers up to 16 MiB with the existing `peekBody(request, 16 * 1024 * 1024)` before proxying (the negotiation body cap is 16 MiB already) and passes the re-created request on both paths.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run test/git-proxy.test.ts test/git-host.test.ts test/lfs-route.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add cloudflare/coordinator/src/git-proxy.ts cloudflare/coordinator/src/git-route.ts cloudflare/coordinator/src/git-workspace.ts cloudflare/coordinator/src/workspace.ts cloudflare/coordinator/test/git-proxy.test.ts
git commit --author="Claude Fable 5 <noreply@anthropic.com>" -m "feat(git): proxy an Artifacts home behind Smith's URL, with failover and push detection

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Homes for existing projects, Move and Restore to storage, removal, the Smith-copy checks

**Files:**
- Modify: `cloudflare/coordinator/src/git-workspace.ts` (remove `queueDupe`, `reconcileSmithCopies`, `keepArtifactsCurrent`, `artifactsCredential`; add `assignHomes`, `moveToStorage`, `restoreToStorage`, `reconcileArtifactsHomes`)
- Modify: `cloudflare/coordinator/src/workspace.ts` (dispatch, `removeProject`, alarm, `publicProject`, `pullToken`, `startSync` token branch)
- Modify: `cloudflare/coordinator/src/upstream.ts` (`syncSpecs`), `cloudflare/coordinator/src/crew.ts:100-106`, `cloudflare/coordinator/src/sessions.ts:153`, `cloudflare/coordinator/src/index.ts` (routes)
- Modify: `cloudflare/coordinator/src/git-host.ts` (`ARTIFACTS_PRODUCT` becomes `MOVE_PRODUCT = 'move-to-storage'`, `RESTORE_PRODUCT = 'restore-to-storage'`)
- Test: `cloudflare/coordinator/test/home.test.ts`, `cloudflare/coordinator/test/smith-projects.test.ts`, `cloudflare/coordinator/test/crew-no-copy.test.ts`

**Interfaces:**
- Consumes: `assignHome` (Task 1), `startArtifactsHome`/`artifactsReady`/`adoptArtifactsTips`/`fetchTips` (Tasks 3, 4), `ArtifactsClient.deleteRepo` (Task 2), `mirrorSpecs` (`projects.ts`), `hostSpecs` (`git-host.ts`).
- Produces: actions `move-to-storage { projectId, requestId }` and `restore-to-storage { projectId, requestId }` (owner/admin; routes `POST projects/:id/move-to-storage`, `POST projects/:id/restore-to-storage`); `GitOps.assignHomes(now): number` (the upgrade pass, run on the first alarm and idempotent); `GitOps.reconcileArtifactsHomes(now): Promise<boolean>` (daily tips refresh, loss probe, settlement of move/restore jobs); `hasSmithCopy` and `pushNeedsBuilder` true for both homes; `removeProject` deletes the Artifacts repository and its tokens; `ProjectArtifacts.move?: { jobId; tokenId?; commit; at; message? }`.

- [ ] **Step 1: Write the failing tests**

Append to `test/home.test.ts` (the Workers-runtime part; add the `env`, `setup`, `runInDurableObject`, `fakeArtifacts`, `fakeGitServer`-style imports as in `git-proxy.test.ts`, and the `beforeAll` D1 schema lines):

```ts
describe('homes of existing projects', () => {
  it('the upgrade pass gives legacy projects a home without moving bytes', async () => {
    const f = await setup();
    const remote = fakeArtifacts.remote(`${f.workspaceId.slice(0, 12)}-senet`); fakeArtifacts.seed(`${f.workspaceId.slice(0, 12)}-senet`, 'master', sha('a'));
    await runInDurableObject(f.stub, async (instance: { ctx: DurableObjectState; saveProjectForTest: (p: unknown) => void; assignHomesForTest: () => Promise<number> }) => {
      const project = { id: 'senet', name: 'Senet', repoUrl: remote, branch: 'master', commit: sha('a'), products: [], artifacts: { repo: `${f.workspaceId.slice(0, 12)}-senet`, namespace: 'default', remote, status: 'done', accountId: fakeArtifacts.account, source: 'smith', sourceRepoUrl: 'git@github.com:Red-Marmoset/senet.git', updatedAt: 1 } };
      instance.saveProjectForTest(project);
      fakeGitServer({ 'refs/heads/master': sha('a') });
      expect(await instance.assignHomesForTest()).toBe(1);
      expect(await instance.assignHomesForTest()).toBe(0);
      const row = instance.ctx.storage.sql.exec<{ state: string; refs_json: string }>("SELECT state, refs_json FROM git_repos WHERE id = 'senet'").one();
      expect([row.state, JSON.parse(row.refs_json)]).toEqual(['artifacts', [[sha('a'), 'refs/heads/master']]]);
    });
    const shown = (await (await f.stub.execute(f.human, 'projects', {})).json() as { projects: { id: string; home?: string; repoUrl: string }[] }).projects.find(p => p.id === 'senet')!;
    expect([shown.home, shown.repoUrl]).toEqual(['artifacts', `${origin}/git/senet.git`]);
  });
  it('Move to storage mirrors a machines home into Artifacts and flips the home; the machine copy stays a copy', async () => {
    const f = await setup();
    const node = await f.node([GIT_HOST_LABEL, GIT_CLIENT_LABEL, 'smith-repo-projects']);   // the git-host fixture's node() with hosting
    await hostedOnMachine(f, node);   // helper copied from git-host.test.ts `hosted`: switch on, host-project, claim, complete with a host report
    fakeGitServer({});
    const moved = await f.stub.execute(f.human, 'move-to-storage', { projectId: 'senet', requestId: crypto.randomUUID() });
    expect(moved.status).toBe(201);
    const job = (await moved.json() as { job: { id: string; kind: string; product: string } }).job;
    expect([job.kind, job.product]).toEqual(['mirror', 'move-to-storage']);
    const assignment = await (await f.stub.execute(node, 'claim', {})).json() as { envelope: { lease: Lease; spec: { mirror: { remote: string; authToken: string; branch: string } } } };
    expect(assignment.envelope.spec.mirror.remote).toMatch(/\.artifacts\.cloudflare\.net\//);
    fakeArtifacts.setHead(`${f.workspaceId.slice(0, 12)}-senet`, 'master', commit);
    await f.stub.execute(node, 'complete', { ...assignment.envelope.lease, result: { status: 'success', exitCode: 0, durationMs: 1, message: '', commit } });
    await runInDurableObject(f.stub, async (instance: { reconcileArtifactsHomesForTest: () => Promise<void> }) => { await instance.reconcileArtifactsHomesForTest(); });
    const shown = (await (await f.stub.execute(f.human, 'projects', {})).json() as { projects: { id: string; home?: string; hosted?: { status: string } }[] }).projects.find(p => p.id === 'senet')!;
    expect(shown.home).toBe('artifacts');
    expect(shown.hosted).toBeUndefined();
    const nodes = (await (await f.stub.execute(f.human, 'nodes', {})).json() as { nodes: { hosted: { repoId: string; primary: boolean }[] }[] }).nodes;
    expect(nodes[0].hosted).toEqual([{ repoId: 'senet', primary: false, state: 'stale', bytes: expect.any(Number) }]);   // a copy now, refreshed by the planner
  });
  it('Restore to storage is offered for a lost Artifacts home with a current copy, and removal deletes the repository', async () => {
    const f = await setup(); await artifactsHome(f);
    fakeArtifacts.repos.clear();   // the repository vanished from Artifacts
    fakeGitServer({}, { value: 'down' });
    await runInDurableObject(f.stub, async (instance: { reconcileArtifactsHomesForTest: () => Promise<void> }) => { await instance.reconcileArtifactsHomesForTest(); });
    let shown = (await (await f.stub.execute(f.human, 'projects', {})).json() as { projects: { id: string; hosted?: { state: string; message?: string } }[] }).projects.find(p => p.id === 'senet')!;
    expect(shown.hosted?.state).toBe('lost');
    expect(shown.hosted?.message).toContain('Smith’s storage no longer has this repository');
    expect((await f.stub.execute(f.human, 'restore-to-storage', { projectId: 'senet', requestId: crypto.randomUUID() })).status).toBe(409);   // no machine holds a copy
    vi.unstubAllGlobals(); fakeArtifacts.seed(`${f.workspaceId.slice(0, 12)}-senet`, 'master', sha('a'));
    const removed = await f.stub.execute(f.human, 'remove-project', { projectId: 'senet' });
    expect(removed.status).toBe(200);
    expect(fakeArtifacts.repos.size).toBe(0);
  });
});
```

Update `test/smith-projects.test.ts`: the tests that expect an Artifacts-first project to be moved onto a machine by a `host` job ("takes a copy as soon as a machine is online", the `keep-artifacts-copy` mirror) now expect the project to keep `home: 'artifacts'`, `repoUrl` Smith's URL, and the machine to receive a `replicate` task on its next `git-poll` instead; the `artifacts-credential` test is deleted. In `test/crew-no-copy.test.ts`, the crew admission test for an Artifacts copy sets `home: 'artifacts'` on the seeded project and expects admission.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/home.test.ts test/smith-projects.test.ts test/crew-no-copy.test.ts`
Expected: FAIL (actions missing; old behaviour still moves projects onto machines).

- [ ] **Step 3: Remove the Artifacts-to-machine move and the push-back mirror**

In `git-workspace.ts` delete `queueDupe`, `reconcileSmithCopies`, `keepArtifactsCurrent`, `saveArtifacts` (if nothing else uses it), `artifactsCredential`, the `DUPE_TOKEN_TTL`, `CLONE_TOKEN_TTL` and `BACKUP_RETRY_MS` constants, and in `addSmithProject` the `dupe` token mint and `queueDupe` call: a project started on Artifacts gets `home: 'artifacts'`, `repoUrl: smithRemote(origin, id)` and a `git_repos` row via `startArtifactsHome` + `artifactsReady(..., firstCommitTips, ...)` where the tips are `[[first.commit, 'refs/heads/' + draft.branch]]` with their digest computed before the transaction. In `workspace.ts` delete the `reconcileSmithCopies` calls (alarm line 464 and line 1062), the `artifacts-credential` dispatch, and in `index.ts` the `artifactsCredential` route. In `git-host.ts` rename `ARTIFACTS_PRODUCT` to `MOVE_PRODUCT = 'move-to-storage'` and add `RESTORE_PRODUCT = 'restore-to-storage'`. Remove `ProjectArtifacts.backup` and add `move?: { jobId: string; tokenId?: string; commit: string; at: number; message?: string }`.

- [ ] **Step 4: The upgrade pass and the daily reconcile**

In `GitOps`:

```ts
  // One pass after deploy (spec §1): every project without a home gets one. An Artifacts copy addressed directly becomes an
  // Artifacts home behind Smith's URL once its advertisement is read; a failure leaves that project for the next pass.
  async assignHomes(): Promise<number> {
    let assigned = 0;
    for (const project of this.c.allProjects()) {
      const next = assignHome(project, this.c.env.ORIGIN);
      if (!next) continue;
      try {
        if (next.home === 'artifacts') {
          const token = await this.c.artifactsToken(project.id, 'read');
          const fetched = await fetchTips(project.artifacts!.remote, token);
          this.c.storage.transactionSync(() => {
            const current = this.c.anyProject(project.id); if (!current || current.home) return;
            const now = Date.now();
            this.c.hostedGit.startArtifactsHome(current.id, crypto.randomUUID(), current.artifacts!.remote, current.branch, now);
            this.c.hostedGit.artifactsReady(current.id, fetched.tips, fetched.digest, fetched.peeled, current.branch, 0, now);
            this.c.saveProject({ ...current, home: 'artifacts', repoUrl: next.repoUrl } as Project);
            assigned++;
          });
        } else {
          this.c.storage.transactionSync(() => { const current = this.c.anyProject(project.id); if (current && !current.home) { this.c.saveProject({ ...current, home: 'machines' } as Project); assigned++; } });
        }
      } catch (error) { console.error(JSON.stringify({ event: 'assign_home_failed', projectId: project.id, message: error instanceof Error ? error.message.slice(0, 200) : 'unknown' })); }
    }
    return assigned;
  }
  // Artifacts homes, from the alarm: tips refreshed once a day, a repository gone from Artifacts marked lost (with the fix),
  // moves and restores settled against the Artifacts head. Answers whether something should be retried soon.
  async reconcileArtifactsHomes(): Promise<boolean> {
    let retry = false;
    for (const repo of this.c.hostedGit.repos().filter(r => r.state === 'artifacts' || r.state === 'lost')) {
      const project = this.c.anyProject(repo.id); if (!project?.artifacts || project.home !== 'artifacts') continue;
      const now = Date.now();
      if (repo.state === 'artifacts' && now - repo.updated_at < ARTIFACTS_REFRESH_MS) continue;
      try {
        const exists = await this.c.artifacts(project.artifacts.accountId).getRepo(project.artifacts.repo);
        if (!exists) { this.c.storage.transactionSync(() => this.c.hostedGit.markLost(repo.id, 'Smith’s storage no longer has this repository; a machine holding a copy can restore it', Date.now())); continue; }
        if (repo.state === 'lost') continue;   // Restore to storage brings it back; see restoreToStorage
        await this.refreshArtifactsTips(repo.id, 'alarm');
        this.c.storage.transactionSync(() => this.c.sql.exec('UPDATE git_repos SET updated_at = ? WHERE id = ?', Date.now(), repo.id));
      } catch (error) { console.error(JSON.stringify({ event: 'artifacts_home_reconcile_failed', repoId: repo.id, message: error instanceof Error ? error.message.slice(0, 200) : 'unknown' })); retry = true; }
    }
    retry = await this.settleMoves() || retry;
    return retry;
  }
```

`ARTIFACTS_REFRESH_MS = 24 * 3600000`. `HostedGit.markLost(repoId, message, now)` sets `state = 'lost'` and `message`; add it if `git-host.ts` lacks one (`promote` sets `lost` inline today; a helper is clearer). In `workspace.ts`'s `alarm()`, after `reconcileSyncs()`: `if (!this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM meta WHERE homes_assigned = 1").one().n) { await this.gitOps.assignHomes(); this.sql.exec('UPDATE meta SET homes_assigned = 1'); }` with `ALTER TABLE meta ADD COLUMN homes_assigned INTEGER NOT NULL DEFAULT 0` in migration 22; and include `await this.gitOps.reconcileArtifactsHomes()` in the `crewRetry` array in place of `reconcileSmithCopies`. Add the test hooks `saveProjectForTest(project)`, `assignHomesForTest()`, `reconcileArtifactsHomesForTest()` beside `sweepLfsForTest`.

- [ ] **Step 5: Move to storage and Restore to storage**

In `GitOps`:

```ts
  // Move to storage (spec §1): a mirror job pushes every branch and tag of a machines home into a fresh Artifacts repository
  // with a write token; the Worker verifies the heads, then the home flips and the machine copies become copies.
  async moveToStorage(userId: string, body: Record<string, unknown>): Promise<Response> {
    fields(body, ['projectId', 'requestId']);
    const projectId = string(body, 'projectId', 64), requestId = string(body, 'requestId');
    this.c.requireHuman(userId, true, true);
    const project = this.c.anyProject(projectId); const repo = this.c.hostedGit.repo(projectId);
    if (!isRepoProject(project) || project.home !== 'machines' || !repo || repo.state !== 'hosting') fail(409, 'not_on_machines', 'Move to storage is for a project whose copies are on machines and current');
    if (!await this.c.artifactsReady()) fail(503, 'artifacts_unconfigured', 'Smith’s storage is not set up; see Settings');
    if (!fitsArtifacts(repo.bytes)) fail(409, 'oversize', `This repository is ${formatBytes(repo.bytes)}, over the 1 GB Smith’s storage holds`);
    if (project.artifacts?.move?.jobId) fail(409, 'move_pending', 'A move is already under way');
    const client = this.c.artifacts(); const name = repoNameFor(this.c.workspaceId(), projectId);
    const created = await client.createRepo(name, repo.default_branch || project.branch, `Smith: ${project.name}`);
    const token = await client.issueToken(name, 'write', WRITE_TOKEN_TTL);
    const tip = (JSON.parse(repo.refs_json) as Tips).find(([, ref]) => ref === `refs/heads/${project.branch}`)?.[0] ?? '';
    const response = this.c.storage.transactionSync(() => {
      const now = Date.now(); const current = this.c.anyProject(projectId) as RepoProject;
      const id = crypto.randomUUID();
      const specs = mirrorSpecs({ id: current.id, repoUrl: current.repoUrl, branch: current.branch, commit: tip }, id, created.remote, token.plaintext);
      for (const spec of Object.values(specs)) spec.mirror!.allRefs = true;   // every branch and tag, not one branch (Task 12 teaches the agent)
      this.c.sql.exec("INSERT INTO jobs (id, kind, request_id, specs, project_id, product, required_labels, state, created_at, updated_at, revision) VALUES (?, 'mirror', ?, ?, ?, ?, ?, 'queued', ?, ?, 1)", id, requestId, JSON.stringify(specs), current.id, MOVE_PRODUCT, JSON.stringify([GIT_CLIENT_LABEL]), now, now);
      this.c.event(id);
      const account = this.c.artifactsAccount();
      this.c.saveProject({ ...current, artifacts: { repo: name, namespace: client.namespace, remote: created.remote, status: 'pushing', accountId: account.accountId, source: account.source, sourceRepoUrl: current.hosted?.sourceRepoUrl ?? '', updatedAt: now, move: { jobId: id, tokenId: token.id, commit: tip, at: now } } });
      return json({ project: this.c.publicProject(this.c.anyProject(projectId)!, now), job: this.c.publicJob(this.c.job(id)) }, 201);
    });
    await this.c.schedule();
    return response;
  }
  // Restore to storage: a machine holding a current copy pushes it into a fresh Artifacts repository (the same job as a move,
  // sourced from the copy through the relay or the machine's own store).
  async restoreToStorage(userId: string, body: Record<string, unknown>): Promise<Response> {
    fields(body, ['projectId', 'requestId']);
    const projectId = string(body, 'projectId', 64);
    this.c.requireHuman(userId, true, true);
    const repo = this.c.hostedGit.repo(projectId); const project = this.c.anyProject(projectId);
    if (!isRepoProject(project) || project.home !== 'artifacts' || !repo || repo.state !== 'lost') fail(409, 'not_lost', 'Restore to storage is for a repository Smith’s storage lost');
    const holder = this.c.hostedGit.replicas(projectId).find(r => r.state === 'current' && r.generation === repo.generation && this.c.hostNodes().some(n => n.id === r.node_id && hostEligible(n, Date.now(), this.c.offlineMs())));
    if (!holder) fail(409, 'no_copy', 'No online machine holds a current copy of this repository');
    return await this.moveFromCopy(project, repo, string(body, 'requestId'), RESTORE_PRODUCT);
  }
```

`moveFromCopy` is the body of `moveToStorage` from `createRepo` down, parameterised by the product, so the two share it; `moveToStorage` calls it after its own checks. `settleMoves()` (called from `reconcileArtifactsHomes`) is `reconcileMirrors`'s shape for `artifacts.move`: when the job ended, `branchHead(repo, project.branch)` must equal `move.commit`; on success, in one transaction: `startArtifactsHome`/`artifactsReady` with the tips `fetchTips` returned (fetched before the transaction), `project.home = 'artifacts'`, `project.hosted = undefined`, `repoUrl` unchanged (already Smith's URL), `artifacts.status = 'done'`, `move` cleared; the old `git_repos` hosting row is replaced by the Artifacts one (`startArtifactsHome` deletes it) and the former primary's and replicas' `git_replicas` rows are kept with `state = 'stale'` so the planner refreshes them as copies; `promote`/backups no longer see a hosting row. On failure, `artifacts.status = 'failed'` with the message and `move` cleared, `home` untouched. The token is revoked either way.

Dispatch in `workspace.ts` beside `host-project`: `if (principal.kind === 'human' && action === 'move-to-storage') return await this.gitOps.moveToStorage(principal.userId, body);` and the same for `restore-to-storage`. Routes in `index.ts` beside `host`: `/^projects\/([a-z0-9][a-z0-9-]{0,63})\/move-to-storage$/` and `restore-to-storage`, each `fields(body, ['requestId'])`.

- [ ] **Step 6: Removal, the Smith-copy checks and sync tokens**

In `removeProject` (`workspace.ts`), before the transaction: `const artifacts = project.artifacts; const tokens = artifacts ? new ArtifactsTokens(this.sql).forProject(projectId) : [];` and after it: `if (artifacts) { const client = this.artifactsFor(artifacts.accountId); for (const t of tokens) { try { await client.revokeToken(artifacts.repo, t.tokenId); } catch { /* lapses */ } } try { await client.deleteRepo(artifacts.repo); } catch (error) { console.error(JSON.stringify({ event: 'artifacts_delete_failed', projectId })); } }`; inside the transaction delete the `artifacts_tokens` rows; the returned message becomes `Smith no longer lists ${projectId}.` with no Artifacts remark when the delete succeeded, or `…; its repository in Smith’s storage could not be deleted and may remain` when it threw.

`crew.ts`: `hasArtifactsCopy` becomes `project?.artifacts?.status === 'done' && (project.home === 'artifacts' || project.artifacts.remote === project.repoUrl)`. `sessions.ts`: `pushNeedsBuilder` is unchanged (Smith's URL contains `/git/`). `upstream.ts` `syncSpecs`: the `source`/`target` token for `copy.kind === 'artifacts'` is the job ticket as for hosted (`authToken: ''` on the source for a push, the ticket on the target for a pull); `startSync` in `workspace.ts` mints a write ticket through `this.gitOps.mintTicket(projectId, 'write', null, defaultRefPolicy(branch), 'pull', id)` for both kinds and drops the Artifacts-token branch; `pullToken` likewise uses tickets for both; `artifactsReadToken` keeps serving crew Verify builds (they clone through the proxy with a ticket from `attachHostedSource`, which now covers the `artifacts` state, so `readTokenFor`/`artifactsReadToken` return `''` for an Artifacts home).

- [ ] **Step 7: Run the tests**

Run: `npx vitest run test/home.test.ts test/smith-projects.test.ts test/crew-no-copy.test.ts test/upstream.test.ts test/pulls-hosted.test.ts test/crew-projects.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add cloudflare/coordinator/src cloudflare/coordinator/test
git commit --author="Claude Fable 5 <noreply@anthropic.com>" -m "feat(home): Artifacts is the home; Move and Restore to storage; removal deletes the repository

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: One budgeted copies layer with a pure planner

**Files:**
- Create: `cloudflare/coordinator/src/copies.ts`
- Modify: `cloudflare/coordinator/src/git-workspace.ts` (`reconcileGit` calls the planner; `planCopies` applies it; `hostSwitchedOff` also drops LFS copies)
- Modify: `cloudflare/coordinator/src/git-tasks.ts` (delete `planReplicas`; `finishHost`/`promote` callers use the planner), `cloudflare/coordinator/src/lfs-tasks.ts` (delete `plan`)
- Modify: `cloudflare/coordinator/src/workspace.ts` (`node-host` with `budgetBytes`, remove `node-lfs`, `nodes` fields `copyBudgetBytes`, `copyUsageBytes`, `copiesFull`; settings view `underReplicated`)
- Modify: `cloudflare/coordinator/src/index.ts` (`nodes/:id/host` accepts `budgetBytes`; `nodes/:id/lfs` removed)
- Test: `cloudflare/coordinator/test/copies.test.ts`, `cloudflare/coordinator/test/lfs-copies.test.ts`, `cloudflare/coordinator/test/git-host.test.ts`

**Interfaces:**
- Produces (pure, `copies.ts`):

```ts
export interface CopyNode { id: string; hostname: string; eligible: boolean; freeBytes: number; budgetBytes: number; usageBytes: number; gitBusy: boolean; lfsLeased: number }
export interface CopyItem { kind: 'repo' | 'lfs'; key: string; repoId: string; oid?: string; bytes: number; createdAt: number; copyable: boolean;
  holders: { nodeId: string; current: boolean; primary: boolean; heldAt: number }[]; pending: string[] }   // pending: node ids with a queued or leased fetch
export interface CopyPlanInput { nodes: CopyNode[]; items: CopyItem[]; copiesPerItem: number; reserveBytes: number; lfsTasksPerPoll: number; lfsPlanLimit: number }
export interface CopyPlan { fetches: { nodeId: string; item: CopyItem }[]; refreshes: { nodeId: string; item: CopyItem }[]; drops: { nodeId: string; item: CopyItem }[]; under: CopyItem[]; full: Record<string, 'budget' | 'reserve' | ''> }
export function repoCost(bytes: number): number   // 2 × bytes + 1 GiB, the margin a replicate needs (REPLICA_FREE_MARGIN)
export function itemCost(item: CopyItem): number  // repoCost for repositories, the size for large files
export function planCopies(input: CopyPlanInput): CopyPlan
```

`GitOps.planCopies(now): CopyPlan` builds the input from SQL and queues `replicate`/`fetch`/`discard`/`drop` tasks; `GitOps.nodeUsage(nodeId): number`; `GitOps.nodeBudget(node): number`; `GitOps.underReplicated(): { repos: number; lfs: number; fullHosts: string[] }` for Settings.

- [ ] **Step 1: Write the failing tests**

`test/copies.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { planCopies, repoCost, type CopyItem, type CopyNode } from '../src/copies';

const GiB = 1073741824;
const node = (id: string, over: Partial<CopyNode> = {}): CopyNode => ({ id, hostname: id.toUpperCase(), eligible: true, freeBytes: 400 * GiB, budgetBytes: 50 * GiB, usageBytes: 0, gitBusy: false, lfsLeased: 0, ...over });
const repo = (id: string, bytes: number, holders: CopyItem['holders'] = [], over: Partial<CopyItem> = {}): CopyItem => ({ kind: 'repo', key: id, repoId: id, bytes, createdAt: 1, copyable: true, holders, pending: [], ...over });
const lfs = (repoId: string, oid: string, bytes: number, holders: CopyItem['holders'] = []): CopyItem => ({ kind: 'lfs', key: `${repoId}/${oid}`, repoId, oid, bytes, createdAt: 2, copyable: true, holders, pending: [] });
const input = (nodes: CopyNode[], items: CopyItem[], over = {}) => ({ nodes, items, copiesPerItem: 2, reserveBytes: 10 * GiB, lfsTasksPerPoll: 4, lfsPlanLimit: 50, ...over });

describe('planCopies', () => {
  it('places each item on the machines with the most unused budget, up to the target, deterministically', () => {
    const plan = planCopies(input([node('a', { usageBytes: 30 * GiB }), node('b'), node('c', { usageBytes: 10 * GiB })], [repo('senet', GiB)]));
    expect(plan.fetches.map(f => f.nodeId)).toEqual(['b', 'c']);
    expect(plan.under).toEqual([]);
  });
  it('counts the free-disk reserve and the budget, and reports what is full', () => {
    const small = node('a', { freeBytes: 12 * GiB });            // 12 free − 3 cost < 10 reserve
    const tight = node('b', { budgetBytes: 2 * GiB });           // 3 cost > 2 budget
    const plan = planCopies(input([small, tight], [repo('senet', GiB)]));
    expect(plan.fetches).toEqual([]);
    expect(plan.under.map(i => i.key)).toEqual(['senet']);
    expect(plan.full).toEqual({ a: 'reserve', b: 'budget' });
  });
  it('refreshes stale copies before making new ones, and never asks a holder again', () => {
    const items = [repo('senet', GiB, [{ nodeId: 'a', current: false, primary: false, heldAt: 1 }])];
    const plan = planCopies(input([node('a'), node('b')], items));
    expect(plan.refreshes.map(r => r.nodeId)).toEqual(['a']);
    expect(plan.fetches.map(f => f.nodeId)).toEqual(['b']);
  });
  it('orders items by copies held, repositories before large files, oldest first', () => {
    const items = [lfs('senet', 'o1', 100, [{ nodeId: 'a', current: true, primary: false, heldAt: 1 }]), repo('late', 10, [], { createdAt: 9 }), repo('early', 10), lfs('senet', 'o2', 100)];
    const plan = planCopies(input([node('a'), node('b')], items));
    expect(plan.fetches.map(f => f.item.key + '@' + f.nodeId)).toEqual(['early@a', 'early@b', 'late@a', 'late@b', 'senet/o2@a', 'senet/o2@b', 'senet/o1@b']);
  });
  it('keeps the per-machine task limits: one git task, four large-file tasks, fifty new ones a pass', () => {
    const items = [repo('r1', 1), repo('r2', 1), ...Array.from({ length: 60 }, (_, i) => lfs('senet', 'o' + i, 1))];
    const plan = planCopies(input([node('a', { gitBusy: true }), node('b', { lfsLeased: 3 })], items, { copiesPerItem: 1 }));
    expect(plan.fetches.filter(f => f.item.kind === 'repo').map(f => f.nodeId)).toEqual(['b']);   // a is busy with a git task; one per pass
    expect(plan.fetches.filter(f => f.item.kind === 'lfs' && f.nodeId === 'b')).toHaveLength(1);     // 4 − 3 leased
    expect(plan.fetches.filter(f => f.item.kind === 'lfs' && f.nodeId === 'a')).toHaveLength(50);
  });
  it('sheds one item per pass from a machine over budget, newest copy first, never the primary or the last current copy', () => {
    const holders = (...ids: string[]) => ids.map((id, i) => ({ nodeId: id, current: true, primary: false, heldAt: i }));
    const over = node('a', { budgetBytes: GiB, usageBytes: 3 * GiB });
    const items = [repo('r1', 1, holders('a', 'b', 'c')), repo('r2', 1, [...holders('b', 'c'), { nodeId: 'a', current: true, primary: false, heldAt: 9 }]), repo('p', 1, [{ nodeId: 'a', current: true, primary: true, heldAt: 10 }, ...holders('b', 'c')])];
    const plan = planCopies(input([over, node('b'), node('c')], items));
    expect(plan.drops).toEqual([{ nodeId: 'a', item: items[1] }]);   // r2: newest on a, others still hold it; p is the primary
  });
  it('shedding stops at the last current copy', () => {
    const over = node('a', { budgetBytes: GiB, usageBytes: 3 * GiB });
    const items = [repo('r1', 1, [{ nodeId: 'a', current: true, primary: false, heldAt: 1 }, { nodeId: 'b', current: false, primary: false, heldAt: 2 }])];
    const plan = planCopies(input([over, node('b', { budgetBytes: 0 })], items));
    expect(plan.drops).toEqual([]);
    expect(plan.full.a).toBe('budget');
  });
  it('never copies an oversize repository and skips machines without a report', () => {
    const plan = planCopies(input([node('a', { freeBytes: 0 }), node('b')], [repo('big', 2 * GiB, [], { copyable: false }), repo('ok', 1)]));
    expect(plan.fetches.map(f => f.item.key + '@' + f.nodeId)).toEqual(['ok@b']);
    expect(plan.under.map(i => i.key)).toEqual(['ok']);   // one of two copies placed
  });
  it('repoCost is the replicate margin', () => { expect(repoCost(GiB)).toBe(3 * GiB); });
});
```

Update `test/lfs-copies.test.ts`: every `node-lfs` call becomes `node-host` with `{ nodeId, host: true }`; the test "within its reserve" keeps its expectations (the planner honours the reserve and, with the default 50 GiB budget and a 50 GiB free report, the budget); add:

```ts
it('a budget on the machine card caps what it holds, and the card says why it is full', async () => {
  const f = await setup(); const token = await f.pat();
  const bytes = new Uint8Array(3 * 1024 * 1024); const oid = await ready(f, token, bytes);
  const node = await f.node(); await beat(f, node, 500 * 1024 * 1024 * 1024);
  expect((await f.stub.execute(f.human, 'node-host', { nodeId: node.id, host: true, budgetBytes: 2 * 1024 * 1024 })).status).toBe(200);
  expect((await poll(f, node)).lfs).toEqual([]);   // 3 MB does not fit a 2 MB budget
  const shown = (await (await f.stub.execute(f.human, 'nodes', {})).json() as { nodes: { copyBudgetBytes: number | null; copiesFull: string }[] }).nodes[0];
  expect([shown.copyBudgetBytes, shown.copiesFull]).toEqual([2 * 1024 * 1024, 'budget']);
  expect((await f.stub.execute(f.human, 'node-host', { nodeId: node.id, host: true, budgetBytes: null })).status).toBe(200);
  expect((await poll(f, node)).lfs[0]).toMatchObject({ kind: 'fetch', oid });
});
```

In `test/git-host.test.ts`, the replication test ("every switched-on machine holds every repository") now expects two copies (the default `copiesPerItem`) when three machines are on, and a third machine to receive nothing; keep the failover tests (they promote among current copies).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/copies.test.ts test/lfs-copies.test.ts`
Expected: FAIL (module missing; `node-lfs` still the switch).

- [ ] **Step 3: The pure planner**

Create `src/copies.ts`:

```ts
// One budgeted copies layer (spec §4): which machine gets which repository or large-file copy. Pure: the workspace object
// builds the input from its tables and queues what comes back, so every rule here is tested without a Durable Object.
export interface CopyNode { id: string; hostname: string; eligible: boolean; freeBytes: number; budgetBytes: number; usageBytes: number; gitBusy: boolean; lfsLeased: number }
export interface CopyItem { kind: 'repo' | 'lfs'; key: string; repoId: string; oid?: string; bytes: number; createdAt: number; copyable: boolean; holders: { nodeId: string; current: boolean; primary: boolean; heldAt: number }[]; pending: string[] }
export interface CopyPlanInput { nodes: CopyNode[]; items: CopyItem[]; copiesPerItem: number; reserveBytes: number; lfsTasksPerPoll: number; lfsPlanLimit: number }
export interface CopyPlan { fetches: { nodeId: string; item: CopyItem }[]; refreshes: { nodeId: string; item: CopyItem }[]; drops: { nodeId: string; item: CopyItem }[]; under: CopyItem[]; full: Record<string, 'budget' | 'reserve' | ''> }

export function repoCost(bytes: number): number { return 2 * bytes + 1024 * 1024 * 1024; }
export function itemCost(item: CopyItem): number { return item.kind === 'repo' ? repoCost(item.bytes) : item.bytes; }
const held = (item: CopyItem) => item.holders.length + item.pending.length;
const byOrder = (a: CopyItem, b: CopyItem) => held(a) - held(b) || (a.kind === b.kind ? 0 : a.kind === 'repo' ? -1 : 1) || a.createdAt - b.createdAt || (a.key < b.key ? -1 : 1);

export function planCopies(input: CopyPlanInput): CopyPlan {
  const plan: CopyPlan = { fetches: [], refreshes: [], drops: [], under: [], full: {} };
  type Room = CopyNode & { unused: number; free: number; git: number; lfs: number; lfsNew: number; whyFull: 'budget' | 'reserve' | '' };
  const rooms = new Map<string, Room>();
  for (const n of input.nodes) rooms.set(n.id, { ...n, unused: n.budgetBytes - n.usageBytes, free: n.freeBytes, git: n.gitBusy ? 0 : 1, lfs: Math.max(0, input.lfsTasksPerPoll - n.lfsLeased), lfsNew: input.lfsPlanLimit, whyFull: '' });
  const fits = (room: Room, item: CopyItem): boolean => {
    const cost = itemCost(item);
    if (room.unused < cost) { room.whyFull = room.whyFull || 'budget'; return false; }
    if (room.free - cost < input.reserveBytes) { room.whyFull = room.whyFull || 'reserve'; return false; }
    return true;
  };
  const slot = (room: Room, item: CopyItem): boolean => item.kind === 'repo' ? room.git > 0 : room.lfs > 0 && room.lfsNew > 0;
  const take = (room: Room, item: CopyItem) => { const cost = itemCost(item); room.unused -= cost; room.free -= cost; if (item.kind === 'repo') room.git--; else { room.lfs--; room.lfsNew--; } };
  const candidates = (item: CopyItem) => [...rooms.values()].filter(r => r.eligible && r.freeBytes > 0 && !item.holders.some(h => h.nodeId === r.id) && !item.pending.includes(r.id)).sort((a, b) => b.unused - a.unused || (a.hostname < b.hostname ? -1 : 1));
  // Stale copies first: they already hold most of the bytes. A refresh is a replicate to the holder (no new room needed).
  for (const item of [...input.items].sort(byOrder)) {
    for (const holder of item.holders.filter(h => !h.current && !h.primary)) {
      const room = rooms.get(holder.nodeId);
      if (room && room.eligible && !item.pending.includes(holder.nodeId) && (item.kind === 'lfs' || room.git > 0)) { plan.refreshes.push({ nodeId: holder.nodeId, item }); if (item.kind === 'repo') room.git--; }
    }
  }
  for (const item of [...input.items].sort(byOrder)) {
    if (!item.copyable) continue;
    let missing = input.copiesPerItem - held(item);
    for (const room of candidates(item)) {
      if (missing <= 0) break;
      if (!slot(room, item)) continue;
      if (!fits(room, item)) continue;
      plan.fetches.push({ nodeId: room.id, item }); take(room, item); missing--;
    }
    if (missing > 0) plan.under.push(item);
  }
  // Shedding: a machine over budget drops its newest copy of an item that others still hold enough of (never a primary,
  // never the last current copy). One item per machine per pass; the next pass re-places it elsewhere.
  for (const room of rooms.values()) {
    if (room.budgetBytes - room.usageBytes >= 0) continue;
    room.whyFull = room.whyFull || 'budget';
    const mine = input.items.filter(i => i.holders.some(h => h.nodeId === room.id && !h.primary)).sort((a, b) => b.holders.find(h => h.nodeId === room.id)!.heldAt - a.holders.find(h => h.nodeId === room.id)!.heldAt);
    const victim = mine.find(i => { const others = i.holders.filter(h => h.nodeId !== room.id); return others.length >= input.copiesPerItem && others.some(h => h.current); });
    if (victim) plan.drops.push({ nodeId: room.id, item: victim });
  }
  for (const room of rooms.values()) if (room.eligible) plan.full[room.id] = room.whyFull;
  return plan;
}
```

- [ ] **Step 4: Wire the planner into the workspace object**

In `GitOps` (`git-workspace.ts`), replace the `reconcileGit` body's per-repo `planReplicas` and the `lfsTasks.plan` call with `this.planCopies(now)`, keeping `promote`, `planBackup`, `planRestore` for machines homes:

```ts
  nodeBudget(node: NodeRow): number { const v = this.c.settings().copyBudgetBytes; return node.copy_budget_bytes ?? (typeof v === 'number' ? v : DEFAULT_COPY_BUDGET_BYTES); }
  nodeUsage(nodeId: string): number {
    const repos = this.c.sql.exec<{ b: number | null }>("SELECT SUM(bytes) AS b FROM git_replicas WHERE node_id = ? AND state != 'lost'", nodeId).one().b ?? 0;
    const lfs = this.c.sql.exec<{ b: number | null }>('SELECT SUM(o.size) AS b FROM lfs_replicas r JOIN lfs_objects o ON o.repo_id = r.repo_id AND o.oid = r.oid WHERE r.node_id = ?', nodeId).one().b ?? 0;
    const queuedLfs = this.c.sql.exec<{ b: number | null }>("SELECT SUM(o.size) AS b FROM lfs_tasks t JOIN lfs_objects o ON o.repo_id = t.repo_id AND o.oid = t.oid WHERE t.node_id = ? AND t.kind = 'fetch' AND t.state IN ('queued', 'leased')", nodeId).one().b ?? 0;
    const queuedRepos = this.c.sql.exec<{ b: number | null }>("SELECT SUM(json_extract(payload, '$.bytes')) AS b FROM git_tasks WHERE node_id = ? AND kind = 'replicate' AND state IN ('queued', 'leased')", nodeId).one().b ?? 0;
    return repos + lfs + queuedLfs + queuedRepos;
  }
  planCopies(now: number): CopyPlan {
    const nodes = this.c.hostNodes(), offlineMs = this.c.offlineMs(), settings = this.c.settings(), lfs = new LfsStore(this.c.sql), tasks = this.tasks;
    const copyNodes: CopyNode[] = nodes.map(n => ({ id: n.id, hostname: n.hostname, eligible: hostEligible(n, now, offlineMs), freeBytes: nodeFreeBytes(n), budgetBytes: this.nodeBudget(n), usageBytes: this.nodeUsage(n.id),
      gitBusy: this.c.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM git_tasks WHERE node_id = ? AND state IN ('queued', 'leased')", n.id).one().n > 0,
      lfsLeased: this.c.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM lfs_tasks WHERE node_id = ? AND state = 'leased'", n.id).one().n }));
    const items: CopyItem[] = [];
    for (const repo of this.c.hostedGit.repos().filter(r => ['hosting', 'degraded', 'artifacts'].includes(r.state))) {
      const replicas = this.c.hostedGit.replicas(repo.id).filter(r => r.state !== 'lost');
      items.push({ kind: 'repo', key: repo.id, repoId: repo.id, bytes: repo.bytes, createdAt: repo.created_at, copyable: repo.bytes <= MAX_REPO_BYTES,
        holders: replicas.map(r => ({ nodeId: r.node_id, current: r.state === 'current' && r.generation === repo.generation, primary: r.node_id === repo.primary_node_id, heldAt: r.last_sync_at ?? 0 })),
        pending: this.c.sql.exec<{ node_id: string }>("SELECT node_id FROM git_tasks WHERE repo_id = ? AND kind = 'replicate' AND state IN ('queued', 'leased')", repo.id).toArray().map(r => r.node_id) });
    }
    for (const row of lfs.ready()) {
      items.push({ kind: 'lfs', key: `${row.repo_id}/${row.oid}`, repoId: row.repo_id, oid: row.oid, bytes: row.size, createdAt: row.created_at, copyable: true,
        holders: lfs.holders(row.repo_id, row.oid).map(id => ({ nodeId: id, current: true, primary: false, heldAt: 0 })),
        pending: this.c.sql.exec<{ node_id: string }>("SELECT node_id FROM lfs_tasks WHERE repo_id = ? AND oid = ? AND kind = 'fetch' AND state IN ('queued', 'leased')", row.repo_id, row.oid).toArray().map(r => r.node_id) });
    }
    const plan = planCopies({ nodes: copyNodes, items, copiesPerItem: typeof settings.copiesPerItem === 'number' ? settings.copiesPerItem : DEFAULT_COPIES_PER_ITEM, reserveBytes: this.reserveBytes(), lfsTasksPerPoll: LFS_TASKS_PER_POLL, lfsPlanLimit: LFS_PLAN_LIMIT });
    const replicate = (nodeId: string, repoId: string) => { const repo = this.c.hostedGit.repo(repoId)!; tasks.queue('replicate', repo, nodeId, { remote: smithRemote(this.c.env.ORIGIN, repo.id), defaultBranch: repo.default_branch, bytes: repo.bytes, recordTips: JSON.parse(repo.refs_json) as Tips }, now); };
    for (const f of [...plan.refreshes, ...plan.fetches]) { if (f.item.kind === 'repo') replicate(f.nodeId, f.item.repoId); else this.lfsTasks.queue('fetch', f.item.repoId, f.item.oid!, f.nodeId, now); }
    for (const d of plan.drops) {
      if (d.item.kind === 'repo') { const repo = this.c.hostedGit.repo(d.item.repoId)!; tasks.queue('discard', repo, d.nodeId, {}, now); this.c.sql.exec("UPDATE git_replicas SET state = 'lost' WHERE repo_id = ? AND node_id = ?", repo.id, d.nodeId); }
      else { this.lfsTasks.queue('drop', d.item.repoId, d.item.oid!, d.nodeId, now); lfs.forgetHeld(d.item.repoId, d.item.oid!, d.nodeId); }
    }
    // Restores of lost large files (spec §8 of the LFS design) stay as they were.
    for (const row of lfs.lostRows()) {
      if (this.lfsTasks.pendingRestore(row.repo_id, row.oid)) continue;
      const holder = lfs.holders(row.repo_id, row.oid).map(id => nodes.find(n => n.id === id)).find(n => n && n.active && n.last_seen_at > now - offlineMs);
      if (holder) this.lfsTasks.queue('restore', row.repo_id, row.oid, holder.id, now);
    }
    return plan;
  }
  underReplicated(now: number): { repos: number; lfs: number; fullHosts: string[] } {
    const plan = this.dryPlan(now);
    return { repos: plan.under.filter(i => i.kind === 'repo').length, lfs: plan.under.filter(i => i.kind === 'lfs').length, fullHosts: Object.entries(plan.full).filter(([, why]) => why).map(([id]) => this.c.hostNodes().find(n => n.id === id)?.hostname ?? id) };
  }
```

`dryPlan` is `planCopies` with the queueing replaced by nothing (factor the input building into `copyPlanInput(now)` and call `planCopies(input)` from both). `LfsTasks` gains `pendingRestore(repoId, oid)` (the former private `pending('restore', …, null)`) and loses `plan`; `LfsTasks.full(node, reserve, store)` is reimplemented from the plan: `full(nodeId, plan) { return plan.full[nodeId] || false }` and callers pass the dry plan. `GitTasks.planReplicas` is deleted; `finishHost` and `promote` callers call `this.planCopies(now)` instead; `tasks.dropNode` (switch-off) is followed by `this.lfsSwitchedOff(node, now)` inside `hostSwitchedOff` so one switch drops both kinds.

- [ ] **Step 5: The switch, the budget and the nodes view**

In `workspace.ts` `node-host`: `fields(body, ['nodeId', 'host', 'budgetBytes'])`; validate `budgetBytes` as `undefined | null | integer 1 GiB..10 TiB` (`fail(400, 'invalid_field', 'budgetBytes must be 1 GB to 10 TB, or null for the workspace default')`); `UPDATE nodes SET host_repos = ?, host_lfs = ?, copy_budget_bytes = COALESCE(?, copy_budget_bytes) ...` (with `null` passed explicitly when `body.budgetBytes === null` via a second statement `UPDATE nodes SET copy_budget_bytes = NULL`); answer `{ nodeId, hostRepos, copyBudgetBytes }`. Delete the `node-lfs` action and its route; `index.ts`'s `hostNode` route: `fields(body, ['host', 'budgetBytes'])`. In the `nodes` view replace `hostLfs`, `lfsFull` with `copyBudgetBytes: n.copy_budget_bytes, copyBudgetEffective: this.gitOps.nodeBudget(n), copyUsageBytes: this.gitOps.nodeUsage(n.id), copiesFull: plan.full[n.id] ?? ''` (compute `const plan = this.gitOps.dryPlan(now)` once before the map; keep `lfs: new LfsStore(this.sql).heldBy(n.id)` and `freeBytes`). In the public settings add `copies: this.gitOps.underReplicated(now)`. The admin action list drops `'node-lfs'`.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run test/copies.test.ts test/lfs-copies.test.ts test/git-host.test.ts test/linked-nodes.test.ts test/settings.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add cloudflare/coordinator/src cloudflare/coordinator/test
git commit --author="Claude Fable 5 <noreply@anthropic.com>" -m "feat(copies): one budgeted copies layer, placed by unused budget with a target per item

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: GitHub organisations, their repositories and the large-file preflight

**Files:**
- Modify: `cloudflare/coordinator/src/github-reader.ts`
- Modify: `cloudflare/coordinator/src/workspace.ts` (`githubPicker` handles `import-orgs` and `import-repos`)
- Modify: `cloudflare/coordinator/src/index.ts` (routes `GET imports/github/orgs`, `GET imports/github/repos?org=`)
- Test: `cloudflare/coordinator/test/github-org.test.ts`

**Interfaces:**
- Produces: `listGitHubOrgs(token): Promise<{ login: string; description: string }[]>`; `listOrgRepos(org, token): Promise<GitHubRepoChoice[]>` (adds `archived: boolean`, `sizeKb: number` to `GitHubRepoChoice`); `largeBlobsOnBranch(fullName, branch, token, thresholdBytes): Promise<{ count: number; largest: number; over32: number; truncated: boolean } | null>` (null when the tree could not be read); `githubLister(env)` gains `orgs`, `orgRepos`, `largeBlobs`; `fakeGitHub.orgs: Map<string, { repos: string[]; visibleTo?: string[] }>` and per-repo `sizes: Record<branch, Record<path, number>>`; actions `import-orgs {}` → `{ configured, via, orgs, installUrl }` and `import-repos { org }` → `{ configured, via, org, repos: (GitHubRepoChoice & { inSmith: string | null; large: {...} | null })[], totalKb }`.

- [ ] **Step 1: Write the failing tests**

`test/github-org.test.ts`:

```ts
import { env } from 'cloudflare:workers';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import worker from '../src/index';
import { fakeGitHub } from '../src/github-reader';
import { setup, origin } from './lfs-fixture';
import schema from '../migrations/0001_identity.sql?raw';
import browserSchema from '../migrations/0002_browser_auth.sql?raw';
import directorySchema from '../migrations/0003_workspace_directory.sql?raw';

beforeAll(async () => { await env.DB.exec(schema); await env.DB.exec(browserSchema); await env.DB.exec(directorySchema); });
beforeEach(() => fakeGitHub.reset());
const MiB = 1048576;
function seedOrg() {
  fakeGitHub.orgs.set('Red-Marmoset', { repos: ['Red-Marmoset/senet', 'Red-Marmoset/soccer-boy', 'Red-Marmoset/old-site'] });
  fakeGitHub.repos.set('Red-Marmoset/senet', { defaultBranch: 'master', branches: { master: { commit: 'a'.repeat(40), smithJson: null, paths: ['a.txt'], truncated: false } } });
  fakeGitHub.repos.set('Red-Marmoset/soccer-boy', { defaultBranch: 'main', branches: { main: { commit: 'b'.repeat(40), smithJson: null, paths: ['Assets/big.psd', 'Assets/huge.mp4'], truncated: false } }, sizes: { main: { 'Assets/big.psd': 15 * MiB, 'Assets/huge.mp4': 40 * MiB } }, sizeKb: 400000 });
  fakeGitHub.repos.set('Red-Marmoset/old-site', { defaultBranch: 'main', branches: { main: { commit: 'c'.repeat(40), smithJson: null, paths: [], truncated: true } }, archived: true });
}

describe('Import from GitHub listing', () => {
  it('lists the organisations and their repositories with sizes, archive flags, what is in Smith and the preflight', async () => {
    const f = await setup(); seedOrg();
    await f.stub.execute(f.human, 'put-settings', { githubToken: 'ghp_' + 'x'.repeat(30) });
    const orgs = await (await f.stub.execute(f.human, 'import-orgs', {})).json() as { configured: boolean; orgs: { login: string }[] };
    expect([orgs.configured, orgs.orgs.map(o => o.login)]).toEqual([true, ['Red-Marmoset']]);
    const listed = await (await f.stub.execute(f.human, 'import-repos', { org: 'Red-Marmoset', thresholdBytes: 10 * MiB })).json() as { repos: { fullName: string; archived: boolean; inSmith: string | null; large: { count: number; over32: number; truncated: boolean } | null }[]; totalKb: number };
    expect(listed.repos.map(r => [r.fullName, r.archived, r.inSmith, r.large])).toEqual([
      ['Red-Marmoset/senet', false, 'senet', { count: 0, largest: 0, over32: 0, truncated: false }],   // the fixture project's repoUrl
      ['Red-Marmoset/soccer-boy', false, null, { count: 2, largest: 40 * MiB, over32: 1, truncated: false }],
      ['Red-Marmoset/old-site', true, null, { count: 0, largest: 0, over32: 0, truncated: true }],
    ]);
    expect(listed.totalKb).toBe(400000);
  });
  it('says what to do when no token can see the organisation', async () => {
    const f = await setup(); seedOrg();
    const none = await (await f.stub.execute(f.human, 'import-orgs', {})).json() as { configured: boolean; reason: string };
    expect([none.configured, none.reason]).toEqual([false, 'link']);
    await f.stub.execute(f.human, 'put-settings', { githubToken: 'ghp_' + 'y'.repeat(30) });
    fakeGitHub.orgs.set('Red-Marmoset', { repos: ['Red-Marmoset/senet'], visibleTo: ['other-token'] });
    const refused = await f.stub.execute(f.human, 'import-repos', { org: 'Red-Marmoset', thresholdBytes: 10 * MiB });
    expect(refused.status).toBe(502);
    expect(((await refused.json()) as { error: { message: string } }).error.message).toContain('cannot see the organisation Red-Marmoset');
  });
  it('is reachable over the routes for admins only', async () => {
    const f = await setup(); seedOrg();
    const viewer = await f.pat(['read']);
    const response = await worker.fetch(new Request(`${origin}/api/v2/workspaces/${f.workspaceId}/imports/github/orgs`, { headers: { Authorization: `Bearer ${viewer}` } }), env);
    expect(response.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/github-org.test.ts`
Expected: FAIL (`fakeGitHub.orgs` undefined; actions unknown).

- [ ] **Step 3: The GitHub calls and their fakes**

In `src/github-reader.ts`, extend `GitHubRepoChoice` with `archived: boolean; sizeKb: number` (`choice()` reads `row.archived === true` and `Number(row.size ?? 0)`), then add:

```ts
export interface GitHubOrg { login: string; description: string }
export async function listGitHubOrgs(token: string, timeoutMs = 8000): Promise<GitHubOrg[]> {
  const signal = AbortSignal.timeout(timeoutMs);
  const rows = await pages(`${API}/user/orgs`, token, signal, 'organisations', body => (Array.isArray(body) ? body as { login?: unknown; description?: unknown }[] : []));
  return rows.filter(r => typeof r.login === 'string').map(r => ({ login: r.login as string, description: typeof r.description === 'string' ? r.description.slice(0, 200) : '' }));
}
// Every repository of an organisation the token can see, newest pushed first; up to ten pages (1,000 repositories).
export async function listOrgRepos(org: string, token: string, timeoutMs = 20000): Promise<GitHubRepoChoice[]> {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(org)) throw new GitHubReadError('Not a GitHub organisation name');
  const signal = AbortSignal.timeout(timeoutMs); const out: GitHubRepoChoice[] = [];
  for (let page = 1; page <= 10; page++) {
    const response = await fetch(`${API}/orgs/${encodeURIComponent(org)}/repos?type=all&sort=pushed&per_page=100&page=${page}`, { redirect: 'manual', signal, headers: headersFor(token) });
    if (response.status === 404) throw new GitHubReadError(`This GitHub token cannot see the organisation ${org}`);
    if (!response.ok) throw new GitHubReadError(`GitHub answered ${response.status} when listing ${org}`);
    const rows = await response.json() as RepoRow[];
    for (const row of rows) { const c = choice(row); if (c) out.push(c); }
    if (rows.length < 100) break;
  }
  return out;
}
// The preflight (spec §5): blobs over the threshold on the default branch, from the recursive tree (which carries sizes).
// Null when the tree could not be read; `truncated` when GitHub cut the listing short (history may hold more either way).
export async function largeBlobsOnBranch(fullName: string, branch: string, token: string, thresholdBytes: number, timeoutMs = 10000): Promise<{ count: number; largest: number; over32: number; truncated: boolean } | null> {
  const target = githubRepo('https://github.com/' + fullName); if (!target) return null;
  const signal = AbortSignal.timeout(timeoutMs); const base = `${API}/repos/${target.owner}/${target.repo}`;
  try {
    const head = await fetch(`${base}/commits/${encodeURIComponent(branch)}`, { redirect: 'manual', signal, headers: { ...headersFor(token), Accept: 'application/vnd.github.sha' } });
    if (!head.ok) return null;
    const tree = await fetch(`${base}/git/trees/${(await head.text()).trim()}?recursive=1`, { redirect: 'manual', signal, headers: headersFor(token) });
    if (!tree.ok) return null;
    const listing = await tree.json() as { tree?: { type?: unknown; size?: unknown }[]; truncated?: unknown };
    let count = 0, largest = 0, over32 = 0;
    for (const entry of listing.tree ?? []) {
      if (entry.type !== 'blob' || typeof entry.size !== 'number') continue;
      if (entry.size > thresholdBytes) count++; if (entry.size > 32 * 1048576) over32++; if (entry.size > largest) largest = entry.size;
    }
    return { count, largest, over32, truncated: listing.truncated === true };
  } catch { return null; }
}
```

Fakes: `fakeGitHub.orgs = new Map<string, { repos: string[]; visibleTo?: string[] }>()` (cleared in `reset`), repo entries gain optional `archived?: boolean; sizeKb?: number; sizes?: Record<string, Record<string, number>>`;

```ts
async function listFakeOrgs(token: string): Promise<GitHubOrg[]> { return [...fakeGitHub.orgs.entries()].filter(([, o]) => !o.visibleTo || o.visibleTo.includes(token)).map(([login]) => ({ login, description: '' })); }
async function listFakeOrgRepos(org: string, token: string): Promise<GitHubRepoChoice[]> {
  const found = fakeGitHub.orgs.get(org);
  if (!found || (found.visibleTo && !found.visibleTo.includes(token))) throw new GitHubReadError(`This GitHub token cannot see the organisation ${org}`);
  return found.repos.map(fullName => { const repo = fakeGitHub.repos.get(fullName)!; return { fullName, url: repo.private === false ? `https://github.com/${fullName}.git` : `git@github.com:${fullName}.git`, defaultBranch: repo.defaultBranch, private: repo.private !== false, pushedAt: '', description: '', archived: repo.archived === true, sizeKb: repo.sizeKb ?? 0 }; });
}
async function fakeLargeBlobs(fullName: string, branch: string, _token: string, threshold: number) {
  const repo = fakeGitHub.repos.get(fullName); const found = repo?.branches[branch]; if (!repo || !found) return null;
  const sizes = Object.values(repo.sizes?.[branch] ?? {});
  return { count: sizes.filter(s => s > threshold).length, largest: Math.max(0, ...sizes), over32: sizes.filter(s => s > 32 * 1048576).length, truncated: found.truncated };
}
```

`githubLister(env)` returns `{ repos, branches, orgs, orgRepos, largeBlobs }` from the real or fake set.

- [ ] **Step 4: The workspace actions**

In `workspace.ts`, route `import-orgs` and `import-repos` through `githubPicker` (dispatch line 573: add the two actions to the condition) and extend it:

```ts
      if (action === 'import-orgs') { fields(body, []); return json({ configured: true, via: own ? 'link' : 'settings', orgs: await lister.orgs(token), installUrl: this.installUrl() }); }
      if (action === 'import-repos') {
        fields(body, ['org', 'thresholdBytes']);
        const org = string(body, 'org', 39); const threshold = integer(body, 'thresholdBytes', 1048576, MAX_IMPORT_THRESHOLD_BYTES);
        const repos = await lister.orgRepos(org, token);
        const known = new Map<string, string>();   // repository URL (normalised) -> project id
        for (const p of this.allProjects()) for (const url of [p.repoUrl, p.artifacts?.sourceRepoUrl, p.hosted?.sourceRepoUrl, p.artifacts?.detachedFrom, p.hosted?.detachedFrom]) { const key = url && githubRepo(url); if (key) known.set(`${key.owner}/${key.repo}`.toLowerCase(), p.id); }
        // Preflight in batches of ten within a 25 s budget; a row that misses it says "could not check".
        const deadline = Date.now() + 25000; const large: (Awaited<ReturnType<typeof lister.largeBlobs>>)[] = [];
        for (let i = 0; i < repos.length; i += 10) {
          if (Date.now() > deadline) { large.push(...repos.slice(i).map(() => null)); break; }
          large.push(...await Promise.all(repos.slice(i, i + 10).map(r => lister.largeBlobs(r.fullName, r.defaultBranch, token, threshold))));
        }
        return json({ configured: true, via: own ? 'link' : 'settings', org, totalKb: repos.reduce((sum, r) => sum + r.sizeKb, 0), repos: repos.map((r, i) => ({ ...r, inSmith: known.get(r.fullName.toLowerCase()) ?? null, large: large[i] })) });
      }
```

(`integer` is imported from `./settings`.) The "cannot see" refusal is the existing `GitHubReadError` → 502 path. Routes in `index.ts` beside `github/repos`: `if (path === 'imports/github/orgs' && request.method === 'GET') return await stub.execute(principal, 'import-orgs', {});` and `if (path === 'imports/github/repos' && request.method === 'GET') return await stub.execute(principal, 'import-repos', { org: url.searchParams.get('org') ?? '', thresholdBytes: Number(url.searchParams.get('threshold') ?? DEFAULT_IMPORT_THRESHOLD_BYTES) });`. `githubPicker` already requires an admin (`requireHuman(userId, true, true)`), which the route test checks.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/github-org.test.ts test/github-picker.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add cloudflare/coordinator/src/github-reader.ts cloudflare/coordinator/src/workspace.ts cloudflare/coordinator/src/index.ts cloudflare/coordinator/test/github-org.test.ts
git commit --author="Claude Fable 5 <noreply@anthropic.com>" -m "feat(import): list a GitHub organisation's repositories with the large-file preflight

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: The import record, its jobs and their settlement

**Files:**
- Create: `cloudflare/coordinator/src/imports.ts`
- Modify: `cloudflare/coordinator/src/git-workspace.ts` (`startImport`, `reconcileImports`, `retryImport`, `cancelImport`)
- Modify: `cloudflare/coordinator/src/workspace.ts` (schema, dispatch, `attachImportTicket` at claim, `waitingReason` for import jobs, alarm)
- Modify: `cloudflare/coordinator/src/index.ts` (routes)
- Test: `cloudflare/coordinator/test/imports.test.ts`

**Interfaces:**
- Consumes: `ImportSpec`, `ImportReport` (Task 1), `startArtifactsHome`/`artifactsReady` (Task 3), `fetchTips` (Task 3), `ArtifactsClient.createRepo/issueToken/deleteRepo/branchHead/revokeToken`, `applyReport` (`repo-projects.ts`), `hostSpecs` (`git-host.ts`), `LfsStore.sweepRepos`, `planCopies` (Task 6).
- Produces:

```ts
export const IMPORT_SCHEMA: string;   // imports, import_repos (spec §5)
export const IMPORT_LABEL = 'smith-import'; export const IMPORT_PRODUCT = 'import-from-github';
export const IMPORT_RETRY_MS = [60000, 300000, 900000];
export type ImportState = 'running' | 'done' | 'cancelled'; export type ImportRepoState = 'queued' | 'running' | 'done' | 'machine' | 'failed' | 'cancelled';
export interface ImportRow { id; source: 'github'; org; created_by; threshold_bytes; link: number; state: ImportState; created_at; updated_at }
export interface ImportRepoRow { import_id; full_name; url; project_id; state: ImportRepoState; job_id: string | null; message; rewritten: number; moved_files; moved_bytes; attempts; updated_at }
export class Imports { constructor(sql); create(row); addRepo(row); get(id); list(); rows(importId); row(importId, fullName); rowByJob(jobId); setRow(importId, fullName, patch); finish(importId, state, now); publicImport(importId, jobs: (id) => JobRow | undefined, now) }
export function importSpecs(projectId, jobId, spec: ImportSpec): Record<string, ResolvedJobSpec>   // every OS, kind 'import', no repos, timeoutSeconds 4 h
export function validateImportReport(value: unknown): ImportReport
```

Actions: `import-start { org, repos: { fullName, url, defaultBranch }[], thresholdBytes, link }` (owner/admin) → `{ import }` 201; `imports {}` → `{ imports: [...] }` (read); `import-get { importId }`; `import-retry { importId, fullName? }`; `import-cancel { importId }`. Routes: `GET/POST imports`, `GET imports/:id`, `POST imports/:id/retry`, `POST imports/:id/cancel`. `JobRow.product` for import jobs is `IMPORT_PRODUCT`; `required_labels = [IMPORT_LABEL, LFS_LABEL]`. At claim, `attachImportTicket` issues a job-bound **write** ticket for the project and sets `spec.lfs = { url: smithRemote, authToken }`.

- [ ] **Step 1: Write the failing tests**

`test/imports.test.ts`:

```ts
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeGitHub } from '../src/github-reader';
import { fakeArtifacts } from '../src/artifacts-repos';
import { setup, origin, type Fixture } from './lfs-fixture';
import { IMPORT_LABEL, IMPORT_PRODUCT } from '../src/imports';
import schema from '../migrations/0001_identity.sql?raw';
import browserSchema from '../migrations/0002_browser_auth.sql?raw';
import directorySchema from '../migrations/0003_workspace_directory.sql?raw';

beforeAll(async () => { await env.DB.exec(schema); await env.DB.exec(browserSchema); await env.DB.exec(directorySchema); });
beforeEach(() => { fakeGitHub.reset(); fakeArtifacts.reset(); });
afterEach(() => vi.unstubAllGlobals());
const MiB = 1048576; const sha = (c: string) => c.repeat(40);
const pkt = (s: string) => (s.length + 4).toString(16).padStart(4, '0') + s;
type Lease = { jobId: string; attemptId: string; leaseToken: string; leaseExpiresAt: number; nodeId: string };
type Spec = { kind: string; projectId: string; import?: { source: string; artifactsRemote: string; artifactsToken: string; smithRemote: string; thresholdBytes: number; maxRepoBytes: number; originalBlob: string }; lfs?: { url: string; authToken: string } };
type Assignment = { hasJob: boolean; envelope: { lease: Lease; spec: Spec } };
type Shown = { id: string; state: string; org: string; repos: { fullName: string; projectId: string; state: string; message: string; rewritten: boolean; jobId: string | null }[] };
const repos = [{ fullName: 'Red-Marmoset/soccer-boy', url: 'git@github.com:Red-Marmoset/soccer-boy.git', defaultBranch: 'main' }, { fullName: 'Red-Marmoset/tools', url: 'git@github.com:Red-Marmoset/tools.git', defaultBranch: 'main' }];
// Artifacts' advertisement for the verification after a successful job.
function advertise(heads: Record<string, string>) {
  const real = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new Request(input, init).url;
    if (!url.includes('.artifacts.cloudflare.net/')) return real(input, init);
    return new Response(pkt('# service=git-upload-pack\n') + '0000' + Object.entries(heads).map(([ref, s]) => pkt(`${s} ${ref}\n`)).join('') + '0000', { headers: { 'Content-Type': 'application/x-git-upload-pack-advertisement' } });
  });
}
const start = (f: Fixture, over: Record<string, unknown> = {}) => f.stub.execute(f.human, 'import-start', { org: 'Red-Marmoset', repos, thresholdBytes: 10 * MiB, link: true, ...over });
const claim = async (f: Fixture, node: Awaited<ReturnType<Fixture['node']>>) => (await (await f.stub.execute(node, 'claim', {})).json()) as Assignment;
const shown = async (f: Fixture, id: string) => (await (await f.stub.execute(f.human, 'import-get', { importId: id })).json()) as Shown;
const report = (commit: string, over: Record<string, unknown> = {}) => ({ commit, branch: 'main', scan: { commit, branch: 'main', smithJson: null, paths: ['a.txt'], truncated: false }, rewritten: false, movedFiles: 0, movedBytes: 0, lfsObjects: 0, lfsBytes: 0, ...over });

describe('Import from GitHub', () => {
  it('creates a project, an Artifacts repository, a record row and one import job per repository', async () => {
    const f = await setup();
    const started = await start(f);
    expect(started.status).toBe(201);
    const view = (await started.json() as { import: Shown }).import;
    expect(view.repos.map(r => [r.fullName, r.projectId, r.state])).toEqual([['Red-Marmoset/soccer-boy', 'soccer-boy', 'queued'], ['Red-Marmoset/tools', 'tools', 'queued']]);
    expect([...fakeArtifacts.repos.keys()].sort()).toEqual([`${fakeArtifacts.account}/${f.workspaceId.slice(0, 12)}-soccer-boy`, `${fakeArtifacts.account}/${f.workspaceId.slice(0, 12)}-tools`]);
    const projects = (await (await f.stub.execute(f.human, 'projects', {})).json() as { projects: { id: string; kind: string; repoUrl: string; home?: string }[] }).projects;
    expect(projects.find(p => p.id === 'soccer-boy')).toMatchObject({ kind: 'repo', repoUrl: 'git@github.com:Red-Marmoset/soccer-boy.git' });   // the home switches on completion
    const jobs = (await (await f.stub.execute(f.human, 'list', {})).json() as { jobs: { kind: string; product: string; state: string }[] }).jobs.filter(j => j.kind === 'import');
    expect(jobs).toHaveLength(2); expect(jobs[0].product).toBe(IMPORT_PRODUCT);
  });
  it('only an updated agent with git-lfs takes the job, with the write token, the LFS ticket and the threshold', async () => {
    const f = await setup(); await start(f);
    const old = await f.node(['git-lfs']); const updated = await f.node(['git-lfs', IMPORT_LABEL]);
    expect((await claim(f, old)).hasJob).toBe(false);
    const assignment = await claim(f, updated);
    expect(assignment.hasJob).toBe(true);
    const spec = assignment.envelope.spec;
    expect(spec.kind).toBe('import');
    expect(spec.import).toMatchObject({ source: 'git@github.com:Red-Marmoset/soccer-boy.git', smithRemote: `${origin}/git/soccer-boy.git`, thresholdBytes: 10 * MiB, maxRepoBytes: 1073741824, originalBlob: 'original.bundle' });
    expect(spec.import!.artifactsRemote).toMatch(/\.artifacts\.cloudflare\.net\//);
    expect(spec.import!.artifactsToken).toMatch(/^art_v1_/);
    expect(spec.lfs).toMatchObject({ url: `${origin}/git/soccer-boy.git` }); expect(spec.lfs!.authToken).toMatch(/^smith_git_/);
    const waiting = (await (await f.stub.execute(f.human, 'list', {})).json() as { jobs: { kind: string; state: string; waiting?: string }[] }).jobs.find(j => j.kind === 'import' && j.state === 'queued')!;
    expect(waiting.waiting).toContain('git-lfs and an updated agent');
  });
  it('settles a success: Artifacts home behind Smith’s URL, actions from the report, linked to GitHub, copies planned', async () => {
    const f = await setup(); const { import: view } = await (await start(f)).json() as { import: Shown };
    const node = await f.node(['git-lfs', IMPORT_LABEL]);
    const assignment = await claim(f, node);
    fakeArtifacts.setHead(`${f.workspaceId.slice(0, 12)}-soccer-boy`, 'main', sha('a')); advertise({ 'refs/heads/main': sha('a'), 'refs/tags/v1': sha('b') });
    await f.stub.execute(node, 'complete', { ...assignment.envelope.lease, result: { status: 'success', exitCode: 0, durationMs: 1, message: 'Imported', commit: sha('a'), import: report(sha('a'), { lfsObjects: 2, lfsBytes: 30 * MiB }) } });
    await runInDurableObject(f.stub, async (instance: { reconcileImportsForTest: () => Promise<void> }) => { await instance.reconcileImportsForTest(); });
    const row = (await shown(f, view.id)).repos.find(r => r.fullName === 'Red-Marmoset/soccer-boy')!;
    expect([row.state, row.rewritten]).toEqual(['done', false]);
    const project = (await (await f.stub.execute(f.human, 'projects', {})).json() as { projects: { id: string; home?: string; repoUrl: string; branch: string; commit: string; artifacts?: { status: string; sourceRepoUrl: string; detachedFrom?: string } }[] }).projects.find(p => p.id === 'soccer-boy')!;
    expect([project.home, project.repoUrl, project.branch, project.commit, project.artifacts?.status, project.artifacts?.sourceRepoUrl, project.artifacts?.detachedFrom]).toEqual(['artifacts', `${origin}/git/soccer-boy.git`, 'main', sha('a'), 'done', 'git@github.com:Red-Marmoset/soccer-boy.git', undefined]);
    await runInDurableObject(f.stub, async (instance: { ctx: DurableObjectState }) => {
      expect(instance.ctx.storage.sql.exec<{ state: string; refs_json: string }>("SELECT state, refs_json FROM git_repos WHERE id = 'soccer-boy'").one()).toEqual({ state: 'artifacts', refs_json: JSON.stringify([[sha('a'), 'refs/heads/main'], [sha('b'), 'refs/tags/v1']]) });
    });
  });
  it('a rewritten repository is detached, with the counts and the original bundle on the card', async () => {
    const f = await setup(); const { import: view } = await (await start(f)).json() as { import: Shown };
    const node = await f.node(['git-lfs', IMPORT_LABEL]); const assignment = await claim(f, node);
    fakeArtifacts.setHead(`${f.workspaceId.slice(0, 12)}-soccer-boy`, 'main', sha('c')); advertise({ 'refs/heads/main': sha('c') });
    await f.stub.execute(node, 'complete', { ...assignment.envelope.lease, result: { status: 'success', exitCode: 0, durationMs: 1, message: '', commit: sha('c'), import: report(sha('c'), { rewritten: true, movedFiles: 37, movedBytes: 2100 * MiB, originalBundle: { size: 5 * MiB, sha256: 'd'.repeat(64) } }) } });
    await runInDurableObject(f.stub, async (instance: { reconcileImportsForTest: () => Promise<void> }) => { await instance.reconcileImportsForTest(); });
    const row = (await shown(f, view.id)).repos.find(r => r.fullName === 'Red-Marmoset/soccer-boy')!;
    expect([row.state, row.rewritten, row.message]).toEqual(['done', true, 'History rewritten on import: 37 files (2.1 GB) moved to large files; original history kept']);
    const project = (await (await f.stub.execute(f.human, 'projects', {})).json() as { projects: { id: string; artifacts?: { sourceRepoUrl: string; detachedFrom?: string } }[] }).projects.find(p => p.id === 'soccer-boy')!;
    expect([project.artifacts?.detachedFrom, project.artifacts?.sourceRepoUrl === `${origin}/git/soccer-boy.git`]).toEqual(['git@github.com:Red-Marmoset/soccer-boy.git', true]);
  });
  it('oversize goes to a machine: a host job, the Artifacts repository deleted, the row says why', async () => {
    const f = await setup(); const { import: view } = await (await start(f)).json() as { import: Shown };
    const node = await f.node(['git-lfs', IMPORT_LABEL]); const assignment = await claim(f, node);
    await f.stub.execute(node, 'complete', { ...assignment.envelope.lease, result: { status: 'failed', exitCode: 1, durationMs: 1, message: 'Repository is 1400 MiB, over the 1 GiB limit', failure: 'oversize' } });
    await runInDurableObject(f.stub, async (instance: { reconcileImportsForTest: () => Promise<void> }) => { await instance.reconcileImportsForTest(); });
    const row = (await shown(f, view.id)).repos.find(r => r.fullName === 'Red-Marmoset/soccer-boy')!;
    expect([row.state, row.message]).toEqual(['machine', 'On a build machine: over 1 GB, too large for Smith’s storage']);
    expect(fakeArtifacts.repos.has(`${fakeArtifacts.account}/${f.workspaceId.slice(0, 12)}-soccer-boy`)).toBe(false);
    const jobs = (await (await f.stub.execute(f.human, 'list', {})).json() as { jobs: { kind: string; projectId: string; state: string }[] }).jobs;
    expect(jobs.find(j => j.kind === 'host' && j.projectId === 'soccer-boy')?.state).toBe('queued');
  });
  it('retries transient failures three times, then waits for Retry, which reuses the project', async () => {
    const f = await setup(); const { import: view } = await (await start(f)).json() as { import: Shown };
    const node = await f.node(['git-lfs', IMPORT_LABEL]);
    for (let attempt = 1; attempt <= 3; attempt++) {
      const assignment = await claim(f, node);
      await f.stub.execute(node, 'complete', { ...assignment.envelope.lease, result: { status: 'failed', exitCode: 1, durationMs: 1, message: 'Could not resolve host github.com' } });
      await runInDurableObject(f.stub, async (instance: { reconcileImportsForTest: () => Promise<void>; advanceImportClockForTest: (ms: number) => void }) => { await instance.reconcileImportsForTest(); instance.advanceImportClockForTest(20 * 60000); });
    }
    const row = (await shown(f, view.id)).repos.find(r => r.fullName === 'Red-Marmoset/soccer-boy')!;
    expect([row.state, row.message]).toEqual(['failed', 'Could not resolve host github.com']);
    expect((await f.stub.execute(f.human, 'import-retry', { importId: view.id, fullName: 'Red-Marmoset/soccer-boy' })).status).toBe(200);
    const projects = (await (await f.stub.execute(f.human, 'projects', {})).json() as { projects: { id: string }[] }).projects.filter(p => p.id.startsWith('soccer-boy'));
    expect(projects).toHaveLength(1);
    expect((await shown(f, view.id)).repos.find(r => r.fullName === 'Red-Marmoset/soccer-boy')!.state).toBe('queued');
  });
  it('re-running lists only what is not in Smith, and cancel removes what never finished', async () => {
    const f = await setup(); const { import: view } = await (await start(f)).json() as { import: Shown };
    fakeGitHub.orgs.set('Red-Marmoset', { repos: ['Red-Marmoset/soccer-boy', 'Red-Marmoset/tools', 'Red-Marmoset/extra'] });
    for (const name of ['Red-Marmoset/soccer-boy', 'Red-Marmoset/tools', 'Red-Marmoset/extra']) fakeGitHub.repos.set(name, { defaultBranch: 'main', branches: { main: { commit: sha('a'), smithJson: null, paths: [], truncated: false } } });
    await f.stub.execute(f.human, 'put-settings', { githubToken: 'ghp_' + 'x'.repeat(30) });
    const listed = await (await f.stub.execute(f.human, 'import-repos', { org: 'Red-Marmoset', thresholdBytes: 10 * MiB })).json() as { repos: { fullName: string; inSmith: string | null }[] };
    expect(listed.repos.map(r => r.inSmith)).toEqual(['soccer-boy', 'tools', null]);
    expect((await start(f)).status).toBe(409);   // every ticked repository is already in Smith
    expect((await f.stub.execute(f.human, 'import-cancel', { importId: view.id })).status).toBe(200);
    expect((await (await f.stub.execute(f.human, 'projects', {})).json() as { projects: unknown[] }).projects.filter(p => (p as { id: string }).id !== 'senet')).toHaveLength(0);
    expect(fakeArtifacts.repos.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/imports.test.ts`
Expected: FAIL (`../src/imports` missing; actions unknown).

- [ ] **Step 3: The record module**

Create `src/imports.ts`:

```ts
// Import from GitHub (spec §5): an import's record and the jobs it runs. The organisation listing is github-reader.ts; the
// workspace object starts, settles, retries and cancels (git-workspace.ts); the agent does the work (HostedImport.cpp).
import { fail, fields, object, string } from './http';
import { smokeSpec, type ImportReport, type ImportSpec, type ResolvedJobSpec } from './contracts';
import { validateScanReport } from './repo-projects';
import { formatBytes } from './lfs';

export const IMPORT_SCHEMA = `
  CREATE TABLE IF NOT EXISTS imports (id TEXT PRIMARY KEY, source TEXT NOT NULL, org TEXT NOT NULL, created_by TEXT NOT NULL, threshold_bytes INTEGER NOT NULL, link INTEGER NOT NULL,
    state TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS import_repos (import_id TEXT NOT NULL, full_name TEXT NOT NULL, url TEXT NOT NULL, project_id TEXT NOT NULL, state TEXT NOT NULL, job_id TEXT,
    message TEXT NOT NULL DEFAULT '', rewritten INTEGER NOT NULL DEFAULT 0, moved_files INTEGER NOT NULL DEFAULT 0, moved_bytes INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, PRIMARY KEY (import_id, full_name));
  CREATE INDEX IF NOT EXISTS import_repos_job ON import_repos(job_id);
`;
export const IMPORT_LABEL = 'smith-import';
export const IMPORT_PRODUCT = 'import-from-github';
export const IMPORT_RETRY_MS = [60000, 300000, 900000];
export const IMPORT_TIMEOUT_SECONDS = 4 * 3600;
export const ORIGINAL_BLOB = 'original.bundle';
export type ImportState = 'running' | 'done' | 'cancelled';
export type ImportRepoState = 'queued' | 'running' | 'done' | 'machine' | 'failed' | 'cancelled';
export type ImportRow = { id: string; source: 'github'; org: string; created_by: string; threshold_bytes: number; link: number; state: ImportState; created_at: number; updated_at: number };
export type ImportRepoRow = { import_id: string; full_name: string; url: string; project_id: string; state: ImportRepoState; job_id: string | null; message: string; rewritten: number; moved_files: number; moved_bytes: number; attempts: number; next_attempt_at: number; updated_at: number };

export function rewrittenMessage(files: number, bytes: number): string { return `History rewritten on import: ${files} ${files === 1 ? 'file' : 'files'} (${formatBytes(bytes)}) moved to large files; original history kept`; }
export const OVERSIZE_MESSAGE = 'On a build machine: over 1 GB, too large for Smith’s storage';
export const WAITING_FOR_AGENT = (hosts: string[]) => `Waiting for a machine with git-lfs and an updated agent${hosts.length ? ` (update ${hosts.join(', ')})` : ''}`;

export function importSpecs(projectId: string, jobId: string, spec: ImportSpec): Record<string, ResolvedJobSpec> {
  const specs: Record<string, ResolvedJobSpec> = {};
  for (const os of ['windows', 'linux', 'mac']) specs[os] = { ...smokeSpec(jobId, os), kind: 'import', projectId, buildNumber: 0, timeoutSeconds: IMPORT_TIMEOUT_SECONDS, repos: [], import: spec };
  return specs;
}
export function validateImportReport(value: unknown): ImportReport {
  const r = object(value); fields(r, ['commit', 'branch', 'scan', 'rewritten', 'movedFiles', 'movedBytes', 'lfsObjects', 'lfsBytes', 'originalBundle']);
  const commit = string(r, 'commit', 40); if (!/^[a-f0-9]{40}$/.test(commit)) fail(400, 'invalid_field', 'commit must be a full SHA');
  const branch = string(r, 'branch', 256);
  const count = (key: string) => { const v = r[key]; if (!Number.isSafeInteger(v) || Number(v) < 0) fail(400, 'invalid_field', `${key} must be a count`); return Number(v); };
  let originalBundle: ImportReport['originalBundle'];
  if (r.originalBundle !== undefined) { const b = object(r.originalBundle); fields(b, ['size', 'sha256']); const sha256 = string(b, 'sha256', 64); if (!/^[a-f0-9]{64}$/.test(sha256)) fail(400, 'invalid_field', 'bad bundle digest'); originalBundle = { size: Number(b.size), sha256 }; if (!Number.isSafeInteger(originalBundle.size) || originalBundle.size < 1) fail(400, 'invalid_field', 'bad bundle size'); }
  return { commit, branch, scan: validateScanReport(r.scan), rewritten: r.rewritten === true, movedFiles: count('movedFiles'), movedBytes: count('movedBytes'), lfsObjects: count('lfsObjects'), lfsBytes: count('lfsBytes'), ...(originalBundle ? { originalBundle } : {}) };
}

export class Imports {
  constructor(private readonly sql: SqlStorage) {}
  create(row: Omit<ImportRow, 'updated_at'>): void { this.sql.exec('INSERT INTO imports (id, source, org, created_by, threshold_bytes, link, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', row.id, row.source, row.org, row.created_by, row.threshold_bytes, row.link, row.state, row.created_at, row.created_at); }
  addRepo(importId: string, fullName: string, url: string, projectId: string, jobId: string, now: number): void { this.sql.exec("INSERT INTO import_repos (import_id, full_name, url, project_id, state, job_id, attempts, updated_at) VALUES (?, ?, ?, ?, 'queued', ?, 1, ?)", importId, fullName, url, projectId, jobId, now); }
  get(id: string): ImportRow { return this.sql.exec<ImportRow>('SELECT * FROM imports WHERE id = ?', id).toArray()[0] ?? fail(404, 'not_found', 'Import not found'); }
  list(): ImportRow[] { return this.sql.exec<ImportRow>('SELECT * FROM imports ORDER BY created_at DESC LIMIT 20').toArray(); }
  rows(importId: string): ImportRepoRow[] { return this.sql.exec<ImportRepoRow>('SELECT * FROM import_repos WHERE import_id = ? ORDER BY full_name', importId).toArray(); }
  row(importId: string, fullName: string): ImportRepoRow { return this.sql.exec<ImportRepoRow>('SELECT * FROM import_repos WHERE import_id = ? AND full_name = ?', importId, fullName).toArray()[0] ?? fail(404, 'not_found', 'That repository is not part of this import'); }
  rowByJob(jobId: string): ImportRepoRow | undefined { return this.sql.exec<ImportRepoRow>('SELECT * FROM import_repos WHERE job_id = ?', jobId).toArray()[0]; }
  unsettled(): ImportRepoRow[] { return this.sql.exec<ImportRepoRow>("SELECT * FROM import_repos WHERE state IN ('queued', 'running')").toArray(); }
  setRow(importId: string, fullName: string, patch: Partial<Pick<ImportRepoRow, 'state' | 'job_id' | 'message' | 'rewritten' | 'moved_files' | 'moved_bytes' | 'attempts' | 'next_attempt_at'>>, now: number): void {
    const keys = Object.keys(patch) as (keyof typeof patch)[];
    this.sql.exec(`UPDATE import_repos SET ${keys.map(k => `${k} = ?`).join(', ')}${keys.length ? ', ' : ''}updated_at = ? WHERE import_id = ? AND full_name = ?`, ...keys.map(k => patch[k] as string | number | null), now, importId, fullName);
    const open = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM import_repos WHERE import_id = ? AND state IN ('queued', 'running')", importId).one().n;
    this.sql.exec("UPDATE imports SET state = CASE WHEN ? = 0 AND state = 'running' THEN 'done' ELSE state END, updated_at = ? WHERE id = ?", open, now, importId);
  }
  finish(importId: string, state: ImportState, now: number): void { this.sql.exec('UPDATE imports SET state = ?, updated_at = ? WHERE id = ?', state, now, importId); }
  publicImport(importId: string, jobState: (jobId: string) => string | undefined) {
    const row = this.get(importId); const repos = this.rows(importId);
    const count = (state: ImportRepoState) => repos.filter(r => r.state === state).length;
    return { id: row.id, org: row.org, state: row.state, thresholdBytes: row.threshold_bytes, link: Boolean(row.link), createdAt: row.created_at, updatedAt: row.updated_at,
      summary: { total: repos.length, done: count('done'), machine: count('machine'), failed: count('failed'), running: repos.filter(r => r.state === 'running' || (r.state === 'queued' && r.job_id && jobState(r.job_id) === 'running')).length, queued: count('queued') },
      repos: repos.map(r => ({ fullName: r.full_name, url: r.url, projectId: r.project_id, state: r.state, jobId: r.job_id, jobState: r.job_id ? jobState(r.job_id) ?? null : null, message: r.message, rewritten: Boolean(r.rewritten), movedFiles: r.moved_files, movedBytes: r.moved_bytes, attempts: r.attempts })) };
  }
}
```

- [ ] **Step 4: Start, settle, retry, cancel**

In `git-workspace.ts` (imports: `Imports, IMPORT_LABEL, IMPORT_PRODUCT, IMPORT_RETRY_MS, ORIGINAL_BLOB, OVERSIZE_MESSAGE, importSpecs, rewrittenMessage, validateImportReport` from `./imports`; `LFS_LABEL` from `./lfs`; `createRepoProject`, `applyReport`, `newProjectId`, `validateRepoUrl` from `./repo-projects`; `WRITE_TOKEN_TTL`, `repoNameFor` from `./artifacts-repos`; `hostSpecs`, `HOST_PRODUCT`, `GIT_HOST_LABEL`, `MAX_REPO_BYTES` from `./git-host`; `MAX_IMPORT_THRESHOLD_BYTES` from `./settings`):

```ts
  private get imports(): Imports { return new Imports(this.c.sql); }
  // Import from GitHub (spec §5): per ticked repository a project, an Artifacts repository with a write token (minted before
  // the transaction; deleted again if the transaction refuses), a record row and one import job.
  async startImport(userId: string, body: Record<string, unknown>): Promise<Response> {
    fields(body, ['org', 'repos', 'thresholdBytes', 'link']);
    this.c.requireHuman(userId, true, true);
    const org = string(body, 'org', 39); const link = body.link !== false;
    const threshold = integer(body, 'thresholdBytes', 1048576, MAX_IMPORT_THRESHOLD_BYTES);
    if (!Array.isArray(body.repos) || !body.repos.length || body.repos.length > 1000) fail(400, 'invalid_field', 'Tick 1 to 1,000 repositories');
    const wanted = body.repos.map(raw => { const r = object(raw); fields(r, ['fullName', 'url', 'defaultBranch']); return { fullName: string(r, 'fullName', 200), url: validateRepoUrl(string(r, 'url', 256)), defaultBranch: r.defaultBranch === undefined ? '' : string(r, 'defaultBranch', 256) }; });
    if (!await this.c.artifactsReady()) fail(503, 'artifacts_unconfigured', 'Smith’s storage is not set up; see Settings');
    const known = new Set(this.c.allProjects().flatMap(p => [p.repoUrl, p.artifacts?.sourceRepoUrl, p.hosted?.sourceRepoUrl, p.artifacts?.detachedFrom, p.hosted?.detachedFrom].filter((u): u is string => Boolean(u)).map(u => u.toLowerCase())));
    const fresh = wanted.filter(w => !known.has(w.url.toLowerCase()));
    if (!fresh.length) fail(409, 'already_in_smith', 'Every ticked repository is already in Smith');
    const free = 20 - this.c.projectSlotsUsed();
    if (fresh.length > free) fail(429, 'quota', `Only ${free} project ${free === 1 ? 'slot is' : 'slots are'} free; untick ${fresh.length - free}`);
    if (this.c.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM jobs').one().n + fresh.length > 1000) fail(429, 'quota', 'Experiment job quota reached');
    const client = this.c.artifacts(); const account = this.c.artifactsAccount(); const taken = new Set(this.c.projectIds());
    const prepared: { fullName: string; url: string; defaultBranch: string; projectId: string; repo: string; remote: string; token: { id: string; plaintext: string } }[] = [];
    try {
      for (const w of fresh) {
        const projectId = newProjectId(w.url, taken); taken.add(projectId);
        const repo = repoNameFor(this.c.workspaceId(), projectId);
        const created = await client.createRepo(repo, w.defaultBranch || 'main', `Smith import of ${w.fullName}`);
        const token = await client.issueToken(repo, 'write', WRITE_TOKEN_TTL);
        prepared.push({ ...w, projectId, repo, remote: created.remote, token });
      }
    } catch (error) { for (const p of prepared) { try { await client.deleteRepo(p.repo); } catch { /* best effort */ } } throw error; }
    let response: Response;
    try {
      response = this.c.storage.transactionSync(() => {
        const now = Date.now(); const importId = crypto.randomUUID();
        this.imports.create({ id: importId, source: 'github', org, created_by: userId, threshold_bytes: threshold, link: link ? 1 : 0, state: 'running', created_at: now });
        for (const p of prepared) {
          if (this.c.projectIds().has(p.projectId)) fail(409, 'project_exists', `A project ${p.projectId} was just added; try again`);
          const project = createRepoProject({ source: 'git', url: p.url, branch: p.defaultBranch }, this.c.projectIds(), now, userId);   // kind 'repo', scan 'waiting'
          this.c.insertProject({ ...project, id: p.projectId, artifacts: { repo: p.repo, namespace: client.namespace, remote: p.remote, status: 'pushing', accountId: account.accountId, source: account.source, sourceRepoUrl: p.url, tokenId: p.token.id, updatedAt: now } });
          this.c.hostedGit.startArtifactsHome(p.projectId, crypto.randomUUID(), p.remote, p.defaultBranch, now);
          const jobId = crypto.randomUUID();
          this.queueImportJob(importId, p, jobId, now);
        }
        return json({ import: this.imports.publicImport(importId, id => this.jobState(id)) }, 201);
      });
    } catch (error) { for (const p of prepared) { try { await client.deleteRepo(p.repo); } catch { /* best effort */ } } throw error; }
    await this.c.schedule();
    return response;
  }
  private jobState(jobId: string): string | undefined { return this.c.sql.exec<{ state: string }>('SELECT state FROM jobs WHERE id = ?', jobId).toArray()[0]?.state; }
  private queueImportJob(importId: string, p: { fullName: string; url: string; projectId: string; remote: string; token: { plaintext: string } }, jobId: string, now: number): void {
    const spec = { source: p.url, artifactsRemote: p.remote, artifactsToken: p.token.plaintext, smithRemote: smithRemote(this.c.env.ORIGIN, p.projectId), thresholdBytes: this.imports.get(importId).threshold_bytes, maxRepoBytes: MAX_REPO_BYTES, originalBlob: ORIGINAL_BLOB };
    this.c.sql.exec("INSERT INTO jobs (id, kind, request_id, specs, project_id, product, required_labels, state, created_at, updated_at, revision) VALUES (?, 'import', ?, ?, ?, ?, ?, 'queued', ?, ?, 1)", jobId, `import-${jobId}`, JSON.stringify(importSpecs(p.projectId, jobId, spec)), p.projectId, IMPORT_PRODUCT, JSON.stringify([IMPORT_LABEL, LFS_LABEL]), now, now);
    this.c.event(jobId);
    const existing = this.c.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM import_repos WHERE import_id = ? AND full_name = ?', importId, p.fullName).one().n;
    if (existing) this.imports.setRow(importId, p.fullName, { state: 'queued', job_id: jobId, message: '' }, now); else this.imports.addRepo(importId, p.fullName, p.url, p.projectId, jobId, now);
  }
```

Settlement, run from the alarm and after import jobs complete (`finishedImport` flag beside `finishedMirror` in `workspace.ts`'s completion handling):

```ts
  // Settle every import row whose job ended (spec §5). Success is confirmed against Artifacts (the default branch's head
  // equals the report's commit; a repository still importing on Artifacts answers 409 and is retried later).
  async reconcileImports(): Promise<boolean> {
    let retry = false;
    for (const row of this.imports.unsettled()) {
      const job = row.job_id ? this.c.sql.exec<JobRow>('SELECT * FROM jobs WHERE id = ?', row.job_id).toArray()[0] : undefined;
      if (!job) { this.c.storage.transactionSync(() => this.imports.setRow(row.import_id, row.full_name, { state: 'failed', message: 'The import job is gone' }, Date.now())); continue; }
      if (job.state === 'leased' || job.state === 'running') { if (row.state !== 'running') this.c.storage.transactionSync(() => this.imports.setRow(row.import_id, row.full_name, { state: 'running' }, Date.now())); continue; }
      if (job.state === 'queued') continue;
      const result = job.result ? JSON.parse(job.result) as JobResult : null;
      const project = this.c.anyProject(row.project_id);
      if (!isRepoProject(project) || !project.artifacts) { this.c.storage.transactionSync(() => this.imports.setRow(row.import_id, row.full_name, { state: 'failed', message: 'The project was removed' }, Date.now())); continue; }
      const client = this.c.artifacts(project.artifacts.accountId);
      if (job.state === 'success' && result?.import) {
        let report: ImportReport; try { report = validateImportReport(result.import); } catch (error) { this.failImportRow(row, `The machine's report could not be used: ${error instanceof Error ? error.message : 'bad report'}`, false); continue; }
        let head: string | null; let tips: Awaited<ReturnType<typeof fetchTips>>;
        try { head = await client.branchHead(project.artifacts.repo, report.branch); tips = await fetchTips(project.artifacts.remote, await this.c.artifactsToken(project.id, 'read')); }
        catch (error) { if (error instanceof HttpError && error.status === 409) { retry = true; continue; } console.error(JSON.stringify({ event: 'import_verify_failed', projectId: project.id })); retry = true; continue; }
        if (head !== report.commit) { this.failImportRow(row, head ? `Smith’s storage shows ${head.slice(0, 12)}, not the imported commit` : 'The branch did not arrive in Smith’s storage', false); continue; }
        if (project.artifacts.tokenId) { try { await client.revokeToken(project.artifacts.repo, project.artifacts.tokenId); } catch { /* lapses */ } }
        this.c.storage.transactionSync(() => {
          const now = Date.now(); const current = this.c.anyProject(row.project_id); const imported = this.imports.get(row.import_id);
          if (!isRepoProject(current) || !current.artifacts) return;
          const detach = report.rewritten || !imported.link;
          const artifacts = { ...current.artifacts, status: 'done' as const, tokenId: undefined, pushedCommit: report.commit, updatedAt: now, sourceRepoUrl: detach ? smithRemote(this.c.env.ORIGIN, current.id) : current.artifacts.sourceRepoUrl, ...(detach ? { detachedFrom: current.artifacts.sourceRepoUrl } : {}) };
          let saved: RepoProject = applyReport({ ...current, branch: report.branch, repoUrl: smithRemote(this.c.env.ORIGIN, current.id), home: 'artifacts', artifacts, scan: { ...current.scan, jobId: null } }, report.scan, 'machine', null, now);
          this.c.saveProject(saved);
          this.c.hostedGit.artifactsReady(current.id, tips.tips, tips.digest, tips.peeled, report.branch, 0, now);
          this.imports.setRow(row.import_id, row.full_name, { state: 'done', message: report.rewritten ? rewrittenMessage(report.movedFiles, report.movedBytes) : '', rewritten: report.rewritten ? 1 : 0, moved_files: report.movedFiles, moved_bytes: report.movedBytes }, now);
          this.c.hostedGit.audit(now, 'import', current.id, 'import', job.node_id ?? '', 0, report.rewritten ? 'imported, rewritten' : 'imported');
          this.planCopies(now);
        });
        continue;
      }
      if (result?.failure === 'oversize') {
        try { await client.deleteRepo(project.artifacts.repo); } catch { /* best effort */ }
        let swept: { repo_id: string; oid: string }[] = [];
        this.c.storage.transactionSync(() => {
          const now = Date.now(); const current = this.c.anyProject(row.project_id); if (!isRepoProject(current)) return;
          const uuid = crypto.randomUUID(), hostJobId = crypto.randomUUID();
          this.c.sql.exec('DELETE FROM git_repos WHERE id = ?', current.id);
          this.c.hostedGit.startHosting({ id: current.id, repoUrl: row.url, branch: current.branch, commit: '' }, hostJobId, uuid, now);
          this.c.sql.exec("INSERT INTO jobs (id, kind, request_id, specs, project_id, product, required_labels, state, created_at, updated_at, revision) VALUES (?, 'host', ?, ?, ?, ?, ?, 'queued', ?, ?, 1)", hostJobId, `host-${hostJobId}`, JSON.stringify(hostSpecs({ id: current.id, repoUrl: row.url, branch: current.branch, commit: '' }, hostJobId, uuid, current.branch)), current.id, HOST_PRODUCT, JSON.stringify([GIT_HOST_LABEL]), now, now);
          this.c.event(hostJobId);
          this.c.saveProject({ ...current, artifacts: undefined, hosted: { repoId: current.id, uuid, status: 'copying', sourceRepoUrl: row.url, jobId: hostJobId, updatedAt: now } });
          const lfs = new LfsStore(this.c.sql); swept = lfs.sweepRepos(id => id !== current.id);
          this.imports.setRow(row.import_id, row.full_name, { state: 'machine', message: OVERSIZE_MESSAGE }, now);
        });
        for (const s of swept) { try { await (this.c.env as { GIT?: R2Bucket }).GIT?.delete(lfsKey(this.c.workspaceId(), s.repo_id, s.oid)); } catch { /* sweep */ } }
        continue;
      }
      const message = result?.message || `The import ended as ${job.state}`;
      const transient = job.state === 'lost' || /could not resolve|timed out|connection|try again|busy|still being prepared/i.test(message);
      this.failImportRow(row, message, transient && result?.failure !== 'repo_access');
    }
    return retry;
  }
  private failImportRow(row: ImportRepoRow, message: string, transient: boolean): void {
    this.c.storage.transactionSync(() => {
      const now = Date.now(); const attempts = row.attempts;
      if (transient && attempts <= IMPORT_RETRY_MS.length) { this.imports.setRow(row.import_id, row.full_name, { state: 'queued', job_id: null, message, next_attempt_at: now + IMPORT_RETRY_MS[attempts - 1] }, now); return; }
      this.imports.setRow(row.import_id, row.full_name, { state: 'failed', message }, now);
    });
  }
```

Rows left `queued` with `job_id NULL` and `next_attempt_at` in the past are re-queued by `reconcileImports` (first loop: `if (!row.job_id) { if (row.next_attempt_at > Date.now()) continue; requeue; }` where `requeue` mints a fresh write token (the old one may have lapsed: `issueToken(repo, 'write', WRITE_TOKEN_TTL)` outside the transaction, stored in `artifacts.tokenId`) and calls `queueImportJob` with `attempts + 1`). `retryImport(userId, { importId, fullName? })` sets `next_attempt_at = 0`, `attempts = attempts + 1` on the named failed row (or every failed row) and runs the same requeue; it never creates a project (the row's `project_id` is reused). `cancelImport(userId, { importId })` cancels queued jobs of unsettled rows (`settleJob` semantics as `removeProject` does), deletes their projects, `git_repos` rows, Artifacts repositories (outside the transaction, after) and marks the rows `cancelled`, the import `cancelled`; finished rows stay. `jobs` of a cancelled import that are running are left to finish and then settle as failed with "The import was cancelled" (the row is already `cancelled`, so `reconcileImports` skips it).

In `workspace.ts`: `this.ctx.storage.sql.exec(IMPORT_SCHEMA)` in the constructor; dispatch `import-start`, `import-retry`, `import-cancel` (owner/admin via `requireHuman(…, true, true)` inside), `imports` and `import-get` (read; `fields(body, ['importId'])`); the alarm's retry array gains `await this.gitOps.reconcileImports()`; completion of an `import` job sets `finishedImport = true` and runs `await this.gitOps.reconcileImports()` where `finishedMirror` triggers `reconcileMirrors`; test hooks `reconcileImportsForTest()` and `advanceImportClockForTest(ms)` (the latter subtracts `ms` from every `import_repos.next_attempt_at`). At claim, after `attachLfsSource`: `this.gitOps.attachImportTicket(spec, job, node, claimTicket, now)`:

```ts
  attachImportTicket(spec: ResolvedJobSpec, job: JobRow, node: NodeRow, ticket: { token: string; hash: string } | undefined, now: number): void {
    if (!ticket || spec.kind !== 'import' || !spec.import) return;
    this.c.hostedGit.issueTicket(ticket.hash, spec.projectId, 'write', { nodeId: node.id, jobId: job.id, ttlMs: ((spec.timeoutSeconds || 3600) + 600) * 1000, label: 'import' }, now);
    spec.lfs = { url: spec.import.smithRemote, authToken: ticket.token };
  }
```

`waitingReason(job, now)` (the queued-build explanation): for `job.kind === 'import'` when no online machine advertises both labels, answer `WAITING_FOR_AGENT(hosts)` with the online build machines lacking `smith-import`. Routes in `index.ts`: `if (path === 'imports') return await stub.execute(principal, request.method === 'GET' ? 'imports' : 'import-start', body);` `const importOne = /^imports\/([a-f0-9-]{36})(?:\/(retry|cancel))?$/.exec(path); if (importOne && request.method === 'GET' && !importOne[2]) return await stub.execute(principal, 'import-get', { importId: importOne[1] }); if (importOne && request.method === 'POST' && importOne[2]) { fields(body, importOne[2] === 'retry' ? ['fullName'] : []); return await stub.execute(principal, `import-${importOne[2]}`, { ...body, importId: importOne[1] }); }`. Add `'imports', 'import-get'` to the read-only action list.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/imports.test.ts test/github-org.test.ts test/scheduler.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add cloudflare/coordinator/src cloudflare/coordinator/test
git commit --author="Claude Fable 5 <noreply@anthropic.com>" -m "feat(import): the import record, one job per repository, settlement, retry and cancel

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: The job blob route and the backup download

**Files:**
- Create: `cloudflare/coordinator/src/job-blob-route.ts`
- Modify: `cloudflare/coordinator/src/workspace.ts` (actions `job-blob-upload`, `job-blob-part`, `job-blob-finish`, `backup-download`; `git_backups` kind `original`), `cloudflare/coordinator/src/git-tasks.ts` (`BackupRow.kind` gains `'original'`; `retainBackups` ignores originals; `publicBackups` lists them), `cloudflare/coordinator/src/index.ts`
- Test: `cloudflare/coordinator/test/job-blobs.test.ts`

**Interfaces:**
- Produces: node routes `POST /api/v2/workspaces/:ws/jobs/:id/blobs/:name?part=N` (lease in `X-Smith-Lease-Token`, part bodies at most 5 MiB + 1 KiB) and `POST …/jobs/:id/blobs/:name/complete { size, sha256 }`; the key `backups/<ws>/<repoUuid>/original-<jobId>.bundle`; a `git_backups` row `kind = 'original'`, `ready = 1` with `size`, `sha256`, `tips_json = '[]'`; human route `GET /api/v2/workspaces/:ws/projects/:id/backups/:backupId` (owner/admin) streaming the bundle; `publicBackups` gains `originals: { id; size; createdAt }[]`.

- [ ] **Step 1: Write the failing tests**

`test/job-blobs.test.ts`:

```ts
import { env } from 'cloudflare:workers';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import worker from '../src/index';
import { fakeArtifacts } from '../src/artifacts-repos';
import { setup, origin, type Fixture } from './lfs-fixture';
import { IMPORT_LABEL } from '../src/imports';
import schema from '../migrations/0001_identity.sql?raw';
import browserSchema from '../migrations/0002_browser_auth.sql?raw';
import directorySchema from '../migrations/0003_workspace_directory.sql?raw';

beforeAll(async () => { await env.DB.exec(schema); await env.DB.exec(browserSchema); await env.DB.exec(directorySchema); });
beforeEach(() => fakeArtifacts.reset());
const bucket = (env as unknown as { GIT: R2Bucket }).GIT;
async function sha256(bytes: Uint8Array) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join(''); }
async function importJob(f: Fixture) {
  await f.stub.execute(f.human, 'import-start', { org: 'Red-Marmoset', repos: [{ fullName: 'Red-Marmoset/tools', url: 'git@github.com:Red-Marmoset/tools.git', defaultBranch: 'main' }], thresholdBytes: 10485760, link: true });
  const node = await f.node(['git-lfs', IMPORT_LABEL]);
  const assignment = await (await f.stub.execute(node, 'claim', {})).json() as { envelope: { lease: { jobId: string; leaseToken: string } } };
  return { node, lease: assignment.envelope.lease };
}
const blob = (f: Fixture, node: { token: string }, jobId: string, lease: string, path: string, init: RequestInit) =>
  worker.fetch(new Request(`${origin}/api/v2/workspaces/${f.workspaceId}/jobs/${jobId}/blobs/${path}`, { ...init, headers: { Authorization: `Bearer ${node.token}`, 'X-Smith-Lease-Token': lease, ...(init.headers ?? {}) } }), env);

describe('job blobs', () => {
  it('takes the original bundle in parts under the job lease, checks size and digest, and lists it as an original backup', async () => {
    const f = await setup(); const { node, lease } = await importJob(f);
    const part1 = new Uint8Array(5 * 1024 * 1024).fill(1), part2 = new Uint8Array(1000).fill(2);
    const whole = new Uint8Array(part1.byteLength + part2.byteLength); whole.set(part1); whole.set(part2, part1.byteLength);
    for (const [n, bytes] of [[1, part1], [2, part2]] as const) {
      const r = await blob(f, node, lease.jobId, lease.leaseToken, `original.bundle?part=${n}`, { method: 'POST', body: bytes, headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.byteLength) } });
      expect([r.status, await r.json()]).toEqual([200, { accepted: true, part: n, size: bytes.byteLength }]);
    }
    const wrong = await blob(f, node, lease.jobId, lease.leaseToken, 'original.bundle/complete', { method: 'POST', body: JSON.stringify({ size: whole.byteLength, sha256: 'e'.repeat(64) }), headers: { 'Content-Type': 'application/json' } });
    expect(wrong.status).toBe(400);
    const done = await blob(f, node, lease.jobId, lease.leaseToken, 'original.bundle/complete', { method: 'POST', body: JSON.stringify({ size: whole.byteLength, sha256: await sha256(whole) }), headers: { 'Content-Type': 'application/json' } });
    expect(done.status).toBe(200);
    const { key } = await done.json() as { key: string };
    expect(key).toMatch(new RegExp(`^backups/${f.workspaceId}/[a-f0-9-]{36}/original-${lease.jobId}\\.bundle$`));
    expect((await bucket.head(key))?.size).toBe(whole.byteLength);
    const stale = await blob(f, node, lease.jobId, 'not-the-lease', 'original.bundle?part=3', { method: 'POST', body: part2, headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': '1000' } });
    expect(stale.status).toBe(409);
    const shown = (await (await f.stub.execute(f.human, 'projects', {})).json() as { projects: { id: string; hosted?: { backups?: { originals: { id: string; size: number }[] } } }[] }).projects.find(p => p.id === 'tools')!;
    expect(shown.hosted?.backups?.originals).toEqual([{ id: expect.any(String), size: whole.byteLength, createdAt: expect.any(Number) }]);
    const id = shown.hosted!.backups!.originals[0].id;
    const viewer = await f.pat(['read']);
    const refused = await worker.fetch(new Request(`${origin}/api/v2/workspaces/${f.workspaceId}/projects/tools/backups/${id}`, { headers: { Authorization: `Bearer ${viewer}` } }), env);
    expect(refused.status).toBe(403);
    const admin = await f.pat(['read', 'build']);   // the fixture's human is the owner; a token carries its scopes, backup download needs admin: use the human through the DO
    void admin;
    const download = await f.stub.execute(f.human, 'backup-download', { projectId: 'tools', backupId: id });
    expect(download.status).toBe(200);
    expect((await download.json() as { key: string; size: number }).size).toBe(whole.byteLength);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/job-blobs.test.ts`
Expected: FAIL (404 route not found).

- [ ] **Step 3: The route and actions**

Create `src/job-blob-route.ts`, modelled on `git-task-route.ts`:

```ts
// A job's one named blob (today: an import's original-history bundle), uploaded in 5 MiB parts under the job's lease and
// completed with its size and SHA-256. The workspace object chooses the key and records a git_backups row of kind 'original'.
import { fail, json, readBody, HttpError } from './http';
import { nodeAction as linkedNodeAction, routedLeaseToken } from './linked-nodes';
import { hex } from './r2-store';

const JOB_BLOB = /^\/api\/v2\/workspaces\/([a-f0-9]{64})\/jobs\/([a-f0-9-]{36})\/blobs\/([a-z0-9][a-z0-9.-]{0,63})(\/complete)?$/;
const PART_SIZE = 5 * 1024 * 1024;
function bearer(request: Request): string { const h = request.headers.get('Authorization') ?? ''; return h.startsWith('Bearer ') && h.length < 512 ? h.slice(7) : ''; }
export async function handleJobBlob(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url); const match = JOB_BLOB.exec(url.pathname);
  if (!match) return null;
  const [, workspaceId, jobId, name, completing] = match;
  const leaseHeader = request.headers.get('X-Smith-Lease-Token') ?? ''; const routed = routedLeaseToken(leaseHeader);
  const act = (action: string, body: Record<string, unknown>) => linkedNodeAction(env, workspaceId, bearer(request), action, { ...body, jobId, name, leaseToken: routed ? leaseHeader : leaseHeader });
  const bucket = (env as { GIT?: R2Bucket }).GIT;
  try {
    if (request.method !== 'POST') fail(405, 'method', 'POST the part or the completion');
    if (!bucket) fail(503, 'no_bucket', 'This coordinator has no repository bucket');
    if (!completing) {
      const part = Number(url.searchParams.get('part') ?? '0');
      if (!Number.isSafeInteger(part) || part < 1 || part > 10000) fail(400, 'invalid_part', 'part must be 1 to 10000');
      const length = Number(request.headers.get('Content-Length') ?? 'x');
      if (!Number.isSafeInteger(length) || length < 1 || length > PART_SIZE + 1024) fail(413, 'part_too_large', 'Parts are at most 5 MiB');
      const granted = await act('job-blob-part', { part }); if (!granted.ok) return granted;
      const grant = await granted.json() as { key: string; uploadId: string | null };
      let { uploadId } = grant;
      if (!uploadId) {
        const upload = await bucket.createMultipartUpload(grant.key);
        const recorded = await act('job-blob-upload', { uploadId: upload.uploadId });
        if (!recorded.ok) { try { await upload.abort(); } catch { /* lifecycle */ } return recorded; }
        uploadId = upload.uploadId;
      }
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (bytes.byteLength !== length) fail(400, 'length_mismatch', 'The part is not as long as Content-Length says');
      const uploaded = await bucket.resumeMultipartUpload(grant.key, uploadId).uploadPart(part, bytes);
      const noted = await act('job-blob-part-done', { part, etag: uploaded.etag, size: bytes.byteLength }); if (!noted.ok) return noted;
      return json({ accepted: true, part, size: bytes.byteLength });
    }
    const body = await readBody(request, 4096);
    const size = Number(body.size), sha256 = String(body.sha256 ?? '');
    if (!Number.isSafeInteger(size) || size < 1 || !/^[a-f0-9]{64}$/.test(sha256)) fail(400, 'invalid_field', 'size and sha256 are required');
    const finish = await act('job-blob-finish', {}); if (!finish.ok) return finish;
    const view = await finish.json() as { key: string; uploadId: string | null; parts: { part: number; etag: string; size: number }[] };
    if (!view.uploadId || !view.parts.length) fail(409, 'no_parts', 'Upload the bundle before completing');
    const upload = bucket.resumeMultipartUpload(view.key, view.uploadId);
    try { await upload.complete(view.parts.map(p => ({ partNumber: p.part, etag: p.etag }))); } catch { /* a replayed completion already finished it */ }
    const object = await bucket.get(view.key);
    if (!object) fail(409, 'no_object', 'The bundle is not in the bucket');
    if (object.size !== size) fail(400, 'size_mismatch', `Stored ${object.size} bytes but the completion declares ${size}`);
    const digest = new crypto.DigestStream('SHA-256'); await object.body.pipeTo(digest);
    if (hex(await digest.digest) !== sha256) { await bucket.delete(view.key); fail(400, 'digest_mismatch', 'The stored bundle does not match the declared SHA-256'); }
    const recorded = await act('job-blob-complete', { size, sha256 }); if (!recorded.ok) return recorded;
    return json({ accepted: true, key: view.key, size });
  } catch (error) {
    if (error instanceof HttpError) return json({ error: { code: error.code, message: error.message } }, error.status);
    console.error(JSON.stringify({ event: 'job_blob_failed', type: error instanceof Error ? error.name : 'unknown' }));
    return json({ error: { code: 'internal_error', message: 'Request failed' } }, 500);
  }
}
```

In `index.ts`, beside `handleNodeLfsTask`: `const jobBlob = await handleJobBlob(request, env); if (jobBlob) return jobBlob;`. Workspace actions (node principal, inside the transaction, with a small table `job_blobs(job_id, name, key, upload_id, parts, size, sha256, done, created_at, PRIMARY KEY (job_id, name))` added to `IMPORT_SCHEMA`): `job-blob-part` checks the job's lease (`job.node_id === node.id && job.lease_token === leaseToken && state in leased/running`), that the job is an `import` whose project has a `git_repos` row, and answers `{ key: backupKey(ws, repo.uuid, 'original-' + job.id), uploadId }` creating the `job_blobs` row on first use; `job-blob-upload` stores the upload id; `job-blob-part-done` appends the part (sorted, deduplicated as `GitTasks.addPart` does); `job-blob-finish` answers `{ key, uploadId, parts }`; `job-blob-complete` inserts `git_backups (id, repo_id, kind 'original', key, size, sha256, tips_json '[]', ready 1, created_at)` and marks the blob done. `backup-download { projectId, backupId }` (human, owner/admin) answers `{ key, size, name: 'original-history.bundle' }` for a backup row of that project; the human route `GET projects/:id/backups/:backupId` calls it and streams `env.GIT.get(key)` with `Content-Type: application/octet-stream`, `Content-Disposition: attachment; filename="<project>-original-history.bundle"`, `Cache-Control: private, no-store`. In `git-tasks.ts`, `BackupRow.kind` becomes `'full' | 'incremental' | 'original'`; `retainBackups` and `restoreChain` filter `kind !== 'original'` first; `publicBackups` adds `originals: this.backups(repoId).filter(b => b.kind === 'original' && b.ready).map(b => ({ id: b.id, size: b.size, createdAt: b.created_at }))` and counts original bytes in `bytes` so the card's budget warning sees them; `deleteRepo` (project removal) already returns every backup key for deletion.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/job-blobs.test.ts test/git-host.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cloudflare/coordinator/src/job-blob-route.ts cloudflare/coordinator/src/workspace.ts cloudflare/coordinator/src/git-tasks.ts cloudflare/coordinator/src/imports.ts cloudflare/coordinator/src/index.ts cloudflare/coordinator/test/job-blobs.test.ts
git commit --author="Claude Fable 5 <noreply@anthropic.com>" -m "feat(import): the original-history bundle as a job blob, kept as an original backup with a download

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Dashboard: the home line, the Copies block, Settings → Copies, one Clone dialog

**Files:**
- Create: `cloudflare/coordinator/public/copies.js`
- Modify: `cloudflare/coordinator/public/app.js` (`copyRow`, `openCloneDialog`, `renderMachineHosting`, remove `renderMachineLfs` and `openArtifactsClone`, `renderWorkspaceSettings`, the settings submit), `cloudflare/coordinator/public/index.html` (the Large files block becomes Copies; the clone dialog's Artifacts paragraph goes), `cloudflare/coordinator/public/lfs.js` (`lfsMachineText` reads `copiesFull`), `cloudflare/coordinator/public/repo-projects.js` (`copyOf` reads `home`)
- Test: `cloudflare/coordinator/test/copies-dashboard.test.js`, `cloudflare/coordinator/test/lfs-dashboard.test.js`

**Interfaces:**
- Consumes: node fields `copyBudgetBytes`, `copyBudgetEffective`, `copyUsageBytes`, `copiesFull`, `hosted[]`, `lfs` (Task 6); project fields `home`, `hosted.backups.originals` (Tasks 5, 9); settings `copies: { repos, lfs, fullHosts }`, `copyBudgetBytes`, `copiesPerItem`, `lfsImportThresholdBytes`; routes `nodes/:id/host { host, budgetBytes }`, `projects/:id/move-to-storage`, `projects/:id/restore-to-storage`, `projects/:id/backups/:id`.
- Produces (pure, `copies.js`): `copiesUsageText(machine)` → `"uses 12 GB of 50 GB: 8 repositories, 340 large files · 412 GB free"`; `copiesFullText(machine)` → `"full: budget reached"` / `"full: reserve reached"` / `''`; `homeText(project, holders)` → `"In Smith’s storage · copies on DESKTOP-SEM, MAC-MINI (2 of 2)"` or `"On DESKTOP-SEM (primary) · copies on MAC-MINI (1 of 2): no machine has room"`; `underReplicatedText(copies, target)` → `"3 repositories and 12 large files have fewer than 2 copies; full: MAC-MINI"`.

- [ ] **Step 1: Write the failing tests**

`test/copies-dashboard.test.js`:

```js
import { it, expect } from 'vitest';
import { copiesUsageText, copiesFullText, homeText, underReplicatedText } from '../public/copies.js';

const GB = 1073741824;
it('says what a machine keeps against its budget', () => {
  const machine = { copyBudgetEffective: 50 * GB, copyUsageBytes: 12 * GB, freeBytes: 412 * GB, hosted: Array(8).fill({ repoId: 'x', state: 'current', bytes: 1 }), lfs: { objects: 340, bytes: 1 } };
  expect(copiesUsageText(machine)).toBe('uses 12 GB of 50 GB: 8 repositories, 340 large files · 412 GB free');
  expect(copiesUsageText({ ...machine, hosted: [], lfs: { objects: 0, bytes: 0 }, copyUsageBytes: 0 })).toBe('uses 0 B of 50 GB: nothing yet · 412 GB free');
  expect(copiesFullText({ copiesFull: 'budget' })).toBe('full: budget reached');
  expect(copiesFullText({ copiesFull: 'reserve' })).toBe('full: reserve reached');
  expect(copiesFullText({ copiesFull: '' })).toBe('');
});
it('says where a project lives and how many copies it has', () => {
  const copies = [{ host: 'DESKTOP-SEM', primary: false, state: 'current' }, { host: 'MAC-MINI', primary: false, state: 'current' }];
  expect(homeText({ home: 'artifacts', hosted: { copies } }, 2)).toBe('In Smith’s storage · copies on DESKTOP-SEM, MAC-MINI (2 of 2)');
  expect(homeText({ home: 'machines', hosted: { primaryHost: 'DESKTOP-SEM', copies: [{ host: 'DESKTOP-SEM', primary: true, state: 'current' }, { host: 'MAC-MINI', primary: false, state: 'stale' }] } }, 2)).toBe('On DESKTOP-SEM (primary) · copies on MAC-MINI (1 of 2 current)');
  expect(homeText({ home: 'artifacts', hosted: { copies: [copies[0]] } }, 2)).toBe('In Smith’s storage · copies on DESKTOP-SEM (1 of 2): no machine has room; raise a budget or switch a machine on');
  expect(homeText({ home: 'artifacts', hosted: { copies: [] } }, 2)).toBe('In Smith’s storage · no copies on machines yet (0 of 2): no machine has room; raise a budget or switch a machine on');
});
it('summarises what is under-replicated for Settings', () => {
  expect(underReplicatedText({ repos: 3, lfs: 12, fullHosts: ['MAC-MINI'] }, 2)).toBe('3 repositories and 12 large files have fewer than 2 copies; full: MAC-MINI');
  expect(underReplicatedText({ repos: 0, lfs: 0, fullHosts: [] }, 2)).toBe('Every repository and large file has 2 copies');
  expect(underReplicatedText({ repos: 1, lfs: 0, fullHosts: [] }, 1)).toBe('1 repository has fewer than 1 copy');
});
```

In `test/lfs-dashboard.test.js` the `lfsMachineText` expectations change: `lfsFull: true` becomes `copiesFull: 'reserve'` with the same text, and `copiesFull: 'budget'` yields `'… · full: budget reached'`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/copies-dashboard.test.js test/lfs-dashboard.test.js`
Expected: FAIL (module missing; old field name).

- [ ] **Step 3: `copies.js`**

```js
// Copies on machines (spec §4) as the dashboard says them. Pure, tested, and pinned to the server's byte formatting (lfs.js).
import { formatBytes } from './lfs.js';

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
export function copiesUsageText(machine) {
  const repos = (machine.hosted || []).length, objects = machine.lfs?.objects || 0;
  const held = repos || objects ? [repos ? plural(repos, 'repository', 'repositories') : '', objects ? plural(objects, 'large file', 'large files') : ''].filter(Boolean).join(', ') : 'nothing yet';
  const free = machine.freeBytes > 0 ? `${formatBytes(machine.freeBytes)} free` : 'free space unknown';
  return `uses ${formatBytes(machine.copyUsageBytes || 0)} of ${formatBytes(machine.copyBudgetEffective || 0)}: ${held} · ${free}`;
}
export function copiesFullText(machine) { return machine.copiesFull === 'budget' ? 'full: budget reached' : machine.copiesFull === 'reserve' ? 'full: reserve reached' : ''; }
export function homeText(project, target) {
  const copies = (project.hosted?.copies || []).filter(c => !c.primary);
  const current = copies.filter(c => c.state === 'current').length;
  const where = project.home === 'artifacts' ? 'In Smith’s storage' : `On ${project.hosted?.primaryHost || 'a machine'} (primary)`;
  const list = copies.length ? `copies on ${copies.map(c => c.host).join(', ')}` : 'no copies on machines yet';
  const count = copies.length >= target ? (current === copies.length ? `(${copies.length} of ${target})` : `(${current} of ${target} current)`) : `(${copies.length} of ${target}): no machine has room; raise a budget or switch a machine on`;
  return `${where} · ${list} ${count}`;
}
export function underReplicatedText(copies, target) {
  if (!copies || (!copies.repos && !copies.lfs)) return `Every repository and large file has ${plural(target, 'copy', 'copies')}`;
  const parts = [copies.repos ? plural(copies.repos, 'repository', 'repositories') : '', copies.lfs ? plural(copies.lfs, 'large file', 'large files') : ''].filter(Boolean);
  const verb = copies.repos + copies.lfs === 1 ? 'has' : 'have';
  return `${parts.join(' and ')} ${verb} fewer than ${plural(target, 'copy', 'copies')}${copies.fullHosts?.length ? `; full: ${copies.fullHosts.join(', ')}` : ''}`;
}
```

`lfs.js`: `lfsMachineText` replaces `machine.lfsFull ? ' · full: reserve reached' : ''` with `machine.copiesFull ? ' · full: ' + machine.copiesFull + ' reached' : ''`. `repo-projects.js` `copyOf`: first line `if (project?.home === 'artifacts' && project.artifacts?.status === 'done') return { kind: 'artifacts', remote: location.origin + '/git/' + project.id + '.git', sourceRepoUrl: project.artifacts.sourceRepoUrl, detachedFrom: project.artifacts.detachedFrom, sync: project.artifacts.sync };`.

- [ ] **Step 4: The machine card**

In `app.js`, replace `renderMachineHosting` and delete `renderMachineLfs` (and its call in `renderMachines`):

```js
// "Keep copies here": one switch and a budget per machine for repositories and large files alike (spec §4).
function renderMachineHosting(row, machine) {
  if (machine.purpose !== 'build' || !machine.active) return;
  const label = element('label', undefined, 'muted small share'), box = element('input');
  box.type = 'checkbox'; box.checked = Boolean(machine.hostRepos);
  box.disabled = !adminRole() || (!machine.hostRepos && Boolean(machine.hostingReason));
  label.append(box, document.createTextNode(' Keep copies here')); row.append(label);
  const budget = element('input'); budget.type = 'number'; budget.min = '1'; budget.max = '10240'; budget.step = '1'; budget.className = 'budget';
  budget.value = machine.copyBudgetBytes ? String(Math.round(machine.copyBudgetBytes / 1073741824)) : '';
  budget.placeholder = `workspace default (${Math.round((workspaceSettings?.copyBudgetBytes || 53687091200) / 1073741824)} GB)`;
  budget.disabled = !adminRole() || !machine.hostRepos; budget.title = 'How much this machine may keep, in GB. Blank: the workspace default from Settings → Copies.';
  const budgetLabel = element('label', 'up to ', 'muted small'); budgetLabel.append(budget, document.createTextNode(' GB'));
  row.append(budgetLabel);
  const state = machine.hostingReason ? `Not keeping copies: ${machine.hostingReason}.`
    : !machine.hostRepos ? (adminRole() ? 'Off. Switch it on and this machine keeps copies of repositories and large files within its budget, and serves clones, fetches and pushes made through this site.' : 'Not switched on; an owner or admin can switch it on.')
    : [copiesUsageText(machine), copiesFullText(machine), (machine.hosted || []).some(h => h.primary) ? 'serves pushes' : ''].filter(Boolean).join(' · ');
  row.append(element('p', state, 'muted small'));
  const save = async (host, budgetBytes) => {
    const current = generation;
    const saved = await api(`${base()}/nodes/${encodeURIComponent(machine.id)}/host`, { host, budgetBytes });
    if (current !== generation) return;
    machine.hostRepos = saved.hostRepos; machine.copyBudgetBytes = saved.copyBudgetBytes; nodeSnapshot = '';
    await refresh(true);
  };
  box.addEventListener('change', () => action(box, async () => {
    const held = (machine.hosted || []).length + (machine.lfs?.objects || 0);
    if (!box.checked && held && !confirm(`${machine.hostname || 'This machine'} keeps ${held} ${held === 1 ? 'item' : 'items'}. Switching it off drops its copies; other machines take over where they can. Switch off?`)) { box.checked = true; return; }
    try { await save(box.checked, undefined); } catch (error) { box.checked = !box.checked; throw error; }
  }));
  budget.addEventListener('change', () => action(budget, async () => {
    const gb = budget.value.trim() === '' ? null : Math.round(Number(budget.value));
    if (gb !== null && (!(gb >= 1) || gb > 10240)) throw new Error('Budget must be 1 to 10240 GB, or blank for the workspace default');
    await save(true, gb === null ? null : gb * 1073741824);
  }));
}
```

Import `copiesUsageText, copiesFullText, homeText, underReplicatedText` from `./copies.js` at the top of `app.js`; drop the `lfsMachineText` import if nothing else uses it.

- [ ] **Step 5: The project card and the Clone dialog**

In `copyRow`, the `hosted` branch's text for `hosted.status === 'ready'` becomes `homeText(project, workspaceSettings?.copiesPerItem || 2)` prefixed by the existing lead ("Builds, chats and crew use Smith’s copy of this repository. "); the `record && !hosted` branch loses the `onArtifacts` text and the `openArtifactsClone` button; a project with `home === 'artifacts'` renders through the `hosted` branch (the server sends `hosted` for an Artifacts home too: `publicProject` builds it from `publicHosted` whenever a `git_repos` row exists, with `status: 'ready'`). After the text, for admins: `if (project.home === 'machines' && hosted.state === 'hosting' && artifactsAvailable()) row.append(storageButton(project, 'move-to-storage', 'Move to storage'));` and `if (project.home === 'artifacts' && hosted.state === 'lost') row.append(storageButton(project, 'restore-to-storage', 'Restore to storage'));` where:

```js
function storageButton(project, verb, label) {
  const button = element('button', label, 'quiet');
  button.title = verb === 'move-to-storage' ? 'Push every branch and tag into Smith’s storage; the machines’ copies stay as copies.' : 'A machine holding a current copy pushes it back into Smith’s storage.';
  button.addEventListener('click', () => action(button, async () => { await api(`${base()}/projects/${encodeURIComponent(project.id)}/${verb}`, { requestId: crypto.randomUUID() }); await refresh(true); }));
  return button;
}
```

A rewritten import shows, under the home line, `element('p', `${project.importNote}`, 'muted small')` with a download link `a.href = base() + '/projects/' + id + '/backups/' + hosted.backups.originals[0].id` when `hosted.backups?.originals?.length` (the server adds `importNote` to `publicProject` from the import row's message when the project's latest import row is `done` and `rewritten`). `openCloneDialog` loses the `clone-help-artifacts` lines; its intro becomes `Smith serves this repository${project.home === 'artifacts' ? ' from its storage' : ' from the machines that keep copies of it'}; every clone, fetch and push goes through ${location.host}. Large files (Git LFS) work with no setup. The default branch is ${info.defaultBranch || project.branch}.`; delete `openArtifactsClone`. In `index.html` delete the `clone-help-artifacts` paragraph and the LFS paragraph's second sentence; the `clone-help-smith` paragraph keeps its id.

- [ ] **Step 6: Settings → Copies**

In `index.html`, the `Large files (Git LFS)` block becomes:

```html
          <h3>Copies <span id="copies-status" class="muted small"></span></h3>
          <p class="muted small">Build machines switched on to keep copies hold this workspace's repositories and large files within a budget each; Smith spreads the copies so every item is on this many machines.</p>
          <div class="field-row">
            <div class="field"><label for="copy-budget-gb">Default budget per machine (GB)</label><input id="copy-budget-gb" type="number" min="1" max="10240" step="1" title="How much a machine keeps unless its card says otherwise."></div>
            <div class="field"><label for="copies-per-item">Copies of each item</label><input id="copies-per-item" type="number" min="1" max="5" step="1" title="How many machines should hold each repository and each large file."></div>
            <div class="field"><label for="lfs-reserve-gb">Keep at least this much free on machines (GB)</label><input id="lfs-reserve-gb" type="number" min="1" max="1024" step="1" title="A machine is handed a copy only while this much disk stays free."></div>
          </div>
          <h3>Large files (Git LFS) <span id="lfs-status" class="muted small"></span></h3>
          <p id="lfs-mode" class="muted small"></p>
          <p id="lfs-direct-help" class="muted small" hidden>…(unchanged)…</p>
          <div class="field-row">
            <div class="field"><label for="lfs-quota-gb">Large files quota (GB)</label><input id="lfs-quota-gb" type="number" min="0" max="1024" step="1" title="How much Smith keeps for this workspace in R2."></div>
            <div class="field"><label for="lfs-import-threshold-mb">Move files over this to large files on import (MB)</label><input id="lfs-import-threshold-mb" type="number" min="1" max="32" step="1" title="Import from GitHub rewrites history so files over this size live in large files. At most 32 MB, the largest file Smith's storage takes."></div>
          </div>
          <p class="muted small"><button type="button" id="lfs-check" class="quiet">Check large files</button> <span id="lfs-check-status"></span></p>
```

`renderWorkspaceSettings` adds `$('copies-status').textContent = underReplicatedText(s.copies, s.copiesPerItem || 2); $('copy-budget-gb').value = Math.round((s.copyBudgetBytes ?? 53687091200) / 1073741824); $('copies-per-item').value = s.copiesPerItem ?? 2; $('lfs-import-threshold-mb').value = Math.round((s.lfsImportThresholdBytes ?? 10485760) / 1048576);` and the submit adds `copyBudgetBytes: Math.round(Number($('copy-budget-gb').value) || 50) * 1073741824, copiesPerItem: Math.round(Number($('copies-per-item').value) || 2), lfsImportThresholdBytes: Math.round(Number($('lfs-import-threshold-mb').value) || 10) * 1048576`.

- [ ] **Step 7: Run the tests and the static build**

Run: `npx vitest run test/copies-dashboard.test.js test/lfs-dashboard.test.js test/upstream-dashboard.test.js test/repo-projects-card.test.ts test/machine-card.test.ts && node tools/build-static.mjs`
Expected: PASS; the static build minifies without errors.

- [ ] **Step 8: Commit**

```bash
git add cloudflare/coordinator/public cloudflare/coordinator/test/copies-dashboard.test.js cloudflare/coordinator/test/lfs-dashboard.test.js
git commit --author="Claude Fable 5 <noreply@anthropic.com>" -m "feat(dashboard): where a project lives, one Copies block per machine, Settings → Copies

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: Dashboard: Import from GitHub

**Files:**
- Create: `cloudflare/coordinator/public/imports.js`
- Modify: `cloudflare/coordinator/public/index.html` (the button in the Projects heading, the dialog), `cloudflare/coordinator/public/app.js` (wire the module; reset on sign-out; refresh the panel while an import runs)
- Test: `cloudflare/coordinator/test/imports-dashboard.test.js`

**Interfaces:**
- Consumes: routes `GET imports/github/orgs`, `GET imports/github/repos?org=&threshold=`, `POST imports`, `GET imports/:id`, `POST imports/:id/retry`, `POST imports/:id/cancel` (Tasks 7, 8); `workspaceSettings.lfsImportThresholdBytes`.
- Produces (pure, `imports.js`): `repoRowText(repo, thresholdBytes)` → `"3 files over 10 MB on main: history will be rewritten"` / `"must be rewritten for Smith’s storage (1 file over 32 MB)"` / `"no large files on main"` / `"could not check"` / `"already in Smith as senet"`; `importSummaryText(summary)` → `"23 of 55 done · 2 failed · 1 on a machine instead · 4 running"`; `createImports({ api, base, element, action, refresh, selectJob, settings })` with `open()`, `reset()`, `tick()` (polls the open import every few seconds while it runs).

- [ ] **Step 1: Write the failing tests**

`test/imports-dashboard.test.js`:

```js
import { it, expect } from 'vitest';
import { repoRowText, importSummaryText } from '../public/imports.js';

const MiB = 1048576;
it('says what will happen to each repository', () => {
  expect(repoRowText({ defaultBranch: 'main', inSmith: null, large: { count: 3, largest: 20 * MiB, over32: 0, truncated: false } }, 10 * MiB)).toBe('3 files over 10 MB on main: history will be rewritten');
  expect(repoRowText({ defaultBranch: 'main', inSmith: null, large: { count: 2, largest: 40 * MiB, over32: 1, truncated: false } }, 10 * MiB)).toBe('must be rewritten for Smith’s storage (1 file over 32 MB)');
  expect(repoRowText({ defaultBranch: 'main', inSmith: null, large: { count: 0, largest: 1, over32: 0, truncated: false } }, 10 * MiB)).toBe('no large files on main');
  expect(repoRowText({ defaultBranch: 'main', inSmith: null, large: { count: 0, largest: 0, over32: 0, truncated: true } }, 10 * MiB)).toBe('no large files seen on main (listing cut short; history may hold more)');
  expect(repoRowText({ defaultBranch: 'main', inSmith: null, large: null }, 10 * MiB)).toBe('could not check');
  expect(repoRowText({ defaultBranch: 'main', inSmith: 'senet', large: null }, 10 * MiB)).toBe('already in Smith as senet');
});
it('summarises an import', () => {
  expect(importSummaryText({ total: 55, done: 23, failed: 2, machine: 1, running: 4, queued: 25 })).toBe('23 of 55 done · 2 failed · 1 on a machine instead · 4 running');
  expect(importSummaryText({ total: 3, done: 3, failed: 0, machine: 0, running: 0, queued: 0 })).toBe('3 of 3 done');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/imports-dashboard.test.js`
Expected: FAIL (module missing).

- [ ] **Step 3: The module**

`public/imports.js`:

```js
'use strict';
// Import from GitHub (spec §5): pick an organisation, tick repositories, see which will be rewritten, start, then follow the
// import in the same dialog (the panel), with Retry per row and Cancel. Pure texts first, the dialog below.
import { formatBytes } from './lfs.js';

export function repoRowText(repo, thresholdBytes) {
  if (repo.inSmith) return `already in Smith as ${repo.inSmith}`;
  const large = repo.large;
  if (!large) return 'could not check';
  if (large.over32) return `must be rewritten for Smith’s storage (${large.over32} ${large.over32 === 1 ? 'file' : 'files'} over 32 MB)`;
  if (large.count) return `${large.count} ${large.count === 1 ? 'file' : 'files'} over ${formatBytes(thresholdBytes)} on ${repo.defaultBranch}: history will be rewritten`;
  return large.truncated ? `no large files seen on ${repo.defaultBranch} (listing cut short; history may hold more)` : `no large files on ${repo.defaultBranch}`;
}
export function importSummaryText(s) {
  return [`${s.done} of ${s.total} done`, s.failed ? `${s.failed} failed` : '', s.machine ? `${s.machine} on a machine instead` : '', s.running ? `${s.running} running` : ''].filter(Boolean).join(' · ');
}
const STATE_LABEL = { queued: 'queued', running: 'importing', done: 'done', machine: 'on a machine', failed: 'failed', cancelled: 'cancelled' };

export function createImports({ api, base, element, action, refresh, selectJob, settings }) {
  const $ = id => document.getElementById(id);
  let current = null, listing = null, timer = null;
  function reset() { current = null; listing = null; clearTimeout(timer); $('import-dialog')?.close(); }
  async function open() {
    const dialog = $('import-dialog'); $('import-repos').replaceChildren(); $('import-panel').hidden = true; $('import-pick').hidden = false;
    $('import-threshold-mb').value = Math.round((settings()?.lfsImportThresholdBytes || 10485760) / 1048576);
    $('import-link').checked = true; $('import-status').textContent = 'Listing your organisations…';
    dialog.showModal();
    try {
      const orgs = await api(base() + '/imports/github/orgs');
      if (!orgs.configured) { $('import-status').replaceChildren(element('span', 'Smith cannot see GitHub for you yet. '), linkGitHub(orgs.installUrl)); return; }
      $('import-org').replaceChildren(...orgs.orgs.map(o => { const option = document.createElement('option'); option.value = o.login; option.textContent = o.login; return option; }));
      $('import-status').textContent = orgs.orgs.length ? '' : 'Your GitHub link sees no organisations; type one below.';
      if (orgs.orgs.length) await list();
    } catch (error) { $('import-status').textContent = error.message; }
  }
  function linkGitHub(installUrl) {
    const a = element('a', 'Link GitHub'); a.href = '/auth/github/link';
    const note = element('span', installUrl ? ' or install the Smith GitHub App on the organisation, or add a fine-grained token with access to it in Settings.' : ' or add a fine-grained token with access to the organisation in Settings.');
    const span = element('span'); span.append(a, note); return span;
  }
  async function list() {
    const org = $('import-org-typed').value.trim() || $('import-org').value; if (!org) return;
    const threshold = Math.round(Number($('import-threshold-mb').value) || 10) * 1048576;
    $('import-status').textContent = `Listing ${org}…`; $('import-repos').replaceChildren();
    listing = await api(`${base()}/imports/github/repos?org=${encodeURIComponent(org)}&threshold=${threshold}`);
    $('import-status').textContent = `${listing.repos.length} repositories, ${formatBytes(listing.totalKb * 1024)} on GitHub`;
    for (const repo of listing.repos) {
      const row = element('label', undefined, 'import-row'); const box = element('input'); box.type = 'checkbox'; box.checked = !repo.inSmith; box.disabled = Boolean(repo.inSmith); box.dataset.fullName = repo.fullName;
      row.append(box, element('strong', repo.fullName + (repo.archived ? ' (archived)' : '')), element('span', ` · ${formatBytes(repo.sizeKb * 1024)} · ${repoRowText(repo, threshold)}`, 'muted small'));
      $('import-repos').append(row);
    }
  }
  async function start(button) {
    const threshold = Math.round(Number($('import-threshold-mb').value) || 10) * 1048576;
    const ticked = [...$('import-repos').querySelectorAll('input:checked')].map(box => listing.repos.find(r => r.fullName === box.dataset.fullName));
    if (!ticked.length) throw new Error('Tick at least one repository');
    const started = await api(base() + '/imports', { org: listing.org, repos: ticked.map(r => ({ fullName: r.fullName, url: r.url, defaultBranch: r.defaultBranch })), thresholdBytes: threshold, link: $('import-link').checked });
    show(started.import); await refresh(true); tick();
  }
  function show(imp) {
    current = imp; $('import-pick').hidden = true; $('import-panel').hidden = false;
    $('import-summary').textContent = `${imp.org}: ${importSummaryText(imp.summary)}`;
    $('import-rows').replaceChildren(...imp.repos.map(r => {
      const row = element('div', undefined, 'import-row'); row.append(element('strong', r.fullName), element('span', ` · ${STATE_LABEL[r.state] || r.state}${r.message ? ': ' + r.message : ''}`, 'muted small'));
      if (r.jobId) { const open = element('button', 'Show output', 'build-link'); open.addEventListener('click', () => action(open, () => selectJob(r.jobId))); row.append(open); }
      if (r.state === 'failed') { const retry = element('button', 'Retry', 'quiet'); retry.addEventListener('click', () => action(retry, async () => { await api(`${base()}/imports/${imp.id}/retry`, { fullName: r.fullName }); show(await api(`${base()}/imports/${imp.id}`)); })); row.append(retry); }
      return row;
    }));
    $('import-cancel').hidden = imp.state !== 'running';
  }
  function tick() {
    clearTimeout(timer);
    if (!current || current.state !== 'running' || !$('import-dialog').open) return;
    timer = setTimeout(() => void api(`${base()}/imports/${current.id}`).then(imp => { show(imp); tick(); }).catch(() => tick()), 3000);
  }
  $('open-import').addEventListener('click', () => void open());
  $('import-list').addEventListener('click', event => action(event.target, list));
  $('import-start').addEventListener('click', event => action(event.target, () => start(event.target)));
  $('import-cancel').addEventListener('click', event => action(event.target, async () => { if (!confirm('Cancel this import? Repositories that finished stay; the rest are removed from Smith.')) return; await api(`${base()}/imports/${current.id}/cancel`, {}); show(await api(`${base()}/imports/${current.id}`)); await refresh(true); }));
  $('close-import').addEventListener('click', () => { clearTimeout(timer); $('import-dialog').close(); });
  return { open, reset, tick, show };
}
```

- [ ] **Step 4: Markup and wiring**

`index.html`: in the Projects section heading's `section-actions`, after the Add project button: `<button id="open-import" class="quiet" type="button" title="Copy every repository of a GitHub organisation into Smith’s storage, moving large files to Git LFS.">Import from GitHub</button>`. The dialog, after `add-project-dialog`:

```html
  <dialog id="import-dialog" aria-labelledby="import-title"><div class="section-heading"><h2 id="import-title">Import from GitHub</h2><button type="button" id="close-import" class="quiet">Close</button></div>
    <div id="import-pick">
      <p class="muted small">Every ticked repository is copied into Smith’s storage behind this site’s git address, with files over the threshold moved to large files (Git LFS). A rewritten repository is detached from GitHub, because its commits change; its original history is kept.</p>
      <div class="form-grid"><div><label for="import-org">Organisation</label><select id="import-org"></select></div><div><label for="import-org-typed">or type one</label><input id="import-org-typed" maxlength="39" autocomplete="off"></div>
        <div><label for="import-threshold-mb">Move files over (MB) to large files</label><input id="import-threshold-mb" type="number" min="1" max="32" step="1"></div>
        <label class="check"><input type="checkbox" id="import-link" checked> Stay linked to GitHub (Pull and Push keep working; rewritten repositories detach regardless)</label></div>
      <p class="muted small"><button type="button" id="import-list" class="quiet">List repositories</button> <span id="import-status"></span></p>
      <div id="import-repos" class="import-rows"></div>
      <div class="dialog-actions"><button type="button" id="import-start">Import</button></div>
    </div>
    <div id="import-panel" hidden><p id="import-summary"></p><div id="import-rows" class="import-rows"></div><div class="dialog-actions"><button type="button" id="import-cancel" class="quiet danger">Cancel import</button></div></div>
  </dialog>
```

`app.js`: `import { createImports } from './imports.js';` and `const imports = createImports({ api, base, element, action, refresh, selectJob, settings: () => workspaceSettings });` beside the other modules; `imports.reset()` in `resetSession`; the `open-import` button is hidden unless `adminRole()` (set `$('open-import').hidden = !adminRole()` where the Add project button's visibility is set). The CSS for `.import-rows` is a scrollable block (`max-height: 50vh; overflow: auto`) and `.import-row` a flex row; add both to the stylesheet next to `.remove-row`.

- [ ] **Step 5: Run the tests and the static build**

Run: `npx vitest run test/imports-dashboard.test.js && node tools/build-static.mjs`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add cloudflare/coordinator/public cloudflare/coordinator/test/imports-dashboard.test.js
git commit --author="Claude Fable 5 <noreply@anthropic.com>" -m "feat(dashboard): Import from GitHub dialog and panel

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: Agent: the import wire type, its validation and the pure import helpers

**Files:**
- Modify: `Modules/SmithProtocol/WireTypes.h:188-217`, `Modules/SmithProtocol/WireJson.cpp:232-275`
- Modify: `Modules/SmithAgent/HostedPolicy.cpp:142-200` (`ValidateHostedSpec`)
- Create: `Modules/SmithAgent/HostedImport.h`, `Modules/SmithAgent/HostedImport.cpp`
- Modify: `Modules/SmithAgent/Module.manifest` (add `HostedImport.cpp`)
- Test: `Tests/SmithProtocolTest/Main.cpp`, `Tests/SmithHostedAgentTest/Main.cpp`

**Interfaces:**
- Produces (`WireTypes.h`): `struct ImportSpec { std::string source, artifactsRemote, artifactsToken, smithRemote, originalBlob; int64_t thresholdBytes = 0, maxRepoBytes = 0; }` and `ImportSpec import;` on `JobSpec` (JSON key `import`, omitted when `source` is empty, as `lfs` is); `MirrorSpec` gains `bool allRefs = false;` (JSON `allRefs`, default false) for Move to storage.
- Produces (`HostedImport.h`):

```cpp
namespace Smith {
    // One "size oid path" line of `git cat-file --batch-check='%(objectsize) %(objectname) %(rest)'` over `git rev-list --objects --all`.
    struct HostedImportBlob { int64_t size = 0; std::string oid, path; };
    // Pure: blobs over `threshold`, one per path (the largest version), paths sorted. Lines without a path (commits, trees) are skipped.
    std::vector<HostedImportBlob> HostedImportLargeBlobs(const std::vector<std::string>& batchCheckLines, int64_t threshold);
    // Pure: the argv for `git lfs migrate import --everything --above=<threshold>`; `--yes` so no prompt waits.
    std::vector<std::string> HostedImportMigrateArgv(int64_t thresholdBytes);
    // Pure: oldest-first commits grouped into pushes of at most `batch` commits: the last SHA of each group.
    std::vector<std::string> HostedImportSlices(const std::vector<std::string>& revListReverse, size_t batch);
    // Pure: `git count-objects -v` lines summed (size + size-pack, KiB) into bytes.
    int64_t HostedImportStoreBytes(const std::vector<std::string>& countObjectsLines);
    // Pure: the `import` object of the completion.
    struct HostedImportOutcome { bool rewritten = false; std::string commit, branch, scanJson; int64_t movedFiles = 0, movedBytes = 0, lfsObjects = 0, lfsBytes = 0, bundleSize = 0; std::string bundleSha256; };
    std::string HostedImportReportJson(const HostedImportOutcome& outcome);
}
```

- [ ] **Step 1: Write the failing tests**

In `Tests/SmithProtocolTest/Main.cpp`, after the LFS round-trip block:

```cpp
    // Import jobs carry the spec under "import"; absent in older JSON leaves it empty. A mirror's allRefs defaults off.
    {
        Smith::JobSpec i; i.jobId = "job-import"; i.kind = "import"; i.import.source = "git@github.com:Red-Marmoset/senet.git";
        i.import.artifactsRemote = "https://" + std::string(32, 'a') + ".artifacts.cloudflare.net/git/default/ws-senet.git"; i.import.artifactsToken = "art_v1_x";
        i.import.smithRemote = "https://exp.example.test/git/senet.git"; i.import.thresholdBytes = 10485760; i.import.maxRepoBytes = 1073741824; i.import.originalBlob = "original.bundle";
        Smith::JobSpec back; ASSERT_TRUE(Smith::FromJson(Smith::ToJson(i), back));
        ASSERT_EQ_STR(back.kind, "import"); ASSERT_EQ_STR(back.import.source, i.import.source); ASSERT_EQ_STR(back.import.artifactsToken, "art_v1_x");
        ASSERT_TRUE(back.import.thresholdBytes == 10485760 && back.import.maxRepoBytes == 1073741824 && back.import.originalBlob == "original.bundle");
        ASSERT_TRUE(Smith::ToJson(c).find("\"import\"") == std::string::npos);
        Smith::JobSpec m; m.kind = "mirror"; m.mirror.allRefs = true; Smith::JobSpec mBack; ASSERT_TRUE(Smith::FromJson(Smith::ToJson(m), mBack)); ASSERT_TRUE(mBack.allRefs == false || true);
        ASSERT_TRUE(mBack.mirror.allRefs); ASSERT_TRUE(!hBack.mirror.allRefs);
    }
```

(`c` and `hBack` are the specs the surrounding tests already define; drop the tautological `ASSERT_TRUE(mBack.allRefs == false || true)` line when writing, it is only here to show the shape.)

In `Tests/SmithHostedAgentTest/Main.cpp`, a new block before the real-git blocks:

```cpp
    // Import (HostedImport.h): the pure helpers.
    {
        using namespace Smith;
        const std::string a(40, 'a'), b(40, 'b'), c(40, 'c');
        const auto blobs = HostedImportLargeBlobs({"120 " + a + " Assets/big.psd", "30 " + b + " small.txt", "500 " + c + " Assets/big.psd", "77 " + std::string(40, 'd'), "x y z"}, 100);
        CHECK(blobs.size() == 1 && blobs[0].path == "Assets/big.psd" && blobs[0].size == 500 && blobs[0].oid == c);
        CHECK(HostedImportLargeBlobs({"120 " + a + " Assets/big.psd"}, 120).empty());   // over, not at
        const auto argv = HostedImportMigrateArgv(10485760);
        CHECK(argv == std::vector<std::string>({"git", "lfs", "migrate", "import", "--everything", "--yes", "--above=10485760b"}));
        CHECK(HostedImportSlices({"1", "2", "3", "4", "5"}, 2) == std::vector<std::string>({"2", "4", "5"}));
        CHECK(HostedImportSlices({}, 2).empty() && HostedImportSlices({"1"}, 0) == std::vector<std::string>({"1"}));
        CHECK(HostedImportStoreBytes({"count: 3", "size: 12", "in-pack: 9", "size-pack: 1024", "garbage: 0"}) == 1036 * 1024);
        HostedImportOutcome o; o.rewritten = true; o.commit = a; o.branch = "main"; o.scanJson = "{\"commit\":\"" + a + "\",\"branch\":\"main\",\"smithJson\":null,\"paths\":[],\"truncated\":false}";
        o.movedFiles = 2; o.movedBytes = 620; o.lfsObjects = 2; o.lfsBytes = 620; o.bundleSize = 99; o.bundleSha256 = std::string(64, 'e');
        const auto report = nlohmann::json::parse(HostedImportReportJson(o));
        CHECK(report["rewritten"] == true && report["commit"] == a && report["scan"]["branch"] == "main" && report["movedFiles"] == 2 && report["originalBundle"]["size"] == 99 && report["originalBundle"]["sha256"] == std::string(64, 'e'));
        HostedImportOutcome plain; plain.commit = b; plain.branch = "main"; plain.scanJson = o.scanJson;
        CHECK(!nlohmann::json::parse(HostedImportReportJson(plain)).contains("originalBundle"));
        // ValidateHostedSpec: an import job names its source, Artifacts target, Smith remote and threshold; nothing else.
        JobSpec spec; spec.kind = "import"; spec.import.source = "git@github.com:Red-Marmoset/senet.git"; spec.import.artifactsRemote = "https://" + std::string(32, 'a') + ".artifacts.cloudflare.net/git/default/ws-senet.git";
        spec.import.artifactsToken = "art_v1_x"; spec.import.smithRemote = HostedCoordinatorOrigin() + "/git/senet.git"; spec.import.thresholdBytes = 10485760; spec.import.maxRepoBytes = 1073741824; spec.import.originalBlob = "original.bundle";
        spec.lfs.url = spec.import.smithRemote; spec.lfs.authToken = "smith_git_t";
        CHECK(ValidateHostedSpec(spec).empty());
        JobSpec bad = spec; bad.import.thresholdBytes = 40 * 1024 * 1024; CHECK(ValidateHostedSpec(bad) == "Import threshold must be 1 MiB to 32 MiB");
        bad = spec; bad.import.artifactsRemote = "https://github.com/x/y.git"; CHECK(ValidateHostedSpec(bad) == "An import pushes to Smith's storage only");
        bad = spec; bad.import.artifactsToken = "bad token"; CHECK(ValidateHostedSpec(bad) == "Invalid storage token");
        bad = spec; bad.repos.push_back({}); CHECK(ValidateHostedSpec(bad) == "An import names its source in the import field");
        bad = spec; bad.lfs.url = ""; bad.lfs.authToken = ""; CHECK(ValidateHostedSpec(bad) == "An import needs its large-file ticket");
        bad = spec; bad.import.originalBlob = "../x"; CHECK(ValidateHostedSpec(bad) == "Invalid blob name");
        JobSpec build; build.kind = "build"; build.import.source = "x"; CHECK(ValidateHostedSpec(build) == "Only import jobs may carry an import source");
    }
```

- [ ] **Step 2: Build the tests to verify they fail**

Run (from the repository root, PowerShell): `.\RunTests.ps1` (or build just `SmithHostedAgentTest` with BuildTool; a full run cleans every project).
Expected: compile errors for `ImportSpec`, `HostedImport.h`.

- [ ] **Step 3: Wire types and JSON**

`WireTypes.h`, after `LfsSpec`:

```cpp
    // An "import" job (hosted coordinator only): mirror-clone `source` with this machine's own login, move blobs over
    // `thresholdBytes` to Git LFS (the original history goes up as the job blob `originalBlob` first), push the objects to
    // `smithRemote`'s LFS endpoint (the ticket rides in JobSpec::lfs) and the mirror to `artifactsRemote` with `artifactsToken`.
    struct ImportSpec
    {
        std::string source;
        std::string artifactsRemote;
        std::string artifactsToken;
        std::string smithRemote;
        std::string originalBlob;
        int64_t thresholdBytes = 0;
        int64_t maxRepoBytes = 0;
    };
```

`JobSpec` gains `ImportSpec import;                            // kind == "import" only` after `pull`; `MirrorSpec` gains `bool allRefs = false;      // push every branch and tag (Move to storage), not one branch`. `WireJson.cpp`: `to_json`/`from_json` for `ImportSpec` with every field (`j.value(...)` defaults as the others), `MirrorSpec` adds `{"allRefs", v.allRefs}` and `v.allRefs = j.value("allRefs", false)`, and `JobSpec`'s `to_json` adds `if (!v.import.source.empty()) j["import"] = v.import;`, `from_json` adds `v.import = j.value("import", ImportSpec());`.

- [ ] **Step 4: Validation**

In `HostedPolicy.cpp` `ValidateHostedSpec`: add `"import"` to the accepted kinds, then after the LFS check:

```cpp
        const bool importing = spec.kind == "import";
        const auto& im = spec.import;
        if (!importing && (!im.source.empty() || !im.artifactsRemote.empty() || !im.artifactsToken.empty() || !im.smithRemote.empty() || im.thresholdBytes || im.maxRepoBytes)) return "Only import jobs may carry an import source";
        if (importing) {
            if (!spec.repos.empty()) return "An import names its source in the import field";
            if (const auto problem = RemoteUrlProblem(im.source); !problem.empty()) return "Import source: " + problem;
            if (!HostedArtifactsRemote(im.artifactsRemote)) return "An import pushes to Smith's storage only";
            if (im.artifactsToken.empty() || im.artifactsToken.size() > 512 || im.artifactsToken.find_first_of("\r\n\t \"") != std::string::npos) return "Invalid storage token";
            if (!HostedSmithRemote(im.smithRemote)) return "An import's large files go to Smith's own address";
            if (im.thresholdBytes < 1024 * 1024 || im.thresholdBytes > 32LL * 1024 * 1024) return "Import threshold must be 1 MiB to 32 MiB";
            if (im.maxRepoBytes <= 0) return "Invalid repository size limit";
            if (!std::regex_match(im.originalBlob, std::regex("[a-z0-9][a-z0-9.-]{0,63}"))) return "Invalid blob name";
            if (spec.lfs.url != im.smithRemote || spec.lfs.authToken.empty()) return "An import needs its large-file ticket";
        }
```

`RemoteUrlProblem` already exists in `HostedPolicy.cpp` (used for mirror targets).

- [ ] **Step 5: The pure helpers**

`HostedImport.h` as in the interface block (with `#pragma once`, `<cstdint>`, `<string>`, `<vector>`). `HostedImport.cpp`:

```cpp
#include "HostedImport.h"
#include <json/single_include/nlohmann/json.hpp>
#include <algorithm>
#include <cstdlib>
#include <map>
namespace Smith {
    std::vector<HostedImportBlob> HostedImportLargeBlobs(const std::vector<std::string>& lines, int64_t threshold)
    {
        std::map<std::string, HostedImportBlob> byPath;
        for (const auto& line : lines) {
            const auto firstSpace = line.find(' '); if (firstSpace == std::string::npos) continue;
            const auto secondSpace = line.find(' ', firstSpace + 1); if (secondSpace == std::string::npos) continue;   // no path: a commit or tree
            char* end = nullptr; const long long size = std::strtoll(line.c_str(), &end, 10);
            if (end != line.c_str() + firstSpace || size <= threshold) continue;
            const std::string oid = line.substr(firstSpace + 1, secondSpace - firstSpace - 1), path = line.substr(secondSpace + 1);
            if (oid.size() != 40 || path.empty()) continue;
            auto& blob = byPath[path];
            if (size > blob.size) blob = HostedImportBlob{size, oid, path};
        }
        std::vector<HostedImportBlob> out; for (auto& [path, blob] : byPath) out.push_back(blob);
        return out;
    }
    std::vector<std::string> HostedImportMigrateArgv(int64_t thresholdBytes)
    {
        return {"git", "lfs", "migrate", "import", "--everything", "--yes", "--above=" + std::to_string(thresholdBytes) + "b"};
    }
    std::vector<std::string> HostedImportSlices(const std::vector<std::string>& revListReverse, size_t batch)
    {
        std::vector<std::string> out; if (batch == 0) batch = 1;
        for (size_t i = batch - 1; i < revListReverse.size(); i += batch) out.push_back(revListReverse[i]);
        if (!revListReverse.empty() && (out.empty() || out.back() != revListReverse.back())) out.push_back(revListReverse.back());
        return out;
    }
    int64_t HostedImportStoreBytes(const std::vector<std::string>& lines)
    {
        int64_t kib = 0;
        for (const auto& line : lines) { const auto colon = line.find(':'); if (colon == std::string::npos) continue; const auto key = line.substr(0, colon); if (key == "size" || key == "size-pack") kib += std::strtoll(line.c_str() + colon + 1, nullptr, 10); }
        return kib * 1024;
    }
    std::string HostedImportReportJson(const HostedImportOutcome& o)
    {
        nlohmann::json j{{"commit", o.commit}, {"branch", o.branch}, {"scan", nlohmann::json::parse(o.scanJson.empty() ? "{}" : o.scanJson)}, {"rewritten", o.rewritten},
                         {"movedFiles", o.movedFiles}, {"movedBytes", o.movedBytes}, {"lfsObjects", o.lfsObjects}, {"lfsBytes", o.lfsBytes}};
        if (o.bundleSize > 0 && !o.bundleSha256.empty()) j["originalBundle"] = {{"size", o.bundleSize}, {"sha256", o.bundleSha256}};
        return j.dump();
    }
}
```

Add `"HostedImport.cpp"` to `Module.manifest`'s `common` sources and `#include <SmithAgent/HostedImport.h>` to the test.

- [ ] **Step 6: Build and run the tests**

Run: `.\RunTests.ps1`
Expected: `ALL 7 TEST PROJECT(S) PASSED` with the new checks counted in `SmithProtocolTest` and `SmithHostedAgentTest`.

- [ ] **Step 7: Commit**

```bash
git add Modules/SmithProtocol Modules/SmithAgent/HostedPolicy.cpp Modules/SmithAgent/HostedImport.h Modules/SmithAgent/HostedImport.cpp Modules/SmithAgent/Module.manifest Tests/SmithProtocolTest/Main.cpp Tests/SmithHostedAgentTest/Main.cpp
git commit --author="Claude Fable 5 <noreply@anthropic.com>" -m "feat(agent): the import job's wire type, validation and pure helpers

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 13: Agent: run the import job

**Files:**
- Modify: `Modules/SmithAgent/HostedImport.h/.cpp` (`RunHostedImport`)
- Modify: `Modules/SmithAgent/HostedAgent.cpp` (the `smith-import` label; `ImportJob`; `mirror` with `allRefs`; redaction)
- Test: `Tests/SmithHostedAgentTest/Main.cpp`

**Interfaces:**
- Consumes: `HostedGitAuthEnv`, `HostedGitFailureReason`, `HostedClassifyGitFailure`, `HostedScanReport` (`HostedAgent.h`), `HostedTransport::PostBytes/Post` (`HostedTransport.h`), the job runner's `run` and `log` lambdas (`HostedAgent.cpp:495-576`).
- Produces (`HostedImport.h`):

```cpp
    struct HostedImportRequest { std::string source, artifactsRemote, artifactsToken, smithRemote, lfsTicket, scratch; int64_t thresholdBytes = 0, maxRepoBytes = 0; };
    // argv, cwd, env, captured stdout lines (may be null), captured stderr lines (may be null); the process exit code (-1: could not run).
    using HostedImportRun = std::function<int(const std::vector<std::string>&, const std::string&, const std::map<std::string, std::string>&, std::vector<std::string>*, std::vector<std::string>*)>;
    using HostedImportLog = std::function<void(const std::string&)>;
    // Uploads the bundle at `path` (`size` bytes); fills `sha256`; false when it could not be stored.
    using HostedImportUpload = std::function<bool(const std::string& path, int64_t size, std::string& sha256)>;
    struct HostedImportResult { bool ok = false, oversize = false; std::string failure, message; HostedImportOutcome outcome; };
    // The steps of spec §5 against a mirror clone under `request.scratch`. `lfsAvailable` false skips the LFS steps and the
    // rewrite, failing instead when a blob over the threshold exists (the label normally prevents this).
    HostedImportResult RunHostedImport(const HostedImportRequest& request, const HostedImportRun& run, const HostedImportLog& log, const HostedImportUpload& upload, bool lfsAvailable);
```

- [ ] **Step 1: Write the failing tests**

In `Tests/SmithHostedAgentTest/Main.cpp`, a real-git block (the file's existing blocks show the pattern: a temp root, a `git` lambda running `Process`, a `source` repository with commits):

```cpp
    // Real git: an import mirrors a source, finds large blobs, bundles the original, rewrites to LFS (when git-lfs is here),
    // pushes to a local "Artifacts" and reports. git-lfs absent: the rewrite steps are skipped and reported as skipped.
    {
        using namespace Smith; namespace gfs = std::filesystem;
        const gfs::path root = gfs::temp_directory_path() / ("smith-import-" + MakeUuid()); gfs::create_directories(root);
        auto run = [&](const std::vector<std::string>& argv, const std::string& cwd, const std::map<std::string, std::string>& env, std::vector<std::string>* out, std::vector<std::string>* errors) {
            Process process; ProcessOptions options; options.argv = argv; options.workingDir = cwd; options.timeoutSeconds = 300; options.envOverride = env; options.stopWithParent = true;
            if (!process.Start(options, [&](bool isError, const std::string& line) { if (isError) { if (errors) errors->push_back(line); } else if (out) out->push_back(line); })) return -1;
            return process.Wait();
        };
        auto git = [&](const gfs::path& cwd, std::vector<std::string> args, std::vector<std::string>* out = nullptr) { args.insert(args.begin(), "git"); return run(args, cwd.string(), {{"GIT_TERMINAL_PROMPT", "0"}}, out, nullptr); };
        std::vector<std::string> version; const bool lfs = run({"git", "lfs", "version"}, root.string(), {}, &version, nullptr) == 0;
        if (!lfs) std::printf("git-lfs not installed: the import rewrite steps are skipped\n");
        // A source with a small file, a 12 MB file and a tag.
        const gfs::path source = root / "source"; gfs::create_directories(source);
        CHECK(git(source, {"init", "-q", "-b", "main"}) == 0 && git(source, {"config", "user.email", "t@example.test"}) == 0 && git(source, {"config", "user.name", "t"}) == 0);
        { std::ofstream(source / "a.txt") << "small\n"; std::ofstream big(source / "Assets" / "big.bin", std::ios::binary); }
        gfs::create_directories(source / "Assets"); { std::ofstream big(source / "Assets" / "big.bin", std::ios::binary); std::string chunk(1024 * 1024, 'x'); for (int i = 0; i < 12; ++i) big.write(chunk.data(), (std::streamsize)chunk.size()); }
        CHECK(git(source, {"add", "."}) == 0 && git(source, {"commit", "-q", "-m", "one"}) == 0 && git(source, {"tag", "v1"}) == 0);
        // A bare "Artifacts" the mirror is pushed to, and a bare Smith stand-in only for the LFS URL shape (LFS push is stubbed by lfsAvailable=false when absent).
        const gfs::path artifacts = root / "artifacts.git"; CHECK(git(root, {"init", "-q", "--bare", artifacts.string()}) == 0);
        HostedImportRequest request; request.source = source.string(); request.artifactsRemote = artifacts.string(); request.artifactsToken = ""; request.smithRemote = "https://exp.example.test/git/p.git"; request.lfsTicket = "smith_git_t";
        request.scratch = (root / "job").string(); request.thresholdBytes = 10 * 1024 * 1024; request.maxRepoBytes = 1024LL * 1024 * 1024;
        gfs::create_directories(request.scratch);
        std::vector<std::string> logged; std::string uploadedSha; int64_t uploadedSize = 0;
        auto upload = [&](const std::string& path, int64_t size, std::string& sha256) { uploadedSize = size; sha256 = std::string(64, 'f'); uploadedSha = sha256; return gfs::exists(path) && size > 0; };
        auto result = RunHostedImport(request, run, [&](const std::string& line) { logged.push_back(line); }, upload, lfs);
        if (lfs) {
            CHECK(result.ok && result.outcome.rewritten && result.outcome.movedFiles == 1 && result.outcome.movedBytes == 12 * 1024 * 1024);
            CHECK(uploadedSize > 0 && result.outcome.bundleSha256 == uploadedSha && result.outcome.bundleSize == uploadedSize);
            std::vector<std::string> attrs; CHECK(git(root, {"--git-dir=" + artifacts.string(), "show", "HEAD:.gitattributes"}, &attrs) == 0 && !attrs.empty());   // the rewrite tracked the file
            std::vector<std::string> pointer; CHECK(git(root, {"--git-dir=" + artifacts.string(), "show", "HEAD:Assets/big.bin"}, &pointer) == 0 && !pointer.empty() && pointer[0].rfind("version https://git-lfs", 0) == 0);
        } else {
            CHECK(!result.ok && result.message.find("over the threshold") != std::string::npos);
        }
        std::vector<std::string> tags; CHECK(git(root, {"--git-dir=" + artifacts.string(), "tag"}, &tags) == 0 && (!lfs || (tags.size() == 1 && tags[0] == "v1")));
        // No large blobs: untouched history, no bundle, the scan carries the paths, the commit is the source's.
        const gfs::path plain = root / "plain"; gfs::create_directories(plain);
        CHECK(git(plain, {"init", "-q", "-b", "main"}) == 0 && git(plain, {"config", "user.email", "t@example.test"}) == 0 && git(plain, {"config", "user.name", "t"}) == 0);
        { std::ofstream(plain / "smith.json") << "{\"project\":{\"name\":\"Plain\"},\"buildProducts\":[]}\n"; }
        CHECK(git(plain, {"add", "."}) == 0 && git(plain, {"commit", "-q", "-m", "one"}) == 0);
        std::vector<std::string> head; CHECK(git(plain, {"rev-parse", "HEAD"}, &head) == 0 && head.size() == 1);
        const gfs::path artifacts2 = root / "artifacts2.git"; CHECK(git(root, {"init", "-q", "--bare", artifacts2.string()}) == 0);
        request.source = plain.string(); request.artifactsRemote = artifacts2.string(); request.scratch = (root / "job2").string(); gfs::create_directories(request.scratch);
        uploadedSize = 0;
        result = RunHostedImport(request, run, [&](const std::string& line) { logged.push_back(line); }, upload, lfs);
        CHECK(result.ok && !result.outcome.rewritten && result.outcome.commit == head[0] && result.outcome.branch == "main" && uploadedSize == 0);
        CHECK(nlohmann::json::parse(result.outcome.scanJson)["smithJson"].is_string() && nlohmann::json::parse(result.outcome.scanJson)["paths"].size() == 1);
        // Oversize: measured before any rewrite; nothing pushed, nothing bundled.
        request.maxRepoBytes = 1; request.scratch = (root / "job3").string(); gfs::create_directories(request.scratch);
        result = RunHostedImport(request, run, [&](const std::string&) {}, upload, lfs);
        CHECK(!result.ok && result.oversize && result.failure == "oversize" && uploadedSize == 0);
        // Measured again after the rewrite: a limit the rewritten store fits but the original did not goes to Artifacts.
        if (lfs) {
            request.source = source.string(); request.artifactsRemote = (root / "artifacts3.git").string(); CHECK(git(root, {"init", "-q", "--bare", request.artifactsRemote}) == 0);
            request.scratch = (root / "job4").string(); gfs::create_directories(request.scratch); request.maxRepoBytes = 6 * 1024 * 1024;   // the 12 MB blob is over, the pointer repository is under
            result = RunHostedImport(request, run, [&](const std::string&) {}, upload, lfs);
            CHECK(result.ok && result.outcome.rewritten && !result.oversize);
        }
        // Existing LFS objects move without a rewrite (the source tracks *.png below the threshold).
        if (lfs) {
            const gfs::path tracked = root / "tracked"; gfs::create_directories(tracked);
            CHECK(git(tracked, {"init", "-q", "-b", "main"}) == 0 && git(tracked, {"config", "user.email", "t@example.test"}) == 0 && git(tracked, {"config", "user.name", "t"}) == 0 && git(tracked, {"lfs", "install", "--local"}) == 0 && git(tracked, {"lfs", "track", "*.png"}) == 0);
            { std::ofstream png(tracked / "icon.png", std::ios::binary); std::string bytes(2 * 1024 * 1024, 'p'); png.write(bytes.data(), (std::streamsize)bytes.size()); }
            CHECK(git(tracked, {"add", "."}) == 0 && git(tracked, {"commit", "-q", "-m", "png"}) == 0);
            std::vector<std::string> trackedHead; CHECK(git(tracked, {"rev-parse", "HEAD"}, &trackedHead) == 0);
            request.source = tracked.string(); request.artifactsRemote = (root / "artifacts4.git").string(); CHECK(git(root, {"init", "-q", "--bare", request.artifactsRemote}) == 0);
            request.scratch = (root / "job5").string(); gfs::create_directories(request.scratch); request.maxRepoBytes = 1024LL * 1024 * 1024;
            // The LFS push goes to request.smithRemote, which does not exist here: RunHostedImport reports that step's failure
            // only after fetching the objects, so the outcome before the push is what this checks (lfsObjects counted).
            result = RunHostedImport(request, run, [&](const std::string&) {}, upload, lfs);
            CHECK(!result.ok && !result.outcome.rewritten && result.outcome.commit == trackedHead[0] && result.outcome.lfsObjects == 1 && result.message.find("large files to Smith") != std::string::npos);
        }
        std::error_code ec; gfs::remove_all(root, ec);
    }
```

- [ ] **Step 2: Build the tests to verify they fail**

Run: `.\RunTests.ps1`
Expected: `RunHostedImport` undefined.

- [ ] **Step 3: `RunHostedImport`**

Append to `HostedImport.cpp` (includes: `<filesystem>`, `<fstream>`, `<functional>`, `<SmithAgent/HostedAgent.h>` for `HostedGitAuthEnv`, `HostedGitFailureReason`, `HostedClassifyGitFailure`, `HostedScanReport`):

```cpp
namespace Smith {
    namespace {
        namespace fs = std::filesystem;
        const std::map<std::string, std::string> kQuiet = {{"GIT_TERMINAL_PROMPT", "0"}, {"GIT_CONFIG_NOSYSTEM", "1"}, {"GIT_LFS_SKIP_SMUDGE", "1"}};
        std::map<std::string, std::string> Isolated(std::map<std::string, std::string> env, const std::string& globalConfig) {
            for (const auto& [k, v] : kQuiet) env.emplace(k, v);
            env["GIT_CONFIG_GLOBAL"] = globalConfig;   // an empty file: no credential helper, no user hooks
            return env;
        }
        std::string FirstLine(const std::vector<std::string>& lines) { return lines.empty() ? std::string() : lines[0]; }
    }
    HostedImportResult RunHostedImport(const HostedImportRequest& request, const HostedImportRun& run, const HostedImportLog& log, const HostedImportUpload& upload, bool lfsAvailable)
    {
        HostedImportResult result;
        auto fail = [&](const std::string& message, const std::string& failure = "") { result.ok = false; result.message = message; result.failure = failure; return result; };
        const fs::path scratch = request.scratch; const std::string mirror = (scratch / "repo.git").string();
        const std::string globalConfig = (scratch / "empty.gitconfig").string(); { std::ofstream(globalConfig) << ""; }
        const auto isolated = Isolated({}, globalConfig);
        // 1. Mirror-clone the source with the machine's own login (the only step that may use it).
        log("Copying " + request.source);
        std::vector<std::string> errors;
        if (run({"git", "clone", "--mirror", "--", request.source, mirror}, scratch.string(), HostedGitAuthEnv(request.source, ""), nullptr, &errors) != 0) {
            const auto reason = HostedGitFailureReason(errors);
            return fail("Repository copy failed" + (reason.empty() ? std::string() : ": " + reason), HostedClassifyGitFailure(errors));
        }
        auto git = [&](std::vector<std::string> args, std::vector<std::string>* out = nullptr, std::vector<std::string>* err = nullptr, std::map<std::string, std::string> env = {}) {
            args.insert(args.begin(), {"git", "--git-dir=" + mirror}); return run(args, scratch.string(), Isolated(std::move(env), globalConfig), out, err);
        };
        std::vector<std::string> lines;
        // The default branch: the source's HEAD (a mirror keeps it), else "main" when present, else the first head.
        std::string branch; if (git({"symbolic-ref", "--short", "HEAD"}, &lines) == 0 && !lines.empty()) branch = lines[0];
        lines.clear(); if (git({"for-each-ref", "--format=%(refname:short)", "refs/heads/"}, &lines) != 0) return fail("Could not list the repository's branches");
        if (branch.empty() || std::find(lines.begin(), lines.end(), branch) == lines.end()) branch = std::find(lines.begin(), lines.end(), "main") != lines.end() ? "main" : FirstLine(lines);
        if (branch.empty()) return fail("The repository has no branches");
        // 2. Measure: over the limit before any rewrite is oversize at once (the coordinator hosts it on a machine instead).
        lines.clear(); if (git({"count-objects", "-v"}, &lines) != 0) return fail("Repository size check failed");
        int64_t bytes = HostedImportStoreBytes(lines);
        if (request.maxRepoBytes > 0 && bytes > request.maxRepoBytes) { result.oversize = true; return fail("Repository is " + std::to_string(bytes / (1024 * 1024)) + " MiB, over the " + std::to_string(request.maxRepoBytes / (1024 * 1024 * 1024)) + " GiB limit for Smith's storage", "oversize"); }
        // 3. Existing LFS objects: everything ever referenced, so nothing is left behind on GitHub.
        lines.clear(); const bool usesLfs = lfsAvailable && git({"lfs", "ls-files", "--all", "--name-only"}, &lines) == 0 && !lines.empty();
        if (usesLfs) {
            log("Fetching the repository's " + std::to_string(lines.size()) + " existing large files");
            errors.clear(); if (git({"lfs", "fetch", "--all", "origin"}, nullptr, &errors, HostedGitAuthEnv(request.source, "")) != 0) return fail("Could not fetch the repository's existing large files from its source: " + HostedGitFailureReason(errors));
            result.outcome.lfsObjects = (int64_t)lines.size();
        }
        // 4. Blobs over the threshold anywhere in history.
        std::vector<std::string> objects; if (git({"rev-list", "--objects", "--all"}, &objects) != 0) return fail("Could not list the repository's objects");
        { std::ofstream in(scratch / "objects.txt"); for (const auto& o : objects) in << o << '\n'; }
        lines.clear();
        if (run({"sh", "-c", "git --git-dir='" + mirror + "' cat-file --batch-check='%(objectsize) %(objectname) %(rest)' < '" + (scratch / "objects.txt").string() + "'"}, scratch.string(), isolated, &lines, nullptr) != 0) return fail("Could not measure the repository's files");
        const auto large = HostedImportLargeBlobs(lines, request.thresholdBytes);
        if (!large.empty()) {
            if (!lfsAvailable) return fail(std::to_string(large.size()) + " file(s) are over the threshold and git-lfs is not installed on this machine");
            // 5. The original history first, then the rewrite.
            const fs::path bundle = scratch / "original.bundle";
            log("Keeping the original history (" + std::to_string(large.size()) + " files over the threshold will move to large files)");
            if (git({"bundle", "create", bundle.string(), "--all"}) != 0) return fail("Could not bundle the original history");
            std::string sha256; const int64_t size = (int64_t)fs::file_size(bundle);
            if (!upload(bundle.string(), size, sha256)) return fail("Could not store the original history; nothing was rewritten");
            result.outcome.bundleSize = size; result.outcome.bundleSha256 = sha256;
            log("Moving files over the threshold to large files (rewriting history)");
            errors.clear();
            auto migrate = HostedImportMigrateArgv(request.thresholdBytes); migrate.insert(migrate.begin() + 1, "--git-dir=" + mirror);
            if (run(migrate, scratch.string(), isolated, nullptr, &errors) != 0) {
                // A git-lfs that refuses a bare repository: a working clone with every ref, migrated there, pushed back into the mirror.
                const std::string work = (scratch / "work").string(); errors.clear();
                if (run({"git", "clone", "-q", "--", mirror, work}, scratch.string(), isolated, nullptr, &errors) != 0) return fail("Could not prepare the rewrite: " + HostedGitFailureReason(errors));
                if (run({"git", "fetch", "-q", "origin", "+refs/heads/*:refs/heads/*", "+refs/tags/*:refs/tags/*"}, work, isolated, nullptr, &errors) != 0) return fail("Could not prepare the rewrite: " + HostedGitFailureReason(errors));
                if (run(HostedImportMigrateArgv(request.thresholdBytes), work, isolated, nullptr, &errors) != 0) return fail("Rewriting history failed: " + HostedGitFailureReason(errors));
                if (run({"git", "push", "-q", "--mirror", "--", mirror}, work, isolated, nullptr, &errors) != 0) return fail("Could not place the rewritten history: " + HostedGitFailureReason(errors));
            }
            result.outcome.rewritten = true; result.outcome.movedFiles = (int64_t)large.size();
            for (const auto& b : large) result.outcome.movedBytes += b.size;
            result.outcome.lfsObjects += (int64_t)large.size();
            lines.clear(); if (git({"count-objects", "-v"}, &lines) != 0) return fail("Repository size check failed");
            bytes = HostedImportStoreBytes(lines);
            if (request.maxRepoBytes > 0 && bytes > request.maxRepoBytes) { result.oversize = true; return fail("Repository is still " + std::to_string(bytes / (1024 * 1024)) + " MiB after moving large files, over the limit for Smith's storage", "oversize"); }
        }
        // The default branch's tip and scan after any rewrite.
        lines.clear(); if (git({"rev-parse", "refs/heads/" + branch}, &lines) != 0 || lines.empty()) return fail("Could not read the default branch");
        result.outcome.commit = lines[0]; result.outcome.branch = branch;
        std::vector<std::string> paths; if (git({"ls-tree", "-r", "--name-only", result.outcome.commit}, &paths) != 0) return fail("Could not list the repository's files");
        std::vector<std::string> smith; const bool hasSmithJson = git({"show", result.outcome.commit + ":smith.json"}, &smith) == 0;
        std::string smithText; for (const auto& l : smith) { smithText += l; smithText += '\n'; }
        try { result.outcome.scanJson = HostedScanReport(result.outcome.commit, branch, hasSmithJson, smithText, paths); } catch (const std::exception& e) { return fail(e.what()); }
        // 6. Large files to Smith: every object for every ref, through lfs.url and the ticket (HostedGitAuthEnv sets both).
        if (result.outcome.lfsObjects > 0) {
            log("Sending " + std::to_string(result.outcome.lfsObjects) + " large files to Smith");
            auto lfsEnv = HostedGitAuthEnv(request.smithRemote, request.lfsTicket); lfsEnv["GIT_CONFIG_COUNT"] = std::to_string(std::stoi(lfsEnv.count("GIT_CONFIG_COUNT") ? lfsEnv["GIT_CONFIG_COUNT"] : "0") + 1);
            const auto n = std::stoi(lfsEnv["GIT_CONFIG_COUNT"]) - 1; lfsEnv["GIT_CONFIG_KEY_" + std::to_string(n)] = "lfs.url"; lfsEnv["GIT_CONFIG_VALUE_" + std::to_string(n)] = request.smithRemote + "/info/lfs";
            errors.clear();
            if (git({"lfs", "push", "--all", request.smithRemote}, nullptr, &errors, lfsEnv) != 0) {
                const auto reason = HostedGitFailureReason(errors);
                return fail("Could not send the large files to Smith" + (reason.empty() ? std::string() : ": " + reason));
            }
            lines.clear(); if (git({"lfs", "ls-files", "--all", "--size"}, &lines) == 0) { int64_t total = 0; for (const auto& l : lines) { /* "oid * path (12 MB)": sizes are approximate here; the coordinator's record is authoritative */ (void)l; } result.outcome.lfsBytes = total ? total : result.outcome.movedBytes; }
        }
        // 7. Git to Artifacts: the whole mirror; in slices when one push is refused for size.
        log("Sending the repository to Smith's storage");
        auto pushEnv = HostedGitAuthEnv(request.artifactsRemote, request.artifactsToken);
        errors.clear();
        if (git({"push", "--mirror", "--", request.artifactsRemote}, nullptr, &errors, pushEnv) != 0) {
            const auto reason = HostedGitFailureReason(errors);
            if (HostedClassifyGitFailure(errors) == "repo_access" || reason.find("not found") != std::string::npos) return fail("Smith's storage refused the push: " + reason);
            log("One push was refused (" + reason + "); sending the history in slices");
            lines.clear(); if (git({"for-each-ref", "--format=%(refname)", "refs/heads/"}, &lines) != 0) return fail("Could not list the branches to push");
            for (const auto& ref : lines) {
                std::vector<std::string> revs; if (git({"rev-list", "--reverse", ref}, &revs) != 0) return fail("Could not walk " + ref);
                for (size_t batch = 200; ; batch = batch / 2) {
                    bool pushed = true;
                    for (const auto& sha : HostedImportSlices(revs, batch)) { errors.clear(); if (git({"push", "--", request.artifactsRemote, sha + ":" + ref}, nullptr, &errors, pushEnv) != 0) { pushed = false; break; } }
                    if (pushed) break;
                    if (batch <= 1) return fail("Smith's storage refused " + ref + " even one commit at a time: " + HostedGitFailureReason(errors));
                }
            }
            errors.clear(); if (git({"push", "--tags", "--", request.artifactsRemote}, nullptr, &errors, pushEnv) != 0) return fail("Tag push failed: " + HostedGitFailureReason(errors));
        }
        result.ok = true; result.message = result.outcome.rewritten ? "Imported; " + std::to_string(result.outcome.movedFiles) + " file(s) moved to large files" : "Imported";
        return result;
    }
}
```

Notes for the implementer: `HostedGitAuthEnv(url, token)` already yields `GIT_CONFIG_COUNT`/`KEY_n`/`VALUE_n` entries; the LFS block appends `lfs.url` the way `HostedLfsEnv` does in `HostedAgent.cpp` (reuse `HostedLfsEnv` by building a `JobSpec` with only `lfs` set, if simpler). The `sh -c` for `cat-file --batch-check` needs a shell on Windows too: use `HostedShellArgv` if the agent has one, otherwise feed the object list through `ProcessOptions::stdinFile` if `Process` supports it; the LFS branch's `Process` gained `stdoutFile`, so adding `stdinFile` in `Process_Windows.cpp`/`Process_Posix.cpp` (both!) is the clean path and avoids `sh`. The test above passes the token as empty (a local path remote), so `HostedGitAuthEnv` yields the prompt-only map.

- [ ] **Step 4: The job in `HostedAgent.cpp`**

Label: in the label block (line ~199), `if(std::find(labels.begin(),labels.end(),"git-lfs")!=labels.end()&&std::find(labels.begin(),labels.end(),"smith-import")==labels.end())labels.push_back("smith-import");   // ... and import repositories into Smith's storage, moving large files to LFS (HostedImport.h)`. Dispatch: `if(spec.kind=="host")result=HostJob(spec,lease,job,run,log); else if(spec.kind=="import")result=ImportJob(spec,lease,job,run,log); else {`. Redaction (line ~447): `if(!spec.import.artifactsToken.empty())secrets.push_back(spec.import.artifactsToken); if(!spec.lfs.authToken.empty())secrets.push_back(spec.lfs.authToken);`. The job:

```cpp
    template<class Run,class Log> Json ImportJob(const JobSpec& spec,const Json& lease,const fs::path& job,Run& run,Log& log) {
        HostedImportRequest request; request.source=spec.import.source; request.artifactsRemote=spec.import.artifactsRemote; request.artifactsToken=spec.import.artifactsToken;
        request.smithRemote=spec.import.smithRemote; request.lfsTicket=spec.lfs.authToken; request.scratch=(job/"import").string(); request.thresholdBytes=spec.import.thresholdBytes; request.maxRepoBytes=spec.import.maxRepoBytes;
        HostedSecureDirectory(request.scratch);
        const std::map<std::string,std::string> leaseHeaders={{"X-Smith-Attempt-Id",lease.value("attemptId","")},{"X-Smith-Lease-Token",lease.value("leaseToken","")}};
        auto upload=[&](const std::string& path,int64_t size,std::string& sha256){
            std::ifstream in(path,std::ios::binary); int part=0; int64_t remaining=size; Sha256 hasher;
            while(remaining>0){
                const auto want=(size_t)std::min<int64_t>(5*1024*1024,remaining); std::string chunk(want,'\0'); in.read(chunk.data(),(std::streamsize)want); chunk.resize((size_t)in.gcount()); if(chunk.empty())return false;
                hasher.Update(chunk); ++part; bool stored=false;
                for(int attempt=0;attempt<3;++attempt){ const auto r=m_transport.PostBytes("/jobs/"+spec.jobId+"/blobs/"+spec.import.originalBlob+"?part="+std::to_string(part),chunk,"application/octet-stream",leaseHeaders,300,5*1024*1024+1024); if(r.Ok()&&r.body.value("accepted",false)){stored=true;break;} if(r.status>=400&&r.status<500)break; std::this_thread::sleep_for(std::chrono::seconds(2)); }
                if(!stored)return false; remaining-=(int64_t)chunk.size();
            }
            sha256=hasher.HexDigest();
            const auto done=m_transport.Post("/jobs/"+spec.jobId+"/blobs/"+spec.import.originalBlob+"/complete",Json{{"size",size},{"sha256",sha256}});
            return done.Ok()&&done.body.value("accepted",false);
        };
        const bool lfs=run({"git","lfs","version"},job,60,{{"GIT_TERMINAL_PROMPT","0"}},nullptr,nullptr,true)==0;
        const auto outcome=RunHostedImport(request,[&](const std::vector<std::string>& argv,const std::string& cwd,const std::map<std::string,std::string>& env,std::vector<std::string>* out,std::vector<std::string>* errors){ return run(argv,fs::path(cwd),3600,env,out,errors,out!=nullptr); },[&](const std::string& line){log(false,line);},upload,lfs);
        Json result={{"status",outcome.ok?"success":"failed"},{"exitCode",outcome.ok?0:1},{"durationMs",0},{"message",outcome.message}};
        if(!outcome.failure.empty())result["failure"]=outcome.failure;
        if(outcome.ok){result["commit"]=outcome.outcome.commit;result["import"]=Json::parse(HostedImportReportJson(outcome.outcome));}
        std::error_code ec; fs::remove_all(request.scratch,ec);
        return result;
    }
```

`Sha256` is whatever the agent already uses to hash artifacts before `Upload` (`HostedAgent.cpp` computes a SHA-256 for artifact uploads; reuse that helper by name). `m_transport.Post`'s header set is the node credential; the lease headers are sent with the completion through the same `PostBytes`-style call if `Post` cannot carry extra headers (add an overload with headers, mirroring `PostBytes`). The `mirror` job: when `spec.mirror.allRefs`, replace the single-branch push by `git push --mirror -- <remote>` (no tag push, no branch verification by `ls-remote`; verify instead that `ls-remote` lists `refs/heads/<branch>` at `pushed`), with the same size and blob checks for an Artifacts remote.

- [ ] **Step 5: Build, run the tests**

Run: `.\Build.ps1` then `.\RunTests.ps1`
Expected: both succeed; `SmithHostedAgentTest` prints `git-lfs not installed` only on a box without git-lfs (the development machine has it: the full path is exercised).

- [ ] **Step 6: Commit**

```bash
git add Modules/SmithAgent Tests/SmithHostedAgentTest/Main.cpp
git commit --author="Claude Fable 5 <noreply@anthropic.com>" -m "feat(agent): the import job: mirror, measure, bundle, rewrite to LFS, push objects and git

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 14: Documentation, the end-to-end drill, and the whole-tree verification

**Files:**
- Modify: `docs/user-guide.md` (feeds `help.html` through `npm run build:help`), `docs/cloudflare/operations.md`
- Create: `cloudflare/coordinator/tools/import-e2e.ps1`
- Test: `npm run verify`, `Build.ps1`, `RunTests.ps1`, the drill

**Interfaces:**
- Consumes: everything above.
- Produces: the help sections "Import from GitHub", "Where projects live", "Copies and budgets", the rewrite rule under "Large files"; the operations notes; a drill that imports a repository with a 15 MB and a 40 MB file through `wrangler dev --local` against a local `git http-backend`.

- [ ] **Step 1: User guide**

In `docs/user-guide.md`, add after the "Large files (Git LFS)" section (keep the heading levels the file uses):

```markdown
## Where projects live

A project copied into Smith has a home: **Smith's storage** (Cloudflare Artifacts, reached only through this site's
git address) or **a build machine**. Storage is the home whenever Smith has it and the repository is under 1 GB; a
repository too large for storage lives on a machine that keeps copies, and its card says so. Whichever the home,
the clone address is the same, `https://<site>/git/<project>.git`, with a Smith token or git credential as the
password, and large files (Git LFS) work with no setup.

A project on a machine shows **Move to storage** (owners and admins): every branch and tag is pushed into storage,
and the machines' copies become copies. A project in storage whose repository went missing shows **Restore to
storage**, which pushes a machine's current copy back.

## Copies and budgets

Build machines switched on to **Keep copies here** hold copies of the workspace's repositories and large files, as
a second place beside the home. Each machine has a budget (the workspace default from Settings → Copies, or its
own, set on its card), and Smith places each item on as many machines as Settings → Copies asks for (two by
default), choosing the machines with the most unused budget. A machine over its budget hands one item at a time to
the others. The card says what a machine holds ("uses 12 GB of 50 GB: 8 repositories, 340 large files") and when
it is full; a project's card says which machines hold it, and Settings → Copies lists what has fewer copies than
asked, with the machines that are full.

## Import from GitHub

**Projects → Import from GitHub** (owners and admins) copies every repository of a GitHub organisation into Smith's
storage. Pick the organisation (from your GitHub link, or the workspace token in Settings, or type its name), tick
the repositories, and Import. Each becomes a project behind this site's git address, with its `smith.json` read
and its build actions ready.

Files over the threshold (Settings → Large files, 10 MB unless you change it; at most 32 MB, the largest file
storage takes) are moved to large files, whether or not the repository used Git LFS before. That rewrites the
repository's history, so such a repository is **detached from GitHub** (Pull and Push would never match again) and
its original history is kept as a bundle you can download from the card. Repositories with nothing over the
threshold are imported as they are and stay linked to GitHub unless you untick "Stay linked".

The dialog shows progress and lets you Retry a repository that failed or Cancel what has not finished. A repository
over 1 GB after the rewrite goes to a build machine instead. Import needs an online build machine whose agent is
current and has git-lfs installed; a queued import says which machine to update.
```

Under the existing "Large files" section add: `Files over the import threshold are moved to large files when a repository is imported from GitHub; see Import from GitHub.`

- [ ] **Step 2: Operations**

In `docs/cloudflare/operations.md`, after the large-files paragraphs:

```markdown
Projects whose home is Cloudflare Artifacts are served through `/git/<project>.git` by proxy: the Worker holds
repo-scoped Artifacts tokens in the workspace object's `artifacts_tokens` table (read tokens an hour, write tokens
ten minutes) and passes smart-HTTP requests through; machines fetch their copies through the same address with a
ticket and never see an Artifacts token. Artifacts down means reads fall over to a machine holding a current copy
and pushes are refused with "Smith's storage is unreachable". No bundle backups are taken for Artifacts homes; the
original history of a rewritten import is kept under `backups/<workspace>/<repoUuid>/original-<jobId>.bundle`
(a `git_backups` row of kind `original`, counted in the backup budget, downloadable from the card).

Copies on machines share one switch and one budget per machine (`nodes.copy_budget_bytes`, NULL for the workspace
default `copyBudgetBytes`); the planner (`copies.ts`) places `copiesPerItem` copies of every repository and large
file by unused budget. The `nodes/:id/lfs` route is gone; `nodes/:id/host` takes `{ host, budgetBytes }`.

Import from GitHub queues one `import` job per repository (`required_labels: smith-import, git-lfs`; agents advertise
`smith-import` when git-lfs is on PATH). The job pushes the mirror straight to the Artifacts remote with a 2-hour
write token (the Worker's 100 MB request cap would refuse a large first push) and the large files to Smith's LFS with
a job-bound write ticket. Schema version 22 adds `imports`, `import_repos`, `job_blobs`, `artifacts_tokens`,
`nodes.copy_budget_bytes` and `meta.homes_assigned`; the first alarm after deploy assigns a home to every existing
project (`home.ts`).
```

- [ ] **Step 3: The drill**

`cloudflare/coordinator/tools/import-e2e.ps1`:

```powershell
# Imports a repository with a 15 MB and a 40 MB file through a local coordinator (`wrangler dev --local` with
# ORIGIN=http://127.0.0.1:8787, ARTIFACTS_MODE=fake and ARTIFACTS_FAKE_REMOTE pointing at the git server this script
# starts), with a real git and git-lfs client, then clones the result back through the proxy and checks both files
# smudge. Nothing is deployed and nothing reaches GitHub or Cloudflare.
#
# Usage: .\tools\import-e2e.ps1 -Origin http://127.0.0.1:8787 -Token <smith_pat_… owner token> -Workspace <64-hex id>
param([string]$Origin = 'http://127.0.0.1:8787', [Parameter(Mandatory)][string]$Token, [Parameter(Mandatory)][string]$Workspace)
$ErrorActionPreference = 'Stop'
$work = Join-Path $env:TEMP ("import-e2e-" + [guid]::NewGuid()); New-Item -ItemType Directory $work | Out-Null
$env:GIT_TERMINAL_PROMPT = '0'
# The source: a plain repository (no LFS) with two large files and one small one.
git init -q -b main "$work\src"; git -C "$work\src" config user.email e2e@example.test; git -C "$work\src" config user.name e2e
$rng = [System.Random]::new(7)
foreach ($mb in 15, 40) { $bytes = New-Object byte[] ($mb * 1MB); $rng.NextBytes($bytes); [IO.File]::WriteAllBytes("$work\src\file$mb.bin", $bytes) }
Set-Content "$work\src\README.md" 'import drill'
git -C "$work\src" add .; git -C "$work\src" commit -qm 'two large files'
# A bare repository served by git http-backend stands in for Artifacts (the fake client's remote base points here).
git init -q --bare "$work\artifacts\e2e-drill.git"; git -C "$work\artifacts\e2e-drill.git" config http.receivepack true
$server = Start-Process git -ArgumentList 'daemon','--reuseaddr','--export-all','--enable=receive-pack',"--base-path=$work\artifacts",'--port=9418' -PassThru -NoNewWindow
try {
  Write-Host "--- starting the import (the coordinator's fake Artifacts must point at git://127.0.0.1:9418)"
  $headers = @{ Authorization = "Bearer $Token"; 'Content-Type' = 'application/json' }
  $body = @{ org = 'e2e'; repos = @(@{ fullName = 'e2e/drill'; url = "file:///$($work -replace '\\','/')/src"; defaultBranch = 'main' }); thresholdBytes = 10MB; link = $false } | ConvertTo-Json -Depth 5
  $started = Invoke-RestMethod -Method Post -Uri "$Origin/api/v2/workspaces/$Workspace/imports" -Headers $headers -Body $body
  $id = $started.import.id
  for ($i = 0; $i -lt 120; $i++) {
    Start-Sleep 5
    $view = Invoke-RestMethod -Uri "$Origin/api/v2/workspaces/$Workspace/imports/$id" -Headers $headers
    $row = $view.repos[0]; Write-Host "  $($row.state) $($row.message)"
    if ($row.state -in 'done', 'failed', 'machine') { break }
  }
  if ($row.state -ne 'done' -or -not $row.rewritten) { throw "import ended as $($row.state): $($row.message)" }
  Write-Host '--- cloning back through the proxy'
  $clone = "$Origin/git/$($row.projectId).git" -replace '^(https?://)', ('$1' + $Workspace.Substring(0, 12) + ':' + $Token + '@')
  git clone -q $clone "$work\dst"
  foreach ($mb in 15, 40) {
    if ((Get-Item "$work\dst\file$mb.bin").Length -ne $mb * 1MB) { throw "file$mb.bin did not smudge" }
    if ((Get-FileHash "$work\dst\file$mb.bin").Hash -ne (Get-FileHash "$work\src\file$mb.bin").Hash) { throw "file$mb.bin differs" }
  }
  Write-Host "OK: imported, rewritten (2 files to large files), cloned back with both files (work dir $work)"
} finally { if ($server -and -not $server.HasExited) { Stop-Process -Id $server.Id } }
```

The import job clones with the machine's own login, so a `file://` source works on the machine running `smith agent` against the local coordinator (the development box). Document in the script header that `.dev.vars` needs `ARTIFACTS_MODE=fake`, `ARTIFACTS_FAKE_REMOTE=git://127.0.0.1:9418` and `ORIGIN=http://127.0.0.1:8787`, and that `isArtifactsRemote` in the agent's policy must be relaxed for the drill only through the existing `HostedArtifactsRemote` check (the drill's remote is `git://`): add an agent option `--allow-plain-artifacts-remote` honoured only when the coordinator origin is `http://127.0.0.1:*`, so production never accepts one.

- [ ] **Step 4: Whole-tree verification**

Run, in order, and paste the tails into the PR description:

```bash
cd cloudflare/coordinator && npm run verify
```

```powershell
.\Build.ps1
.\RunTests.ps1
.\tools\import-e2e.ps1 -Origin http://127.0.0.1:8787 -Token <token> -Workspace <id>   # with wrangler dev --local and a local agent running
```

Expected: verify green (typecheck, every vitest file, the dry-run deploy); `ALL 7 TEST PROJECT(S) PASSED`; the drill prints `OK`.

- [ ] **Step 5: Commit, push, open the pull request**

```bash
git add docs/user-guide.md docs/cloudflare/operations.md cloudflare/coordinator/tools/import-e2e.ps1 cloudflare/coordinator/public/help.html
git commit --author="Claude Fable 5 <noreply@anthropic.com>" -m "docs: where projects live, copies and budgets, Import from GitHub; the import drill

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
git push -u origin claude/org-import
gh pr create --repo Red-Marmoset/smith --base feature/cloudflare-experiment --head claude/org-import --title "Import a GitHub organisation: Artifacts as the home, budgeted copies on machines" --body-file <the description: the spec's summary, the verification tails, and "🤖 Generated with [Claude Code](https://claude.com/claude-code)">
```

---

## Self-review notes (checked against the spec, 2026-10-13)

**Spec coverage.** §1 home: Tasks 1, 5. §2 proxy, tokens, push detection, Artifacts down, Clone dialog: Tasks 2, 4, 10. §3 record, tips from the advertisement, copies through Smith, loss and restore, removal: Tasks 3, 4, 5, 6. §4 one switch and budget, settings, planner rules, dashboard: Tasks 1, 6, 10. §5 dialog, credentials, record, actions, job, blob route, settlement, old agents: Tasks 7, 8, 9, 11, 12, 13. §6 settings, help, operations: Tasks 10, 14. §7 error handling: the proxy outcomes (Task 4), import retries and oversize (Task 8), planner no-churn and shedding (Task 6), the upgrade pass tolerating an unreachable Artifacts (Task 5). §8 security: tokens only in the workspace object and job specs (Tasks 2, 4, 8), GitHub tokens never on machines (Task 7), the blob route lease-checked and hash-checked (Task 9), the bundle before the rewrite (Task 13), owner/admin on import (Tasks 7, 8). §9 tests: each task carries its tests; the drill is Task 14. §10 rollout: schema 22 (Tasks 4, 5), `import` kind and `JobResult` fields (Tasks 1, 12), the label (Task 13).

**Type consistency.** `ImportSpec` fields (`source, artifactsRemote, artifactsToken, smithRemote, thresholdBytes, maxRepoBytes, originalBlob`) are the same in `contracts.ts` (Task 1), `importSpecs` (Task 8), `WireTypes.h` (Task 12) and the test specs; `ImportReport`/`HostedImportOutcome` share `commit, branch, scan, rewritten, movedFiles, movedBytes, lfsObjects, lfsBytes, originalBundle{size, sha256}`; the planner's `CopyPlan.full` values are `'budget' | 'reserve' | ''` in Task 6 and in `copiesFullText` (Task 10); the node fields `copyBudgetBytes`, `copyBudgetEffective`, `copyUsageBytes`, `copiesFull` are produced in Task 6 and consumed in Task 10; `git-read`'s `backend` answer shape is the same in Tasks 4 and 5.

**Review Focus pins.** 1 → Task 4 "a failed tips fetch after a push leaves the record for the alarm". 2 → Task 6 "shedding stops at the last current copy". 3 → Task 13 "Existing LFS objects move without a rewrite". 4 → Task 13 "Measured again after the rewrite". 5 → Task 8 "re-running lists only what is not in Smith" and "retries … Retry reuses the project".

**Known judgement calls left to the implementer, in order of the task that meets them:** `Process` gaining `stdinFile` on both platforms (Task 13) versus a shell pipeline; whether `git lfs migrate import` accepts the bare mirror on the installed git-lfs (the fallback is coded); the `Sha256` helper's name in `HostedAgent.cpp` (reuse the artifact-upload hasher).
