// Homes of existing projects (spec §1): the upgrade pass, Move to storage, a lost Artifacts home and Restore to storage,
// and removal deleting the repository in storage.
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { setup, origin, type Fixture } from './lfs-fixture';
import { fakeArtifacts } from '../src/artifacts-repos';
import { GIT_HOST_LABEL, GIT_CLIENT_LABEL } from '../src/git-host';
import schema from '../migrations/0001_identity.sql?raw';
import browserSchema from '../migrations/0002_browser_auth.sql?raw';
import directorySchema from '../migrations/0003_workspace_directory.sql?raw';

beforeAll(async () => { await env.DB.exec(schema); await env.DB.exec(browserSchema); await env.DB.exec(directorySchema); });
afterEach(() => { vi.unstubAllGlobals(); fakeArtifacts.reset(); });
const sha = (c: string) => c.repeat(40);
const pkt = (s: string) => (s.length + 4).toString(16).padStart(4, '0') + s;
const commit = 'd45d5d166ff384710a2f63cfa24271395b689c41';   // the fixture project's pinned commit
type Lease = { jobId: string; attemptId: string; leaseToken: string; leaseExpiresAt: number; nodeId: string };
type Node = Awaited<ReturnType<Fixture['node']>>;
type Shown = { id: string; home?: string; repoUrl: string; hosted?: { status: string; state?: string; message?: string } };
type Hooks = { saveProjectForTest: (p: unknown) => void; assignHomesForTest: () => Promise<number>; reconcileArtifactsHomesForTest: () => Promise<void> };

// Artifacts' git server: the v1 advertisement from `heads`; 'down' refuses every connection.
function fakeGitServer(heads: Record<string, string>, mode: { value: string } = { value: 'ok' }) {
  const real = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new Request(input, init).url;
    if (!url.includes('.artifacts.cloudflare.net/')) return real(input, init);
    if (mode.value === 'down') throw new TypeError('connection refused');
    const lines = Object.entries(heads).map(([ref, s]) => pkt(`${s} ${ref}\n`)).join('');
    return new Response(pkt('# service=git-upload-pack\n') + '0000' + lines + '0000', { headers: { 'Content-Type': 'application/x-git-upload-pack-advertisement' } });
  });
}
const beat = (f: Fixture, node: Node, labels: string[]) => f.stub.execute(node, 'heartbeat', { hostname: 'desktop-sem', os: 'linux', arch: 'x64', labels, agentVersion: 'hosted-abcdef123456', hosting: { able: true, reason: '', free: 50 * 1024 * 1024 * 1024 } });
const claim = async (f: Fixture, node: Node) => (await (await f.stub.execute(node, 'claim', {})).json()) as { hasJob: boolean; envelope: { lease: Lease; spec: { kind: string; mirror?: { remote: string; authToken: string; branch: string; allRefs?: boolean } } } };
const projects = async (f: Fixture) => (await (await f.stub.execute(f.human, 'projects', {})).json() as { projects: Shown[] }).projects;
const HOST_LABELS = [GIT_HOST_LABEL, GIT_CLIENT_LABEL, 'smith-repo-projects'];
// A machines home: the fixture project copied onto `node` (switched on, host job claimed and completed with a report).
async function hostedOnMachine(f: Fixture, node: Node) {
  await beat(f, node, HOST_LABELS);
  expect((await f.stub.execute(f.human, 'node-host', { nodeId: node.id, host: true })).status).toBe(200);
  expect((await f.stub.execute(f.human, 'host-project', { requestId: crypto.randomUUID(), projectId: 'senet' })).status).toBe(201);
  const assignment = await claim(f, node);
  expect(assignment.envelope.spec.kind).toBe('host');
  const done = await f.stub.execute(node, 'complete', { ...assignment.envelope.lease, result: { status: 'success', exitCode: 0, durationMs: 1, message: '', host: { tips: [[commit, 'refs/heads/master']], defaultBranch: 'master', bytes: 1024 } } });
  expect(done.status).toBe(200);
}
// An Artifacts home seeded on a repository project, as an import leaves it.
async function artifactsHome(f: Fixture, id = 'soccer-boy') {
  expect((await f.stub.execute(f.human, 'add-repo-project', { source: 'git', url: `git@github.com:Red-Marmoset/${id}.git`, branch: 'master' })).status).toBe(201);
  const name = `${f.workspaceId.slice(0, 12)}-${id}`; const remote = fakeArtifacts.remote(name);
  fakeArtifacts.seed(name, 'master', sha('a'));
  await runInDurableObject(f.stub, async (instance: { seedArtifactsHomeForTest: (id: string, remote: string, tips: [string, string][]) => Promise<void> }) => { await instance.seedArtifactsHomeForTest(id, remote, [[sha('a'), 'refs/heads/master']]); });
  return { name, remote };
}

describe('homes of existing projects', () => {
  it('the upgrade pass gives legacy projects a home without moving bytes', async () => {
    const f = await setup();
    const name = `${f.workspaceId.slice(0, 12)}-senet`; const remote = fakeArtifacts.remote(name); fakeArtifacts.seed(name, 'master', sha('a'));
    await runInDurableObject(f.stub, async (instance: Hooks) => {
      instance.saveProjectForTest({ id: 'senet', name: 'Senet', repoUrl: remote, branch: 'master', commit: sha('a'), products: [], artifacts: { repo: name, namespace: 'default', remote, status: 'done', accountId: fakeArtifacts.account, source: 'smith', sourceRepoUrl: 'git@github.com:Red-Marmoset/senet.git', updatedAt: 1 } });
      fakeGitServer({ 'refs/heads/master': sha('a') });
      expect(await instance.assignHomesForTest()).toBe(1);
      expect(await instance.assignHomesForTest()).toBe(0);
    });
    const row = await runInDurableObject(f.stub, (_o, state) => state.storage.sql.exec<{ state: string; refs_json: string }>("SELECT state, refs_json FROM git_repos WHERE id = 'senet'").one());
    expect([row.state, JSON.parse(row.refs_json)]).toEqual(['artifacts', [[sha('a'), 'refs/heads/master']]]);
    const shown = (await projects(f)).find(p => p.id === 'senet')!;
    expect([shown.home, shown.repoUrl]).toEqual(['artifacts', `${origin}/git/senet.git`]);
  });
  it('Move to storage mirrors a machines home into Artifacts and flips the home; the machine copy stays a copy', async () => {
    const f = await setup(); const node = await f.node(HOST_LABELS);
    await hostedOnMachine(f, node);
    expect((await projects(f)).find(p => p.id === 'senet')!.home).toBe('machines');
    fakeGitServer({ 'refs/heads/master': commit });
    const moved = await f.stub.execute(f.human, 'move-to-storage', { projectId: 'senet', requestId: crypto.randomUUID() });
    expect(moved.status).toBe(201);
    const job = (await moved.json() as { job: { kind: string; product: string } }).job;
    expect([job.kind, job.product]).toEqual(['mirror', 'move-to-storage']);
    const assignment = await claim(f, node);
    expect(assignment.envelope.spec.kind).toBe('mirror');
    expect(assignment.envelope.spec.mirror!.remote).toMatch(/\.artifacts\.cloudflare\.net\//);
    expect([assignment.envelope.spec.mirror!.allRefs, assignment.envelope.spec.mirror!.authToken]).toEqual([true, expect.stringMatching(/^art_v1_/)]);
    fakeArtifacts.setHead(`${f.workspaceId.slice(0, 12)}-senet`, 'master', commit);
    expect((await f.stub.execute(node, 'complete', { ...assignment.envelope.lease, result: { status: 'success', exitCode: 0, durationMs: 1, message: '', commit } })).status).toBe(200);
    await runInDurableObject(f.stub, async (instance: Hooks) => { await instance.reconcileArtifactsHomesForTest(); });
    const shown = (await projects(f)).find(p => p.id === 'senet')!;
    expect([shown.home, shown.repoUrl, shown.hosted?.state]).toEqual(['artifacts', `${origin}/git/senet.git`, 'artifacts']);
    const nodes = (await (await f.stub.execute(f.human, 'nodes', {})).json() as { nodes: { hosted: { repoId: string; primary: boolean; state: string }[] }[] }).nodes;
    expect(nodes[0].hosted).toEqual([{ repoId: 'senet', primary: false, state: 'stale', bytes: expect.any(Number) }]);   // a copy now, refreshed by the planner
  });
  it('the upgrade pass runs again on the next alarm while a project is still without a home', async () => {
    const f = await setup();
    const name = `${f.workspaceId.slice(0, 12)}-senet`; const remote = fakeArtifacts.remote(name); fakeArtifacts.seed(name, 'master', sha('a'));
    await runInDurableObject(f.stub, (instance: Hooks) => { instance.saveProjectForTest({ id: 'senet', name: 'Senet', repoUrl: remote, branch: 'master', commit: sha('a'), products: [], artifacts: { repo: name, namespace: 'default', remote, status: 'done', accountId: fakeArtifacts.account, source: 'smith', sourceRepoUrl: 'git@github.com:Red-Marmoset/senet.git', updatedAt: 1 } }); });
    const mode = { value: 'down' }; fakeGitServer({ 'refs/heads/master': sha('a') }, mode);   // Artifacts cannot be reached on the first alarm after deploy
    await runInDurableObject(f.stub, (instance: { alarm(): Promise<void> }) => instance.alarm());
    expect((await projects(f)).find(p => p.id === 'senet')!.home).toBeUndefined();
    mode.value = 'ok';
    await runInDurableObject(f.stub, (instance: { alarm(): Promise<void> }) => instance.alarm());
    expect((await projects(f)).find(p => p.id === 'senet')!.home).toBe('artifacts');
  });
  it('a failed move keeps a pre-existing storage copy and its record, with the reason on the card', async () => {
    const f = await setup(); const node = await f.node(HOST_LABELS);
    await hostedOnMachine(f, node);
    const name = `${f.workspaceId.slice(0, 12)}-senet`; const remote = fakeArtifacts.remote(name); fakeArtifacts.seed(name, 'master', sha('a'));   // a legacy copy in storage beside the machine's
    await runInDurableObject(f.stub, (instance: Hooks, state) => {
      const current = JSON.parse(state.storage.sql.exec<{ definition: string }>("SELECT definition FROM projects WHERE id = 'senet'").one().definition) as Record<string, unknown>;
      instance.saveProjectForTest({ ...current, artifacts: { repo: name, namespace: 'default', remote, status: 'done', accountId: fakeArtifacts.account, source: 'smith', sourceRepoUrl: 'git@github.com:Red-Marmoset/senet.git', updatedAt: 1 } });
    });
    fakeGitServer({ 'refs/heads/master': commit });
    const moved = await f.stub.execute(f.human, 'move-to-storage', { projectId: 'senet', requestId: crypto.randomUUID() });
    expect(moved.status).toBe(201);
    const assignment = await claim(f, node);
    expect(assignment.envelope.spec.mirror!.remote).toBe(remote);
    expect((await f.stub.execute(node, 'complete', { ...assignment.envelope.lease, result: { status: 'failed', exitCode: 1, durationMs: 1, message: 'the pack was refused' } })).status).toBe(200);
    await runInDurableObject(f.stub, async (instance: Hooks) => { await instance.reconcileArtifactsHomesForTest(); });
    expect(fakeArtifacts.repos.has(`${fakeArtifacts.account}/${name}`)).toBe(true);   // not the move's to delete
    const shown = (await projects(f)).find(p => p.id === 'senet')! as Shown & { artifacts?: { status: string; message?: string } };
    expect([shown.home, shown.artifacts?.status, shown.artifacts?.message]).toEqual(['machines', 'done', 'the pack was refused']);
  });
  it('marks a lost Artifacts home, refuses Restore without a copy, and removal deletes the repository', async () => {
    const f = await setup(); const { name } = await artifactsHome(f);
    fakeArtifacts.repos.clear();   // the repository vanished from Artifacts
    fakeGitServer({}, { value: 'down' });
    await runInDurableObject(f.stub, async (instance: Hooks) => { await instance.reconcileArtifactsHomesForTest(); });
    const shown = (await projects(f)).find(p => p.id === 'soccer-boy')!;
    expect(shown.hosted?.state).toBe('lost');
    expect(shown.hosted?.message).toContain('Smith’s storage no longer has this repository');
    expect((await f.stub.execute(f.human, 'restore-to-storage', { projectId: 'soccer-boy', requestId: crypto.randomUUID() })).status).toBe(409);
    vi.unstubAllGlobals(); fakeArtifacts.seed(name, 'master', sha('a'));
    expect((await f.stub.execute(f.human, 'remove-project', { projectId: 'soccer-boy' })).status).toBe(200);
    expect(fakeArtifacts.repos.size).toBe(0);
  });
  it('a project started in Smith lives in storage behind Smith’s URL from the start', async () => {
    const f = await setup();
    const created = await f.stub.execute(f.human, 'add-smith-project', { source: 'empty', name: 'Cloud Game' });
    expect(created.status).toBe(201);
    const shown = await created.json() as Shown & { artifacts: { status: string } };
    expect([shown.home, shown.repoUrl, shown.artifacts.status, shown.hosted?.state]).toEqual(['artifacts', `${origin}/git/cloud-game.git`, 'done', 'artifacts']);
    const node = await f.node(HOST_LABELS); await beat(f, node, HOST_LABELS);
    expect((await f.stub.execute(f.human, 'node-host', { nodeId: node.id, host: true })).status).toBe(200);
    expect((await claim(f, node)).hasJob).toBe(false);   // nothing moves it onto the machine behind anyone's back
  });
});
