// Import from GitHub (spec §5): the record, one job per repository, its claim, settlement of every outcome, retry and cancel.
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
type Hooks = { reconcileImportsForTest: () => Promise<void>; advanceImportClockForTest: (ms: number) => void };
const repos = [{ fullName: 'Red-Marmoset/soccer-boy', url: 'git@github.com:Red-Marmoset/soccer-boy.git', defaultBranch: 'main' }, { fullName: 'Red-Marmoset/tools', url: 'git@github.com:Red-Marmoset/tools.git', defaultBranch: 'main' }];
// Artifacts' advertisement, for the verification after a successful job.
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
const shown = async (f: Fixture, id: string) => ((await (await f.stub.execute(f.human, 'import-get', { importId: id })).json()) as { import: Shown }).import;
const settle = (f: Fixture) => runInDurableObject(f.stub, async (instance: Hooks) => { await instance.reconcileImportsForTest(); });
const report = (commit: string, over: Record<string, unknown> = {}) => ({ commit, branch: 'main', scan: { commit, branch: 'main', smithJson: null, paths: ['a.txt'], truncated: false }, rewritten: false, movedFiles: 0, movedBytes: 0, lfsObjects: 0, lfsBytes: 0, ...over });
const projects = async (f: Fixture) => (await (await f.stub.execute(f.human, 'projects', {})).json() as { projects: { id: string; kind?: string; repoUrl: string; home?: string; branch: string; commit: string | null; artifacts?: { status: string; sourceRepoUrl: string; detachedFrom?: string } }[] }).projects;

describe('Import from GitHub', () => {
  it('creates a project, an Artifacts repository, a record row and one import job per repository', async () => {
    const f = await setup();
    const started = await start(f);
    expect(started.status).toBe(201);
    const view = (await started.json() as { import: Shown }).import;
    expect(view.repos.map(r => [r.fullName, r.projectId, r.state])).toEqual([['Red-Marmoset/soccer-boy', 'soccer-boy', 'queued'], ['Red-Marmoset/tools', 'tools', 'queued']]);
    expect([...fakeArtifacts.repos.keys()].sort()).toEqual([`${fakeArtifacts.account}/${f.workspaceId.slice(0, 12)}-soccer-boy`, `${fakeArtifacts.account}/${f.workspaceId.slice(0, 12)}-tools`]);
    expect((await projects(f)).find(p => p.id === 'soccer-boy')).toMatchObject({ kind: 'repo', repoUrl: 'git@github.com:Red-Marmoset/soccer-boy.git' });   // the home switches on completion
    const jobs = (await (await f.stub.execute(f.human, 'list', {})).json() as { jobs: { kind: string; product: string; state: string }[] }).jobs.filter(j => j.kind === 'import');
    expect(jobs).toHaveLength(2); expect(jobs[0].product).toBe(IMPORT_PRODUCT);
  });
  it('only an updated agent with git-lfs takes the job, with the write token, the LFS ticket and the threshold', async () => {
    const f = await setup(); await start(f);
    const old = await f.node(['git-lfs']); const updated = await f.node(['git-lfs', IMPORT_LABEL]);
    expect((await claim(f, old)).hasJob).toBe(false);
    const waiting = (await (await f.stub.execute(f.human, 'list', {})).json() as { jobs: { kind: string; state: string; waiting?: string }[] }).jobs.find(j => j.kind === 'import' && j.state === 'queued')!;
    expect(waiting.waiting).toContain('git-lfs and an updated agent');
    const assignment = await claim(f, updated);
    expect(assignment.hasJob).toBe(true);
    const spec = assignment.envelope.spec;   // whichever of the two repositories the queue handed out first
    expect(spec.kind).toBe('import');
    expect(['soccer-boy', 'tools']).toContain(spec.projectId);
    expect(spec.import).toMatchObject({ source: `git@github.com:Red-Marmoset/${spec.projectId}.git`, smithRemote: `${origin}/git/${spec.projectId}.git`, thresholdBytes: 10 * MiB, maxRepoBytes: 1073741824, originalBlob: 'original.bundle' });
    expect(spec.import!.artifactsRemote).toMatch(/\.artifacts\.cloudflare\.net\//);
    expect(spec.import!.artifactsToken).toMatch(/^art_v1_/);
    expect(spec.lfs).toMatchObject({ url: `${origin}/git/${spec.projectId}.git` }); expect(spec.lfs!.authToken).toMatch(/^smith_git_/);
  });
  it('settles a success: Artifacts home behind Smith’s URL, actions from the report, linked to GitHub', async () => {
    const f = await setup(); const { import: view } = await (await start(f, { repos: [repos[0]] })).json() as { import: Shown };
    const node = await f.node(['git-lfs', IMPORT_LABEL]);
    const assignment = await claim(f, node);
    fakeArtifacts.setHead(`${f.workspaceId.slice(0, 12)}-soccer-boy`, 'main', sha('a')); advertise({ 'refs/heads/main': sha('a'), 'refs/tags/v1': sha('b') });
    await f.stub.execute(node, 'complete', { ...assignment.envelope.lease, result: { status: 'success', exitCode: 0, durationMs: 1, message: 'Imported', commit: sha('a'), import: report(sha('a'), { lfsObjects: 2, lfsBytes: 30 * MiB }) } });
    await settle(f);
    const row = (await shown(f, view.id)).repos.find(r => r.fullName === 'Red-Marmoset/soccer-boy')!;
    expect([row.state, row.rewritten]).toEqual(['done', false]);
    const project = (await projects(f)).find(p => p.id === 'soccer-boy')!;
    expect([project.home, project.repoUrl, project.branch, project.commit, project.artifacts?.status, project.artifacts?.sourceRepoUrl, project.artifacts?.detachedFrom]).toEqual(['artifacts', `${origin}/git/soccer-boy.git`, 'main', sha('a'), 'done', 'git@github.com:Red-Marmoset/soccer-boy.git', undefined]);
    const repo = await runInDurableObject(f.stub, (_o, state) => state.storage.sql.exec<{ state: string; refs_json: string }>("SELECT state, refs_json FROM git_repos WHERE id = 'soccer-boy'").one());
    expect([repo.state, JSON.parse(repo.refs_json)]).toEqual(['artifacts', [[sha('a'), 'refs/heads/main'], [sha('b'), 'refs/tags/v1']]]);
    expect(fakeArtifacts.tokens.size).toBeGreaterThan(0);
    expect([...fakeArtifacts.tokens.values()].filter(t => t.scope === 'write').every(t => t.revoked)).toBe(true);   // the bulk push token is revoked
  });
  it('a rewritten repository is detached, with the counts on the row', async () => {
    const f = await setup(); const { import: view } = await (await start(f, { repos: [repos[0]] })).json() as { import: Shown };
    const node = await f.node(['git-lfs', IMPORT_LABEL]); const assignment = await claim(f, node);
    fakeArtifacts.setHead(`${f.workspaceId.slice(0, 12)}-soccer-boy`, 'main', sha('c')); advertise({ 'refs/heads/main': sha('c') });
    await f.stub.execute(node, 'complete', { ...assignment.envelope.lease, result: { status: 'success', exitCode: 0, durationMs: 1, message: '', commit: sha('c'), import: report(sha('c'), { rewritten: true, movedFiles: 37, movedBytes: 2100 * MiB, originalBundle: { size: 5 * MiB, sha256: 'd'.repeat(64) } }) } });
    await settle(f);
    const row = (await shown(f, view.id)).repos.find(r => r.fullName === 'Red-Marmoset/soccer-boy')!;
    expect([row.state, row.rewritten, row.message]).toEqual(['done', true, 'History rewritten on import: 37 files (2.1 GB) moved to large files; original history kept']);
    const project = (await projects(f)).find(p => p.id === 'soccer-boy')!;
    expect([project.artifacts?.detachedFrom, project.artifacts?.sourceRepoUrl]).toEqual(['git@github.com:Red-Marmoset/soccer-boy.git', `${origin}/git/soccer-boy.git`]);
    expect((project as { importNote?: string }).importNote).toBe('History rewritten on import: 37 files (2.1 GB) moved to large files; original history kept');
  });
  it('oversize goes to a machine: a host job, the Artifacts repository deleted, the row says why', async () => {
    const f = await setup(); const { import: view } = await (await start(f, { repos: [repos[0]] })).json() as { import: Shown };
    const node = await f.node(['git-lfs', IMPORT_LABEL]); const assignment = await claim(f, node);
    await f.stub.execute(node, 'complete', { ...assignment.envelope.lease, result: { status: 'failed', exitCode: 1, durationMs: 1, message: 'Repository is 1400 MiB, over the 1 GiB limit', failure: 'oversize' } });
    await settle(f);
    const row = (await shown(f, view.id)).repos.find(r => r.fullName === 'Red-Marmoset/soccer-boy')!;
    expect([row.state, row.message]).toEqual(['machine', 'On a build machine: over 1 GB, too large for Smith’s storage']);
    expect(fakeArtifacts.repos.has(`${fakeArtifacts.account}/${f.workspaceId.slice(0, 12)}-soccer-boy`)).toBe(false);
    const jobs = (await (await f.stub.execute(f.human, 'list', {})).json() as { jobs: { kind: string; projectId: string; state: string }[] }).jobs;
    expect(jobs.find(j => j.kind === 'host' && j.projectId === 'soccer-boy')?.state).toBe('queued');
  });
  it('retries transient failures three times, then waits for Retry, which reuses the project', async () => {
    const f = await setup(); const { import: view } = await (await start(f, { repos: [repos[0]] })).json() as { import: Shown };
    const node = await f.node(['git-lfs', IMPORT_LABEL]);
    for (let attempt = 1; attempt <= 4; attempt++) {
      const assignment = await claim(f, node);
      expect(assignment.hasJob).toBe(true);
      await f.stub.execute(node, 'complete', { ...assignment.envelope.lease, result: { status: 'failed', exitCode: 1, durationMs: 1, message: 'Could not resolve host github.com' } });
      await settle(f);
      // The retry runs on the alarm, which must be set for it: a quiet workspace has nothing else to wake it.
      if (attempt === 1) { await runInDurableObject(f.stub, (instance: { alarm(): Promise<void> }) => instance.alarm()); const due = await runInDurableObject(f.stub, (_o, state) => state.storage.getAlarm()); expect(due !== null && due - Date.now() > 0 && due - Date.now() <= 61000).toBe(true); }
      await runInDurableObject(f.stub, async (instance: Hooks) => { instance.advanceImportClockForTest(20 * 60000); await instance.reconcileImportsForTest(); });
    }
    const row = (await shown(f, view.id)).repos[0];
    expect([row.state, row.message]).toEqual(['failed', 'Could not resolve host github.com']);
    expect((await claim(f, node)).hasJob).toBe(false);
    expect((await f.stub.execute(f.human, 'import-retry', { importId: view.id, fullName: 'Red-Marmoset/soccer-boy' })).status).toBe(200);
    expect((await projects(f)).filter(p => p.id.startsWith('soccer-boy'))).toHaveLength(1);
    expect((await shown(f, view.id)).repos[0].state).toBe('queued');
    expect((await claim(f, node)).hasJob).toBe(true);
  });
  it('the storage write token outlives a long queue, and a push it no longer opens is retried with a fresh one', async () => {
    const f = await setup(); const { import: view } = await (await start(f, { repos: [repos[0]] })).json() as { import: Shown };
    const node = await f.node(['git-lfs', IMPORT_LABEL]); const assignment = await claim(f, node);
    const first = assignment.envelope.spec.import!.artifactsToken;
    const expires = Number(/expires=(\d+)/.exec(first)![1]) * 1000;
    expect(expires).toBeGreaterThan(Date.now() + 23 * 3600000);   // a batch of fifty repositories waits hours on one machine
    await f.stub.execute(node, 'complete', { ...assignment.envelope.lease, result: { status: 'failed', exitCode: 1, durationMs: 1, message: 'Smith\'s storage refused the push (the write token may have lapsed); try again' } });
    await settle(f);
    expect((await shown(f, view.id)).repos[0].state).toBe('queued');
    await runInDurableObject(f.stub, async (instance: Hooks) => { instance.advanceImportClockForTest(20 * 60000); await instance.reconcileImportsForTest(); });
    const again = await claim(f, node);
    expect(again.hasJob).toBe(true);
    expect(again.envelope.spec.import!.artifactsToken).not.toBe(first);
  });
  it('re-running lists only what is not in Smith, refuses an all-known import, and cancel removes what never finished', async () => {
    const f = await setup(); const { import: view } = await (await start(f)).json() as { import: Shown };
    fakeGitHub.orgs.set('Red-Marmoset', { repos: ['Red-Marmoset/soccer-boy', 'Red-Marmoset/tools', 'Red-Marmoset/extra'] });
    for (const name of ['Red-Marmoset/soccer-boy', 'Red-Marmoset/tools', 'Red-Marmoset/extra']) fakeGitHub.repos.set(name, { defaultBranch: 'main', branches: { main: { commit: sha('a'), smithJson: null, paths: [], truncated: false } } });
    await f.stub.execute(f.human, 'put-settings', { githubToken: 'ghp_' + 'x'.repeat(30) });
    const listed = await (await f.stub.execute(f.human, 'import-repos', { org: 'Red-Marmoset', thresholdBytes: 10 * MiB })).json() as { repos: { fullName: string; inSmith: string | null }[] };
    expect(listed.repos.map(r => r.inSmith)).toEqual(['soccer-boy', 'tools', null]);
    expect((await start(f)).status).toBe(409);   // every ticked repository is already in Smith
    expect((await f.stub.execute(f.human, 'import-cancel', { importId: view.id })).status).toBe(200);
    expect((await shown(f, view.id)).state).toBe('cancelled');
    expect((await projects(f)).filter(p => p.id !== 'senet')).toHaveLength(0);
    expect(fakeArtifacts.repos.size).toBe(0);
  });
});
