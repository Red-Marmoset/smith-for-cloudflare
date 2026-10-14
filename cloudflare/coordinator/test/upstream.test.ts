import { env } from 'cloudflare:workers';
import { describe, it, expect } from 'vitest';
import { fakeArtifacts, repoNameFor } from '../src/artifacts-repos';
import { fakeGitHub } from '../src/github-reader';
import { hostName, syncFailure, upstreamOf, validateUpstreamUrl } from '../src/upstream';
import type { ProjectArtifacts } from '../src/projects';
import senet from './fixtures/smith-json/senet.json?raw';

const commit = 'd45d5d166ff384710a2f63cfa24271395b689c41';
const pulled = 'a'.repeat(40);
const OWN_ACCOUNT = 'c'.repeat(32);
const GITHUB = 'git@github.com:Red-Marmoset/senet.git';
type Lease = { jobId: string; attemptId: string; leaseToken: string; leaseExpiresAt: number; nodeId: string };
type Spec = { kind: string; projectId: string; repos: { url: string; branch: string; commit: string; authToken: string }[]; mirror?: { remote: string; authToken: string; branch: string; pushTags: boolean } };
type Assignment = { hasJob: boolean; envelope: { lease: Lease; spec: Spec } };
type PublicProject = { id: string; repoUrl: string; commit: string | null; scan: { state: string; jobId: string | null }; artifacts?: ProjectArtifacts };
type SyncResponse = { project: PublicProject; job: { id: string; state: string; product: string } };

// A Git-URL project read via GitHub and copied into Smith (the workspace's own Cloudflare account).
async function setup() {
  fakeArtifacts.reset(); fakeGitHub.reset();
  const id = crypto.randomUUID(); const userId = crypto.randomUUID();
  const stub = env.WORKSPACES.getByName(id);
  await stub.initialize(id, userId);
  const human = { kind: 'human' as const, userId };
  expect((await stub.execute(human, 'put-settings', { cloudflareAccountId: OWN_ACCOUNT, cloudflareApiToken: 'cf_test_token_1234567890abcdefghij', githubToken: 'github_pat_' + 'Z9'.repeat(15) })).status).toBe(200);
  const workspaceId = (await (await stub.execute(human, 'summary', {})).json() as { id: string }).id;
  async function node(labels: string[]) {
    const { code } = await (await stub.execute(human, 'enrollments', {})).json() as { code: string };
    const response = await stub.execute({ kind: 'enrollment' }, 'enroll', { code, protocolVersion: 2, os: 'windows', hostname: 'sync-runner', arch: 'x64', labels, agentVersion: '0.3.0' });
    return { kind: 'node' as const, token: (await response.json() as { token: string }).token };
  }
  const claim = async (n: { kind: 'node'; token: string }) => await (await stub.execute(n, 'claim', {})).json() as Assignment;
  const complete = (n: { kind: 'node'; token: string }, lease: Lease, status: 'success' | 'failed', message = '', extra: Record<string, unknown> = {}) =>
    stub.execute(n, 'complete', { ...lease, result: { status, exitCode: status === 'success' ? 0 : 1, durationMs: 1, message, ...extra } });
  const project = async () => (await (await stub.execute(human, 'projects', {})).json() as { projects: PublicProject[] }).projects.find(p => p.id === 'senet')!;
  const sync = (direction: string, requestId = crypto.randomUUID()) => stub.execute(human, 'sync-project', { requestId, projectId: 'senet', direction });
  const link = (url: string) => stub.execute(human, 'link-project', { projectId: 'senet', url });

  fakeGitHub.repos.set('Red-Marmoset/senet', { defaultBranch: 'master', branches: { master: { commit, smithJson: senet, paths: [], truncated: false } } });
  expect((await stub.execute(human, 'add-repo-project', { source: 'git', url: GITHUB })).status).toBe(201);
  const repo = repoNameFor(workspaceId, 'senet');
  const syncer = await node(['smith-repo-projects', 'smith-repo-sync']);
  return { stub, human, node, claim, complete, project, sync, link, repo, syncer, remote: fakeArtifacts.remote(repo, OWN_ACCOUNT) };
}
async function copied() {
  const f = await setup();
  expect((await f.stub.execute(f.human, 'mirror-project', { requestId: crypto.randomUUID(), projectId: 'senet' })).status).toBe(201);
  const copy = await f.claim(f.syncer);
  fakeArtifacts.seed(f.repo, 'master', commit, OWN_ACCOUNT);
  expect((await f.complete(f.syncer, copy.envelope.lease, 'success', 'Pushed')).status).toBe(200);
  expect((await f.project()).artifacts).toMatchObject({ status: 'done', sourceRepoUrl: GITHUB });
  return f;
}

describe('linked repository helpers', () => {
  it('knows when a copy is linked, names the host, and turns a refused push into its next step', () => {
    const copy = { remote: fakeArtifacts.remote('abc-x'), sourceRepoUrl: GITHUB } as ProjectArtifacts;
    expect(upstreamOf(copy)).toBe(GITHUB);
    expect(upstreamOf({ ...copy, sourceRepoUrl: copy.remote })).toBe('');   // detached, or made by a crew run
    expect(upstreamOf(undefined)).toBe('');
    expect(hostName(GITHUB)).toBe('GitHub');
    expect(hostName('https://gitlab.com/a/b.git')).toBe('GitLab');
    expect(hostName('ssh://git@git.example.com:2222/a/b.git')).toBe('git.example.com');
    expect(syncFailure('push', GITHUB, 'Push failed: not a fast-forward', 'failed')).toBe('GitHub has commits that Smith’s copy does not. Pull from GitHub first; nothing was overwritten.');
    expect(syncFailure('pull', GITHUB, 'Push failed: not a fast-forward', 'failed')).toContain('Push to GitHub first');
    expect(syncFailure('pull', GITHUB, '', 'lost')).toBe('Pull ended as lost');
    expect(validateUpstreamUrl(' https://github.com/a/b.git ')).toBe('https://github.com/a/b.git');
    for (const bad of [fakeArtifacts.remote('abc-x'), 'https://user:pw@github.com/a/b.git', 'deploy@host:a/b.git', 'file:///tmp/x']) expect(() => validateUpstreamUrl(bad), bad).toThrow();
  });
});

describe('Pull, Push and Detach', () => {
  it('pulls the linked branch tip into the copy on an updated machine, verifies it and rescans', async () => {
    const f = await copied();
    const { project, job } = await (await f.sync('pull', 'pull-1')).json() as SyncResponse;
    expect(job).toMatchObject({ state: 'queued', product: 'pull-from-linked-repo' });
    expect(project.artifacts!.sync).toMatchObject({ direction: 'pull', status: 'running', jobId: job.id });
    expect((await f.sync('pull', 'pull-1')).status).toBe(201);                                       // replayed
    expect((await f.sync('push')).status).toBe(409);                                                   // one at a time
    expect((await f.link('')).status).toBe(409);                                                       // no detaching mid-sync
    // An agent that predates Pull/Push does not get the job.
    expect((await f.claim(await f.node(['smith-repo-projects']))).hasJob).toBe(false);
    const assignment = await f.claim(f.syncer);
    expect(assignment.envelope.spec).toMatchObject({ kind: 'mirror', projectId: 'senet', mirror: { remote: f.remote, branch: 'master', pushTags: true } });
    expect(assignment.envelope.spec.repos[0]).toMatchObject({ url: GITHUB, branch: 'master', commit: '', authToken: '' });
    expect(assignment.envelope.spec.mirror!.authToken).toMatch(/^art_v1_.*w/);
    const token = [...fakeArtifacts.tokens.values()].at(-1)!;
    expect(token).toMatchObject({ scope: 'write', revoked: false });
    fakeArtifacts.setHead(f.repo, 'master', pulled);
    expect((await f.complete(f.syncer, assignment.envelope.lease, 'success', 'Pushed', { commit: pulled })).status).toBe(200);
    const after = await f.project();
    expect(after.artifacts!.sync).toMatchObject({ direction: 'pull', status: 'done', commit: pulled });
    expect(after.artifacts!.sync!.tokenId).toBeUndefined();
    expect(token.revoked).toBe(true);
    expect(after.scan.state).toBe('waiting');                                                          // smith.json is read again
    const scan = await f.claim(f.syncer);
    expect(scan.envelope.spec).toMatchObject({ kind: 'scan', projectId: 'senet' });
    expect(scan.envelope.spec.repos[0].url).toBe(f.remote);
  });
  it('fails a pull whose commit never reached the copy', async () => {
    const f = await copied();
    await f.sync('pull');
    const assignment = await f.claim(f.syncer);
    await f.complete(f.syncer, assignment.envelope.lease, 'success', 'Pushed', { commit: pulled });   // the copy still holds `commit`
    expect((await f.project()).artifacts!.sync).toMatchObject({ status: 'failed', message: expect.stringContaining('not the pulled commit') });
  });
  it('pushes the copy to the linked repository with a read token only, and explains a refused push', async () => {
    const f = await copied();
    const { job } = await (await f.sync('push')).json() as SyncResponse;
    expect(job.product).toBe('push-to-linked-repo');
    const assignment = await f.claim(f.syncer);
    expect(assignment.envelope.spec.repos[0]).toMatchObject({ url: f.remote, branch: 'master', commit: '' });
    expect(assignment.envelope.spec.repos[0].authToken).toMatch(/^art_v1_.*r/);
    expect(assignment.envelope.spec.mirror).toEqual({ remote: GITHUB, authToken: '', branch: 'master', pushTags: true });   // the machine's own Git login
    await f.complete(f.syncer, assignment.envelope.lease, 'failed', `Push to ${GITHUB} failed: not a fast-forward; nothing was overwritten`);
    const after = await f.project();
    expect(after.artifacts!.sync).toMatchObject({ direction: 'push', status: 'failed', message: 'GitHub has commits that Smith’s copy does not. Pull from GitHub first; nothing was overwritten.' });
    expect([...fakeArtifacts.tokens.values()].at(-1)).toMatchObject({ scope: 'read', revoked: true });
    expect(after.repoUrl).toBe(f.remote);                                                             // builds keep using the copy
    // A successful push records what landed.
    await f.sync('push');
    const again = await f.claim(f.syncer);
    await f.complete(f.syncer, again.envelope.lease, 'success', 'Pushed', { commit });
    expect((await f.project()).artifacts!.sync).toMatchObject({ direction: 'push', status: 'done', commit });
  });
  it('settles a cancelled sync', async () => {
    const f = await copied();
    const { job } = await (await f.sync('push')).json() as SyncResponse;
    await f.stub.execute(f.human, 'cancel', { jobId: job.id });
    expect((await f.project()).artifacts!.sync).toMatchObject({ status: 'failed', message: 'Push ended as cancelled' });
  });
  it('detaches from GitHub and links again, keeping the copy and its builds', async () => {
    const f = await copied();
    const detached = await (await f.link('')).json() as PublicProject;
    expect(detached.repoUrl).toBe(f.remote);
    expect(detached.artifacts).toMatchObject({ status: 'done', sourceRepoUrl: f.remote, detachedFrom: GITHUB });
    expect(detached.artifacts!.sync).toBeUndefined();
    expect((await f.sync('pull')).status).toBe(409);
    expect((await f.link('')).status).toBe(409);
    expect((await f.link(f.remote)).status).toBe(400);
    expect((await f.link('https://x:pw@github.com/a/b.git')).status).toBe(400);
    const relinked = await (await f.link('https://github.com/Red-Marmoset/senet-new.git')).json() as PublicProject;
    expect(relinked.artifacts).toMatchObject({ sourceRepoUrl: 'https://github.com/Red-Marmoset/senet-new.git' });
    expect(relinked.artifacts!.detachedFrom).toBeUndefined();
    expect((await f.sync('push')).status).toBe(201);
  });
  it('needs a copy in Smith, a valid direction and an admin', async () => {
    const f = await setup();
    expect((await f.sync('pull')).status).toBe(409);                                                   // not copied yet
    expect((await f.link('')).status).toBe(409);
    expect((await f.sync('sideways')).status).toBe(400);
    const { default: worker } = await import('../src/index');
    for (const route of ['sync', 'upstream']) {
      const anonymous = await worker.fetch(new Request(`https://exp.redmarmosetstudios.com/api/v2/workspaces/${'a'.repeat(64)}/projects/senet/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }), env);
      expect(anonymous.status).toBe(401);
    }
  });
});
