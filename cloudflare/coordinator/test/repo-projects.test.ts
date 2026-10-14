import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import worker from '../src/index';
import { hash } from '../src/http';
import { fakeGitHub } from '../src/github-reader';
import senet from './fixtures/smith-json/senet.json?raw';
import identity from '../migrations/0001_identity.sql?raw';
import browser from '../migrations/0002_browser_auth.sql?raw';
import directory from '../migrations/0003_workspace_directory.sql?raw';
import profile from '../migrations/0005_account_profile.sql?raw';
import providerTokens from '../migrations/0006_provider_tokens.sql?raw';

const commit = 'd'.repeat(40);
const ghToken = 'github_pat_' + 'Z9'.repeat(15);
type Lease = { jobId: string; attemptId: string; leaseToken: string; leaseExpiresAt: number; nodeId: string };
type Assignment = { hasJob: boolean; envelope: { lease: Lease; spec: { kind: string; projectId: string; repos: { url: string; branch: string; commit: string }[]; resolve?: { action: string } } } };
type PublicProject = { id: string; name: string; branch: string; commit: string | null; scan: { state: string; message: string; via: string | null; host: string | null; jobId: string | null }; actions: { id: string }[]; access: { host: string; message: string }[] };

beforeEach(() => fakeGitHub.reset());
async function setup() {
  const id = crypto.randomUUID(); const userId = crypto.randomUUID();
  const stub = env.WORKSPACES.getByName(id);
  await stub.initialize(id, userId);
  const human = { kind: 'human' as const, userId };
  async function node(labels: string[] = ['smith-repo-projects', 'node'], os = 'windows', hostname = 'PC-' + crypto.randomUUID().slice(0, 4)) {
    const { code } = await (await stub.execute(human, 'enrollments', {})).json() as { code: string };
    const response = await stub.execute({ kind: 'enrollment' }, 'enroll', { code, protocolVersion: 2, os, hostname, arch: 'x64', labels, agentVersion: '0.2.0' });
    const { token } = await response.json() as { token: string };
    return { kind: 'node' as const, token, hostname };
  }
  const add = async (body: object = {}) => {
    const response = await stub.execute(human, 'add-repo-project', { source: 'git', url: 'git@github.com:Red-Marmoset/senet.git', ...body });
    return { status: response.status, project: await response.json() as PublicProject };
  };
  const projects = async () => (await (await stub.execute(human, 'projects', {})).json() as { projects: PublicProject[] }).projects;
  const claim = async (n: { kind: 'node'; token: string }) => await (await stub.execute(n, 'claim', {})).json() as Assignment;
  const complete = (n: { kind: 'node'; token: string }, lease: Lease, result: object) => stub.execute(n, 'complete', { ...lease, result: { exitCode: 0, durationMs: 5, message: '', status: 'success', ...result } });
  return { stub, human, node, add, projects, claim, complete };
}
const report = (extra: object = {}) => ({ commit, branch: 'master', smithJson: senet, paths: [], truncated: false, ...extra });

describe('adding a project from a Git URL', () => {
  it('reads smith.json with the GitHub link of whoever adds the project, or of any other member', async () => {
    for (const sql of [identity, providerTokens]) await env.DB.exec(sql.split('\n').filter(line => line.trim() && !line.trim().startsWith('--')).join('\n'));
    const f = await setup();
    const link = async (userId: string, token: string) => env.DB.batch([env.DB.prepare('INSERT OR IGNORE INTO users (id, created_at) VALUES (?, ?)').bind(userId, Date.now()),
      env.DB.prepare('INSERT INTO provider_tokens (user_id, provider, access_token, refresh_token, expires_at, updated_at) VALUES (?, ?, ?, NULL, NULL, ?)').bind(userId, 'github', token, Date.now())]);
    fakeGitHub.repos.set('Red-Marmoset/senet', { defaultBranch: 'master', visibleTo: ['sem-link'], branches: { master: { commit, smithJson: senet, paths: [], truncated: false } } });
    // Nobody linked: a machine scan is queued.
    const { project } = await f.add();
    expect(project.scan).toMatchObject({ state: 'waiting', via: null });
    // Sem links GitHub and can see the repository: a rescan reads it immediately, with no Settings token.
    await link(f.human.userId, 'sem-link');
    await f.stub.execute(f.human, 'cancel', { jobId: project.scan.jobId });   // a rescan defers to a scan still in flight
    const rescan = await (await f.stub.execute(f.human, 'rescan-project', { projectId: project.id })).json() as PublicProject;
    expect(rescan.scan).toMatchObject({ state: 'ready', via: 'github' });
    // A colleague whose own link cannot see a repository still gets it read, through Sem's link.
    const colleague = { kind: 'human' as const, userId: crypto.randomUUID() };
    await runInDurableObject(f.stub, (_object, state) => { state.storage.sql.exec('INSERT INTO members (user_id, role) VALUES (?, ?)', colleague.userId, 'admin'); });
    await link(colleague.userId, 'colleague-link');
    fakeGitHub.repos.set('Red-Marmoset/soccer-boy', { defaultBranch: 'main', visibleTo: ['sem-link'], branches: { main: { commit, smithJson: senet, paths: [], truncated: false } } });
    const theirs = await (await f.stub.execute(colleague, 'add-repo-project', { source: 'git', url: 'git@github.com:Red-Marmoset/soccer-boy.git' })).json() as PublicProject;
    expect(theirs.scan).toMatchObject({ state: 'ready', via: 'github' });
  });
  it('reads smith.json through GitHub straight away when the workspace token can', async () => {
    const f = await setup();
    await f.stub.execute(f.human, 'put-settings', { githubToken: ghToken });
    fakeGitHub.repos.set('Red-Marmoset/senet', { defaultBranch: 'master', branches: { master: { commit, smithJson: senet, paths: [], truncated: false } } });
    const { status, project } = await f.add();
    expect(status).toBe(201);
    expect(project).toMatchObject({ id: 'senet', branch: 'master', commit, scan: { state: 'ready', via: 'github', jobId: null } });
    expect(project.actions.map(a => a.id)).toEqual(['build-check', 'web-deploy', 'd1-limit-workaround', 'ai-ladder']);
    const settings = await (await f.stub.execute(f.human, 'settings', {})).text();
    expect(settings).toContain('"githubTokenSet":true');
    expect(settings).not.toContain(ghToken);
  });
  it('queues a scan for an updated machine when GitHub cannot read it, and fills a blank branch from the scan', async () => {
    const f = await setup();
    await f.stub.execute(f.human, 'put-settings', { githubToken: ghToken });
    fakeGitHub.failNext = 'GitHub answered 404 for the repository';
    const { project } = await f.add();
    expect(project.scan).toMatchObject({ state: 'waiting', message: expect.stringContaining('could not read this repository through any linked account (GitHub answered 404') });
    const old = await f.node(['node']);
    expect((await f.claim(old)).hasJob).toBe(false);                    // agents without the label never see scans
    const pc = await f.node();
    const assigned = await f.claim(pc);
    expect(assigned.envelope.spec).toMatchObject({ kind: 'scan', projectId: 'senet', repos: [{ branch: '', commit: '' }] });
    expect((await f.projects())[0].scan).toMatchObject({ state: 'scanning', host: pc.hostname });
    expect((await f.complete(pc, assigned.envelope.lease, { commit, scan: report() })).status).toBe(200);
    const [ready] = await f.projects();
    expect(ready).toMatchObject({ branch: 'master', commit, scan: { state: 'ready', via: 'machine', host: pc.hostname } });
  });
  it('waits without a GitHub token, and needs an admin', async () => {
    const f = await setup();
    expect((await f.add()).project.scan).toMatchObject({ state: 'waiting', message: 'Waiting for a machine to read smith.json. (No build machine is connected.)' });
    await runInDurableObject(f.stub, (_object, state) => { state.storage.sql.exec("UPDATE members SET role = 'operator'"); });
    expect((await f.add({ url: 'https://github.com/a/b.git' })).status).toBe(403);
  });
  it('shows a lost or cancelled scan as an error, and Rescan queues a fresh one without duplicating', async () => {
    const f = await setup();
    const { project } = await f.add();
    await f.stub.execute(f.human, 'cancel', { jobId: project.scan.jobId });
    expect((await f.projects())[0].scan).toMatchObject({ state: 'error', message: expect.stringContaining('Rescan') });
    const first = await (await f.stub.execute(f.human, 'rescan-project', { projectId: 'senet' })).json() as PublicProject;
    const second = await (await f.stub.execute(f.human, 'rescan-project', { projectId: 'senet' })).json() as PublicProject;
    expect(first.scan.state).toBe('waiting');
    expect(second.scan.jobId).toBe(first.scan.jobId);
  });
  it('accepts a scan whose report it cannot use, and says why on the project', async () => {
    const f = await setup();
    await f.add();
    const pc = await f.node();
    const assigned = await f.claim(pc);
    const response = await f.complete(pc, assigned.envelope.lease, { commit, scan: report({ branch: 'feat+x' }) });
    expect(response.status).toBe(200);                                  // never wedge the agent on a 400
    expect((await f.projects())[0].scan).toMatchObject({ state: 'error', message: expect.stringContaining('feat+x') });
  });
  it('records a scan that found no smith.json', async () => {
    const f = await setup();
    await f.add();
    const pc = await f.node();
    const assigned = await f.claim(pc);
    await f.complete(pc, assigned.envelope.lease, { commit, scan: report({ smithJson: null }) });
    expect((await f.projects())[0].scan).toMatchObject({ state: 'error', message: expect.stringContaining('No smith.json') });
  });
  it('routes POST /projects with a source and /projects/{id}/rescan through the Worker', async () => {
    for (const sql of [identity, browser, directory, profile, providerTokens]) await env.DB.exec(sql.split('\n').filter(line => line.trim() && !line.trim().startsWith('--')).join('\n'));
    const token = crypto.randomUUID(); const userId = crypto.randomUUID();
    await env.DB.batch([env.DB.prepare('INSERT INTO users (id, created_at) VALUES (?, ?)').bind(userId, Date.now()),
      env.DB.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').bind(await hash(token), userId, Date.now() + 60000)]);
    const call = (path: string, body: unknown) => worker.fetch(new Request('https://exp.redmarmosetstudios.com' + path, { method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), env);
    const { workspaceId } = await (await call('/api/v2/workspaces', { requestId: crypto.randomUUID() })).json() as { workspaceId: string };
    const added = await call(`/api/v2/workspaces/${workspaceId}/projects`, { source: 'git', url: 'https://github.com/o/routed.git' });
    expect(added.status).toBe(201);
    expect(await added.json()).toMatchObject({ id: 'routed', kind: 'repo' });
    expect((await call(`/api/v2/workspaces/${workspaceId}/projects/routed/rescan`, {})).status).toBe(200);
  });
});

describe('building a repository project', () => {
  async function ready() {
    const f = await setup();
    await f.stub.execute(f.human, 'put-settings', { githubToken: ghToken });
    fakeGitHub.repos.set('Red-Marmoset/senet', { defaultBranch: 'master', branches: { master: { commit, smithJson: senet, paths: [], truncated: false } } });
    await f.add();
    return f;
  }
  it('builds the branch tip and resolves the command after checkout', async () => {
    const f = await ready();
    const queued = await (await f.stub.execute(f.human, 'enqueue', { requestId: 'b1', projectId: 'senet', product: 'build-check' })).json() as { id: string };
    const pc = await f.node();
    const assigned = await f.claim(pc);
    expect(assigned.envelope.spec).toMatchObject({ kind: 'build', resolve: { action: 'build-check' }, repos: [{ branch: 'master', commit: '' }] });
    expect((await (await f.stub.execute(f.human, 'get', { jobId: queued.id })).json() as { source: unknown }).source).toEqual({ branch: 'master', commit: null });   // dashboard: "latest on master"
    const tip = 'e'.repeat(40);
    const resolved = await f.stub.execute(pc, 'resolve', { ...assigned.envelope.lease, report: report({ commit: tip }) });
    expect(resolved.status).toBe(200);
    const { spec } = await resolved.json() as { spec: { repos: { commit: string }[]; command: { script: string }; env: Record<string, string>; resolve?: unknown } };
    expect(spec).toMatchObject({ repos: [{ commit: tip }], command: { script: 'build.bat' }, env: { SMITH_COMMIT: tip } });
    expect(spec.resolve).toBeUndefined();
    expect((await (await f.stub.execute(f.human, 'get', { jobId: queued.id })).json() as { source: unknown }).source).toEqual({ branch: 'master', commit: tip });    // known once checked out, while it runs
    expect((await f.complete(pc, assigned.envelope.lease, { commit: tip })).status).toBe(200);
    const job = await (await f.stub.execute(f.human, 'get', { jobId: queued.id })).json() as { state: string; result: { commit: string } };
    expect(job).toMatchObject({ state: 'success', result: { commit: tip }, source: { branch: 'master', commit: tip } });
    expect((await f.projects())[0].commit).toBe(tip);                   // the build's checkout refreshed the project
  });
  it('fails the build clearly when the action is gone at the new commit', async () => {
    const f = await ready();
    await f.stub.execute(f.human, 'enqueue', { requestId: 'b2', projectId: 'senet', product: 'build-check' });
    const pc = await f.node();
    const assigned = await f.claim(pc);
    const gone = JSON.stringify({ project: { id: 'senet' }, buildProducts: [] });
    const response = await f.stub.execute(pc, 'resolve', { ...assigned.envelope.lease, report: report({ smithJson: gone }) });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: { code: 'action_missing', message: expect.stringContaining('build-check is not in smith.json') } });
    const [refreshed] = await f.projects();                             // the checkout still rescanned the project
    expect(refreshed.actions.map(a => a.id)).not.toContain('build-check');
  });
  it('shows only the latest attempt output after a job is handed to another machine', async () => {
    const f = await ready();
    const queued = await (await f.stub.execute(f.human, 'enqueue', { requestId: 'b5', projectId: 'senet', product: 'build-check' })).json() as { id: string };
    const blind = await f.node();
    const first = await f.claim(blind);
    await f.stub.execute(blind, 'logs', { ...first.envelope.lease, seq: 0, stream: 'stderr', lines: ['Permission denied (publickey)'] });
    await f.complete(blind, first.envelope.lease, { status: 'error', exitCode: -1, message: 'Repository clone failed', failure: 'repo_access' });
    const pc = await f.node();
    const second = await f.claim(pc);
    await f.stub.execute(pc, 'logs', { ...second.envelope.lease, seq: 0, stream: 'stdout', lines: ['Cloning on the second machine'] });
    const logs = await (await f.stub.execute(f.human, 'read-logs', { jobId: queued.id })).json() as { chunks: { lines: string[] }[] };
    expect(logs.chunks.flatMap(chunk => chunk.lines)).toEqual(['Cloning on the second machine']);
  });
  it('fails a prepared project build that reports repo access instead of requeueing it', async () => {
    const f = await setup();
    await f.stub.execute(f.human, 'put-project', { id: 'pinned', name: 'Pinned', repoUrl: 'git@github.com:o/pinned.git', branch: 'main', commit: 'a'.repeat(40),
      products: [{ name: 'build', description: '', labels: [], timeoutSeconds: 60, commands: { windows: { interpreter: 'bat', script: 'b.bat', args: [] } } }] });
    const queued = await (await f.stub.execute(f.human, 'enqueue', { requestId: 'p1', projectId: 'pinned', product: 'build' })).json() as { id: string };
    const pc = await f.node();
    const assigned = await f.claim(pc);
    const done = await f.complete(pc, assigned.envelope.lease, { status: 'error', exitCode: -1, message: 'Repository clone failed', failure: 'repo_access' });
    expect(await done.json()).not.toHaveProperty('requeued');
    expect(await (await f.stub.execute(f.human, 'get', { jobId: queued.id })).json()).toMatchObject({ state: 'error' });
  });
  it('skips a machine that could not read the repo, until rescan or an hour', async () => {
    const f = await ready();
    await f.stub.execute(f.human, 'enqueue', { requestId: 'b3', projectId: 'senet', product: 'build-check' });
    const blind = await f.node();
    const first = await f.claim(blind);
    const denied = await f.complete(blind, first.envelope.lease, { status: 'error', exitCode: -1, message: 'Repository clone failed', failure: 'repo_access' });
    expect(await denied.json()).toMatchObject({ accepted: true, requeued: true });
    expect((await f.claim(blind)).hasJob).toBe(false);
    expect((await f.projects())[0].access).toMatchObject([{ host: blind.hostname, message: 'Repository clone failed' }]);
    await runInDurableObject(f.stub, (_object, state) => { state.storage.sql.exec('UPDATE repo_access SET at = at - 3600001'); });
    expect((await f.claim(blind)).hasJob).toBe(true);                   // an hour later it may try again
    const second = await f.claim(blind);
    await f.complete(blind, second.envelope.lease, { status: 'error', exitCode: -1, message: 'Repository clone failed', failure: 'repo_access' });
    expect((await f.claim(blind)).hasJob).toBe(false);
    await f.stub.execute(f.human, 'rescan-project', { projectId: 'senet' });
    expect((await f.claim(blind)).hasJob).toBe(true);                   // Rescan clears the marks
  });
  it('refuses builds of unknown or unavailable actions', async () => {
    const f = await ready();
    expect((await f.stub.execute(f.human, 'enqueue', { requestId: 'b4', projectId: 'senet', product: 'stats-reconcile-prod' })).status).toBe(400);
  });
});
