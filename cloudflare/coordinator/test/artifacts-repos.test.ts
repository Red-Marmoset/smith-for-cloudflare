import { env } from 'cloudflare:workers';
import { runInDurableObject, runDurableObjectAlarm } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import { fakeArtifacts, isArtifactsRemote, repoNameFor, resolveArtifactsCredentials, tokenExpiry } from '../src/artifacts-repos';
import { validateProject, mirrorSpecs, type Project } from '../src/projects';
import { fakeGitHub } from '../src/github-reader';
import senet from './fixtures/smith-json/senet.json?raw';

const commit = 'd45d5d166ff384710a2f63cfa24271395b689c41';
const OWN_ACCOUNT = 'c'.repeat(32);   // a workspace's own Cloudflare account, distinct from Smith's backend
const project = {
  id: 'smith', name: 'Smith', repoUrl: 'git@github.com:Red-Marmoset/smith.git', branch: 'feature/cloudflare-experiment', commit,
  products: [{ name: 'build', description: 'Build Smith', labels: [], timeoutSeconds: 1800,
    commands: { windows: { interpreter: 'ps1', script: 'Build.ps1', args: ['-Project', 'Smith'] }, linux: { interpreter: 'sh', script: 'Build.sh', args: ['Smith'] } } }],
};
type Lease = { jobId: string; attemptId: string; leaseToken: string; leaseExpiresAt: number; nodeId: string };
type Assignment = { hasJob: boolean; envelope: { lease: Lease; spec: { kind: string; projectId: string; repos: { url: string; commit: string; authToken: string }[]; mirror?: { remote: string; authToken: string; branch: string; pushTags: boolean }; command: { script: string } } } };
type MirrorResponse = { project: Project; job: { id: string; kind: string; state: string; product: string } | null };

async function setup() {
  fakeArtifacts.reset();
  const id = crypto.randomUUID(); const userId = crypto.randomUUID();
  const stub = env.WORKSPACES.getByName(id);
  await stub.initialize(id, userId);
  const human = { kind: 'human' as const, userId };
  async function node(os = 'windows') {
    const { code } = await (await stub.execute(human, 'enrollments', {})).json() as { code: string };
    const response = await stub.execute({ kind: 'enrollment' }, 'enroll', { code, protocolVersion: 2, os, hostname: 'test-runner', arch: 'x64', labels: [], agentVersion: '0.1.0' });
    expect(response.status).toBe(201);
    return { kind: 'node' as const, token: (await response.json() as { token: string }).token };
  }
  const workspaceId = (await (await stub.execute(human, 'summary', {})).json() as { id: string }).id;
  const projects = async () => (await (await stub.execute(human, 'projects', {})).json() as { projects: Project[] }).projects;
  const mirror = (requestId = crypto.randomUUID()) => stub.execute(human, 'mirror-project', { requestId, projectId: 'smith' });
  // A workspace's own Cloudflare account ID + API token (Settings) take precedence over Smith's backend account.
  const configure = async () => expect((await stub.execute(human, 'put-settings', { cloudflareAccountId: OWN_ACCOUNT, cloudflareApiToken: 'cf_test_token_1234567890abcdefghij' })).status).toBe(200);
  expect((await stub.execute(human, 'put-project', project)).status).toBe(201);
  return { stub, human, node, workspaceId, projects, mirror, configure, repo: repoNameFor(workspaceId, 'smith') };
}
async function claim(f: Awaited<ReturnType<typeof setup>>, node: { kind: 'node'; token: string }) {
  return await (await f.stub.execute(node, 'claim', {})).json() as Assignment;
}
async function complete(f: Awaited<ReturnType<typeof setup>>, node: { kind: 'node'; token: string }, lease: Lease, status: 'success' | 'failed', message = '') {
  return f.stub.execute(node, 'complete', { ...lease, result: { status, exitCode: status === 'success' ? 0 : 1, durationMs: 1, message } });
}

describe('pure helpers', () => {
  it('recognises Artifacts remotes and derives names/expiry', () => {
    expect(isArtifactsRemote(fakeArtifacts.remote('abc-smith'))).toBe(true);
    for (const bad of ['https://github.com/a/b.git', 'http://' + fakeArtifacts.remote('x').slice(8), 'https://x:t@' + fakeArtifacts.remote('x').slice(8), fakeArtifacts.remote('x').replace('.git', ''), fakeArtifacts.remote('x') + '?a=1'])
      expect(isArtifactsRemote(bad)).toBe(false);
    expect(repoNameFor('f'.repeat(64), 'smith')).toBe('ffffffffffff-smith');
    expect(repoNameFor('f'.repeat(64), 'p'.repeat(64)).length).toBe(63);
    expect(tokenExpiry('art_v1_abc?expires=1760000000')).toBe(1760000000000);
    expect(tokenExpiry('art_v1_abc')).toBe(0);
  });
  it('prefers the workspace token, falls back to the Smith backend, and pins an existing copy to its account', () => {
    const env = { ARTIFACTS_MODE: 'fake' }; fakeArtifacts.reset();
    const own = { accountId: OWN_ACCOUNT, apiToken: 'cf_test_token_1234567890abcdefghij' };
    expect(resolveArtifactsCredentials(env, own)).toMatchObject({ accountId: OWN_ACCOUNT, source: 'workspace' });
    expect(resolveArtifactsCredentials(env, { accountId: '', apiToken: '' })).toMatchObject({ accountId: fakeArtifacts.account, source: 'smith' });
    expect(resolveArtifactsCredentials(env, { accountId: OWN_ACCOUNT, apiToken: '' })).toMatchObject({ source: 'smith' });   // account without a token is not usable
    expect(resolveArtifactsCredentials(env, own, fakeArtifacts.account)).toMatchObject({ accountId: fakeArtifacts.account, source: 'smith' });
    expect(resolveArtifactsCredentials(env, { accountId: '', apiToken: '' }, OWN_ACCOUNT)).toMatchObject({ accountId: OWN_ACCOUNT, source: 'none' });
    fakeArtifacts.backend = null;
    expect(resolveArtifactsCredentials(env, { accountId: '', apiToken: '' })).toMatchObject({ source: 'none' });
    const real = resolveArtifactsCredentials({ SMITH_ARTIFACTS_ACCOUNT_ID: 'a'.repeat(32), SMITH_ARTIFACTS_TOKEN: 'backend' }, { accountId: '', apiToken: '' });
    expect(real).toMatchObject({ accountId: 'a'.repeat(32), source: 'smith' });
  });
  it('accepts an Artifacts remote as a project source and refuses a caller-supplied artifacts record', () => {
    expect(validateProject({ ...project, repoUrl: fakeArtifacts.remote('abc-smith') }).repoUrl).toBe(fakeArtifacts.remote('abc-smith'));
    expect(() => validateProject({ ...project, artifacts: { status: 'done' } })).toThrow();
    expect(() => validateProject({ ...project, repoUrl: 'https://x:tok@' + fakeArtifacts.remote('abc-smith').slice(8) })).toThrow();
  });
  it('builds a mirror spec for every OS with the write token only in the mirror block', () => {
    const specs = mirrorSpecs(validateProject(project), 'job-1', fakeArtifacts.remote('abc-smith'), 'art_v1_w?expires=1');
    expect(Object.keys(specs).sort()).toEqual(['linux', 'mac', 'windows']);
    expect(specs.windows).toMatchObject({ kind: 'mirror', projectId: 'smith', mirror: { remote: fakeArtifacts.remote('abc-smith'), authToken: 'art_v1_w?expires=1', branch: project.branch, pushTags: true } });
    expect(specs.windows.repos[0]).toMatchObject({ url: project.repoUrl, commit, authToken: '' });
  });
});

describe('copy a project to Cloudflare Artifacts', () => {
  beforeEach(() => fakeArtifacts.reset());
  it('creates the repository, queues a mirror job any machine can run, then switches the project after verification', async () => {
    const f = await setup(); await f.configure();
    const response = await f.mirror('copy-1');
    expect(response.status).toBe(201);
    const { project: pending, job } = await response.json() as MirrorResponse;
    expect(job).toMatchObject({ kind: 'mirror', state: 'queued', product: 'copy-to-artifacts' });
    expect(pending.artifacts).toMatchObject({ status: 'pushing', repo: f.repo, remote: fakeArtifacts.remote(f.repo, OWN_ACCOUNT), accountId: OWN_ACCOUNT, source: 'workspace', sourceRepoUrl: project.repoUrl, jobId: job!.id });
    expect(pending.repoUrl).toBe(project.repoUrl);
    expect(fakeArtifacts.repos.get(OWN_ACCOUNT + '/' + f.repo)?.defaultBranch).toBe(project.branch);
    const [tokenId, token] = [...fakeArtifacts.tokens.entries()][0];
    expect(token).toMatchObject({ account: OWN_ACCOUNT, repo: f.repo, scope: 'write', revoked: false });
    expect(pending.artifacts?.tokenId).toBe(tokenId);
    // Replaying the request returns the same job; a second copy while one is in flight is refused.
    expect(((await (await f.mirror('copy-1')).json()) as MirrorResponse).job?.id).toBe(job!.id);
    expect((await f.mirror('copy-2')).status).toBe(409);
    // Builds wait until the copy settles.
    expect((await f.stub.execute(f.human, 'enqueue', { requestId: 'b0', projectId: 'smith', product: 'build' })).status).toBe(409);
    const linux = await f.node('linux');
    const assignment = await claim(f, linux);
    expect(assignment.hasJob).toBe(true);
    expect(assignment.envelope.spec).toMatchObject({ kind: 'mirror', projectId: 'smith', mirror: { remote: fakeArtifacts.remote(f.repo, OWN_ACCOUNT), branch: project.branch, pushTags: true } });
    expect(assignment.envelope.spec.mirror?.authToken).toMatch(/^art_v1_.*\?expires=\d+$/);
    expect(assignment.envelope.spec.repos[0]).toMatchObject({ url: project.repoUrl, commit, authToken: '' });
    // The agent pushes (the fake records the head) and reports success.
    fakeArtifacts.seed(f.repo, project.branch, commit, OWN_ACCOUNT);
    expect((await complete(f, linux, assignment.envelope.lease, 'success', 'Pushed')).status).toBe(200);
    const [done] = await f.projects();
    expect(done.repoUrl).toBe(fakeArtifacts.remote(f.repo, OWN_ACCOUNT));
    expect(done.artifacts).toMatchObject({ status: 'done', pushedCommit: commit, sourceRepoUrl: project.repoUrl });
    expect(done.artifacts?.tokenId).toBeUndefined();
    expect(fakeArtifacts.tokens.get(tokenId)?.revoked).toBe(true);
    // A build of the switched project carries a read token for the Artifacts remote.
    expect((await f.stub.execute(f.human, 'enqueue', { requestId: 'b1', projectId: 'smith', product: 'build' })).status).toBe(201);
    const build = await claim(f, linux);
    expect(build.envelope.spec).toMatchObject({ kind: 'build', projectId: 'smith' });
    expect(build.envelope.spec.repos[0].url).toBe(fakeArtifacts.remote(f.repo, OWN_ACCOUNT));
    expect(build.envelope.spec.repos[0].authToken).toMatch(/^art_v1_/);
    expect([...fakeArtifacts.tokens.values()].filter(t => t.scope === 'read')).toMatchObject([{ account: OWN_ACCOUNT }]);
    expect(build.envelope.spec.command.script).toBe('Build.sh');
    // Copying again is refused: the project already builds from Artifacts.
    expect((await f.mirror()).status).toBe(409);
  });
  it('leaves the project on its source when the push fails or the branch head does not match', async () => {
    const f = await setup(); await f.configure(); const node = await f.node();
    const { job } = await (await f.mirror()).json() as MirrorResponse;
    const assignment = await claim(f, node);
    expect((await complete(f, node, assignment.envelope.lease, 'failed', 'Push to Artifacts failed')).status).toBe(200);
    let [current] = await f.projects();
    expect(current.repoUrl).toBe(project.repoUrl);
    expect(current.artifacts).toMatchObject({ status: 'failed', message: 'Push to Artifacts failed', jobId: job!.id });
    expect([...fakeArtifacts.tokens.values()][0].revoked).toBe(true);
    // Retry after a failure: new job, new token; this time the agent claims success but the head is wrong.
    const retry = await (await f.mirror()).json() as MirrorResponse;
    expect(retry.job?.id).not.toBe(job!.id);
    const second = await claim(f, node);
    fakeArtifacts.seed(f.repo, project.branch, '1'.repeat(40), OWN_ACCOUNT);
    await complete(f, node, second.envelope.lease, 'success', 'Pushed');
    [current] = await f.projects();
    expect(current.repoUrl).toBe(project.repoUrl);
    expect(current.artifacts?.status).toBe('failed');
    expect(current.artifacts?.message).toContain('not the pinned commit');
  });
  it('skips the push when the Artifacts branch already holds the pinned commit', async () => {
    const f = await setup();   // no workspace token: Smith's backend account
    fakeArtifacts.seed(f.repo, project.branch, commit);
    const { project: switched, job } = await (await f.mirror()).json() as MirrorResponse;
    expect(job).toBeNull();
    expect(switched.repoUrl).toBe(fakeArtifacts.remote(f.repo));
    expect(switched.artifacts).toMatchObject({ status: 'done', pushedCommit: commit, accountId: fakeArtifacts.account, source: 'smith' });
    expect(fakeArtifacts.tokens.size).toBe(0);
    expect((await (await f.stub.execute(f.human, 'list', {})).json() as { jobs: unknown[] }).jobs).toHaveLength(0);
  });
  it('settles a cancelled copy and retries verification from the alarm when Artifacts is unreachable', async () => {
    const f = await setup(); await f.configure(); const node = await f.node();
    const { job } = await (await f.mirror()).json() as MirrorResponse;
    expect((await f.stub.execute(f.human, 'cancel', { jobId: job!.id })).status).toBe(200);
    let [current] = await f.projects();
    expect(current.artifacts?.status).toBe('failed');
    expect(current.artifacts?.message).toContain('cancelled');
    // Second attempt: the completion arrives while the API is down; the alarm finishes the switch.
    const retry = await (await f.mirror()).json() as MirrorResponse;
    const assignment = await claim(f, node);
    fakeArtifacts.seed(f.repo, project.branch, commit, OWN_ACCOUNT);
    fakeArtifacts.failNext = { status: 502, code: 'artifacts_unavailable' };
    await complete(f, node, assignment.envelope.lease, 'success');
    [current] = await f.projects();
    expect(current.artifacts).toMatchObject({ status: 'verifying', jobId: retry.job!.id });
    expect(current.repoUrl).toBe(project.repoUrl);
    expect(await runDurableObjectAlarm(f.stub)).toBe(true);
    [current] = await f.projects();
    expect(current.artifacts?.status).toBe('done');
    expect(current.repoUrl).toBe(fakeArtifacts.remote(f.repo, OWN_ACCOUNT));
  });
  it("copies into Smith's backend account by default and keeps that copy there when a workspace token appears later", async () => {
    const f = await setup(); const node = await f.node();
    expect(await (await f.stub.execute(f.human, 'settings', {})).json()).toMatchObject({ artifactsAvailable: true, artifactsSource: 'smith' });
    const { project: pending, job } = await (await f.mirror()).json() as MirrorResponse;
    expect(pending.artifacts).toMatchObject({ status: 'pushing', accountId: fakeArtifacts.account, source: 'smith', remote: fakeArtifacts.remote(f.repo) });
    expect([...fakeArtifacts.tokens.values()][0]).toMatchObject({ account: fakeArtifacts.account, scope: 'write' });
    const assignment = await claim(f, node);
    expect(assignment.envelope.spec.mirror?.remote).toBe(fakeArtifacts.remote(f.repo));
    fakeArtifacts.seed(f.repo, project.branch, commit);
    await complete(f, node, assignment.envelope.lease, 'success');
    let [current] = await f.projects();
    expect(current).toMatchObject({ repoUrl: fakeArtifacts.remote(f.repo), artifacts: { status: 'done', source: 'smith', jobId: job!.id } });
    // The workspace now adds its own token: future copies would go there, but this project's
    // builds keep minting read tokens for the account the copy actually lives in.
    await f.configure();
    expect(await (await f.stub.execute(f.human, 'settings', {})).json()).toMatchObject({ artifactsSource: 'workspace' });
    expect((await f.stub.execute(f.human, 'enqueue', { requestId: 'b-after', projectId: 'smith', product: 'build' })).status).toBe(201);
    const build = await claim(f, node);
    expect(build.envelope.spec.repos[0].url).toBe(fakeArtifacts.remote(f.repo));
    expect([...fakeArtifacts.tokens.values()].filter(t => t.scope === 'read')).toMatchObject([{ account: fakeArtifacts.account }]);
    [current] = await f.projects();
    expect(current.artifacts?.accountId).toBe(fakeArtifacts.account);
  });
  it('is admin-only, needs some Cloudflare credentials, and project edits keep the server-owned record', async () => {
    const f = await setup();
    // Neither a workspace token nor a Smith backend secret: the dashboard sees it, and a copy is refused.
    fakeArtifacts.backend = null;
    expect(await (await f.stub.execute(f.human, 'settings', {})).json()).toMatchObject({ artifactsAvailable: false, artifactsSource: 'none' });
    expect((await f.mirror()).status).toBe(503);
    expect((await f.projects())[0].artifacts).toBeUndefined();
    await f.configure();
    expect(await (await f.stub.execute(f.human, 'settings', {})).json()).toMatchObject({ artifactsAvailable: true, artifactsSource: 'workspace' });
    await runInDurableObject(f.stub, (_object, state) => { state.storage.sql.exec('UPDATE members SET role = ?', 'operator'); });
    expect((await f.mirror()).status).toBe(403);
    await runInDurableObject(f.stub, (_object, state) => { state.storage.sql.exec('UPDATE members SET role = ?', 'owner'); });
    fakeArtifacts.failNext = { status: 502, code: 'artifacts_unavailable' };
    expect((await f.mirror()).status).toBe(502);
    expect((await f.projects())[0].artifacts).toBeUndefined();
    fakeArtifacts.seed(f.repo, project.branch, commit, OWN_ACCOUNT);
    await f.mirror();
    expect((await f.stub.execute(f.human, 'put-project', { ...project, name: 'Renamed' })).status).toBe(201);
    const [edited] = await f.projects();
    expect(edited.name).toBe('Renamed');
    expect(edited.artifacts?.status).toBe('done');
    expect(edited.repoUrl).toBe(project.repoUrl);   // the edit pointed back at GitHub: it builds from there again
    expect((await f.stub.execute(f.human, 'enqueue', { requestId: 'gh', projectId: 'smith', product: 'build' })).status).toBe(201);
    expect(fakeArtifacts.tokens.size).toBe(0);      // no read token for a GitHub source
  });
  it('stays off when the account behind the credentials has no Artifacts, and notices when it gains them', async () => {
    const f = await setup();
    fakeArtifacts.entitled = false;   // credentials are set (Smith's backend), but that account cannot use Artifacts
    expect(await (await f.stub.execute(f.human, 'settings', {})).json()).toMatchObject({ artifactsAvailable: false, artifactsSource: 'smith' });
    const refused = await f.mirror();
    expect(refused.status).toBe(503);
    expect(((await refused.json()) as { error: { message: string } }).error.message).not.toMatch(/Artifacts/);
    expect((await f.projects())[0].artifacts).toBeUndefined();
    expect(fakeArtifacts.repos.size).toBe(0);
    // Ordinary GitHub builds are unaffected.
    expect((await f.stub.execute(f.human, 'enqueue', { requestId: 'gh-only', projectId: 'smith', product: 'build' })).status).toBe(201);
    // An unanswerable check keeps the last answer; new credentials are checked at once.
    fakeArtifacts.entitled = null;
    expect(await (await f.stub.execute(f.human, 'settings', {})).json()).toMatchObject({ artifactsAvailable: false });
    fakeArtifacts.entitled = true;
    await f.configure();
    expect(await (await f.stub.execute(f.human, 'settings', {})).json()).toMatchObject({ artifactsAvailable: true, artifactsSource: 'workspace' });
  });
  it('copies a project added from a Git URL at the commit it was read at, then builds and rescans from the copy', async () => {
    const f = await setup(); await f.configure(); fakeGitHub.reset();
    const ghToken = 'github_pat_' + 'Z9'.repeat(15);
    await f.stub.execute(f.human, 'put-settings', { githubToken: ghToken });
    const enrollRepoNode = async () => {
      const { code } = await (await f.stub.execute(f.human, 'enrollments', {})).json() as { code: string };
      const response = await f.stub.execute({ kind: 'enrollment' }, 'enroll', { code, protocolVersion: 2, os: 'windows', hostname: 'repo-runner', arch: 'x64', labels: ['smith-repo-projects', 'node'], agentVersion: '0.2.0' });
      return { kind: 'node' as const, token: (await response.json() as { token: string }).token };
    };
    // Not read yet: nothing to copy.
    fakeGitHub.failNext = 'GitHub answered 404 for the repository';
    const unread = await (await f.stub.execute(f.human, 'add-repo-project', { source: 'git', url: 'git@github.com:Red-Marmoset/unread.git' })).json() as { id: string; commit: string | null; scan: { jobId: string } };
    expect(unread.commit).toBeNull();
    expect((await f.stub.execute(f.human, 'mirror-project', { requestId: crypto.randomUUID(), projectId: unread.id })).status).toBe(409);
    await f.stub.execute(f.human, 'cancel', { jobId: unread.scan.jobId });   // keep its scan out of the queue below
    // Read via GitHub: the card shows a commit, so the copy can start.
    fakeGitHub.repos.set('Red-Marmoset/senet', { defaultBranch: 'master', branches: { master: { commit, smithJson: senet, paths: [], truncated: false } } });
    const added = await (await f.stub.execute(f.human, 'add-repo-project', { source: 'git', url: 'git@github.com:Red-Marmoset/senet.git' })).json() as { id: string; commit: string; branch: string };
    expect(added).toMatchObject({ id: 'senet', commit, branch: 'master' });
    const repoName = repoNameFor(f.workspaceId, 'senet');
    const { project: pending, job } = await (await f.stub.execute(f.human, 'mirror-project', { requestId: 'copy-senet', projectId: 'senet' })).json() as MirrorResponse;
    expect(pending.artifacts).toMatchObject({ status: 'pushing', repo: repoName, remote: fakeArtifacts.remote(repoName, OWN_ACCOUNT), jobId: job!.id });
    const node = await enrollRepoNode();
    const assignment = await claim(f, node);
    expect(assignment.envelope.spec).toMatchObject({ kind: 'mirror', projectId: 'senet', mirror: { remote: fakeArtifacts.remote(repoName, OWN_ACCOUNT), branch: 'master' } });
    expect(assignment.envelope.spec.repos[0]).toMatchObject({ url: 'git@github.com:Red-Marmoset/senet.git', commit, authToken: '' });
    fakeArtifacts.seed(repoName, 'master', commit, OWN_ACCOUNT);
    expect((await complete(f, node, assignment.envelope.lease, 'success', 'Pushed')).status).toBe(200);
    const done = (await f.projects()).find(p => p.id === 'senet')!;
    expect(done.repoUrl).toBe(fakeArtifacts.remote(repoName, OWN_ACCOUNT));
    expect(done.artifacts).toMatchObject({ status: 'done', pushedCommit: commit, sourceRepoUrl: 'git@github.com:Red-Marmoset/senet.git' });
    // A build of a smith.json action now clones the copy with a read token.
    expect((await f.stub.execute(f.human, 'enqueue', { requestId: 'senet-build', projectId: 'senet', product: 'build-check' })).status).toBe(201);
    const build = await claim(f, node);
    expect(build.envelope.spec).toMatchObject({ kind: 'build', projectId: 'senet' });
    expect(build.envelope.spec.repos[0].url).toBe(fakeArtifacts.remote(repoName, OWN_ACCOUNT));
    expect(build.envelope.spec.repos[0].authToken).toMatch(/^art_v1_/);
    // A rescan reads the linked GitHub repository while the copy is at its head (same commit, same smith.json)...
    const same = await (await f.stub.execute(f.human, 'rescan-project', { projectId: 'senet' })).json() as { scan: { state: string; via: string } };
    expect(same.scan).toMatchObject({ state: 'ready', via: 'github' });
    // ...and once GitHub has moved on, a machine reads the copy itself, with a read token.
    fakeGitHub.repos.set('Red-Marmoset/senet', { defaultBranch: 'master', branches: { master: { commit: 'e'.repeat(40), smithJson: senet, paths: [], truncated: false } } });
    const rescan = await (await f.stub.execute(f.human, 'rescan-project', { projectId: 'senet' })).json() as { scan: { state: string; jobId: string | null } };
    expect(rescan.scan).toMatchObject({ state: 'waiting' });
    const scanner = await enrollRepoNode();
    const scan = await claim(f, scanner);
    expect(scan.envelope.spec).toMatchObject({ kind: 'scan', projectId: 'senet' });
    expect(scan.envelope.spec.repos[0]).toMatchObject({ url: fakeArtifacts.remote(repoName, OWN_ACCOUNT) });
    expect(scan.envelope.spec.repos[0].authToken).toMatch(/^art_v1_/);
  });
  it('exposes the mirror route only to signed-in people', async () => {
    const { default: worker } = await import('../src/index');
    const anonymous = await worker.fetch(new Request('https://exp.redmarmosetstudios.com/api/v2/workspaces/' + 'a'.repeat(64) + '/projects/smith/mirror', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"requestId":"x"}' }), env);
    expect(anonymous.status).toBe(401);
  });
});

import { createArtifacts } from '../src/artifacts-repos';
describe('repository deletion and the fake remote base', () => {
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
});
