// Pull requests on a Smith-hosted copy (src/git-host.ts): the diff and merge need an agent that clones Smith-hosted
// remotes, a machine with its own current copy clones that, and the merge carries a ticket bound to the merge job that
// may write only the base branch, revoked when the job completes.
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { beforeAll, expect, it } from 'vitest';
import { hash } from '../src/http';
import { GIT_CLIENT_LABEL, GIT_HOST_LABEL, smithRemote } from '../src/git-host';
import schema from '../migrations/0001_identity.sql?raw';
import browserSchema from '../migrations/0002_browser_auth.sql?raw';
import directorySchema from '../migrations/0003_workspace_directory.sql?raw';

const origin = 'https://exp.redmarmosetstudios.com';
const commit = 'd45d5d166ff384710a2f63cfa24271395b689c41', HEAD = 'a'.repeat(40), MERGED = 'b'.repeat(40);
const project = { id: 'senet', name: 'Senet', repoUrl: 'git@github.com:Red-Marmoset/senet.git', branch: 'master', commit,
  products: [{ name: 'build', description: '', labels: [], timeoutSeconds: 1800, commands: { linux: { interpreter: 'sh', script: 'Build.sh', args: [] } } }] };
type Lease = { jobId: string; attemptId: string; leaseToken: string; leaseExpiresAt: number; nodeId: string };
type Assignment = { hasJob: boolean; envelope: { lease: Lease; spec: { kind: string; repos: { url: string; authToken: string; hostedUuid?: string }[]; pull?: Record<string, string> } } };

beforeAll(async () => { await env.DB.exec(schema); await env.DB.exec(browserSchema); await env.DB.exec(directorySchema); });

it('compares and merges on a Smith-hosted copy with a ticket that may write only the base branch', async () => {
  const id = await hash(crypto.randomUUID()); const human = { kind: 'human' as const, userId: crypto.randomUUID() };
  const stub = env.WORKSPACES.getByName(id);
  await stub.initialize(id, human.userId);
  await env.DB.prepare('INSERT OR IGNORE INTO workspaces VALUES (?, ?)').bind(id, Date.now()).run();
  expect((await stub.execute(human, 'put-project', project)).status).toBe(201);
  const labels = [GIT_HOST_LABEL, GIT_CLIENT_LABEL, 'smith-repo-projects', 'smith-pull-requests'];
  const { code } = await (await stub.execute(human, 'enrollments', {})).json() as { code: string };
  const { token } = await (await stub.execute({ kind: 'enrollment' }, 'enroll', { code, protocolVersion: 2, os: 'linux', hostname: 'desktop-sem', arch: 'x64', labels, agentVersion: 'hosted-abcdef123456' })).json() as { token: string; nodeId: string };
  const node = { kind: 'node' as const, token };
  const nodeId = (await (await stub.execute(human, 'nodes', {})).json() as { nodes: { id: string }[] }).nodes[0].id;
  await stub.execute(node, 'heartbeat', { hostname: 'desktop-sem', os: 'linux', arch: 'x64', labels, agentVersion: 'hosted-abcdef123456', hosting: { able: true, reason: '', freeBytes: 1e12 } });
  expect((await stub.execute(human, 'node-host', { nodeId, host: true })).status).toBe(200);
  expect((await stub.execute(human, 'host-project', { requestId: crypto.randomUUID(), projectId: 'senet' })).status).toBe(201);
  const claim = async () => await (await stub.execute(node, 'claim', {})).json() as Assignment;
  const complete = (a: Assignment, result: Record<string, unknown>) => stub.execute(node, 'complete', { ...a.envelope.lease, result: { exitCode: 0, durationMs: 1, message: 'done', ...result } });
  const copy = await claim();
  expect((await complete(copy, { status: 'success', host: { tips: [[commit, 'refs/heads/master']], defaultBranch: 'master', bytes: 1000 } })).status).toBe(200);

  const opened = await stub.execute(human, 'pull-open', { projectId: 'senet', branch: 'feature/x', commit: HEAD, title: 'Feature X' });
  expect(opened.status, await opened.clone().text()).toBe(201);
  const pull = await opened.json() as { id: string; baseBranch: string };
  expect(pull.baseBranch).toBe('master');
  await stub.execute(human, 'pulls', {});
  const diff = await claim();
  expect(diff.envelope.spec.kind).toBe('diff');
  expect(diff.envelope.spec.repos[0].url).toBe(smithRemote(origin, 'senet'));
  const required = await runInDurableObject(stub, (_o, state) => state.storage.sql.exec<{ required_labels: string }>('SELECT required_labels FROM jobs WHERE id = ?', diff.envelope.lease.jobId).one().required_labels);
  expect(JSON.parse(required)).toEqual(['smith-pull-requests', GIT_CLIENT_LABEL]);
  await runInDurableObject(stub, (_o, state) => { for (const name of ['pull.patch', 'pull-files.txt']) state.storage.sql.exec('INSERT INTO artifacts VALUES (?, ?, ?, ?, 1, ?, 1)', diff.envelope.lease.jobId, diff.envelope.lease.attemptId, name, 'c'.repeat(64), `k/${name}`); });
  expect((await complete(diff, { status: 'success', commit: HEAD, pull: { baseCommit: commit, mergeBase: commit, mergeable: true, conflicts: [] } })).status).toBe(200);

  expect((await stub.execute(human, 'pull-merge', { pullId: pull.id, authorName: 'Sem', authorEmail: 'sem@example.com' })).status).toBe(201);
  const merge = await claim();
  expect(merge.envelope.spec.kind).toBe('merge');
  const ticket = merge.envelope.spec.repos[0].authToken;
  expect(ticket).toMatch(/^smith_git_/);
  const row = await runInDurableObject(stub, async (_o, state) => state.storage.sql.exec<{ scope: string; job_id: string; ref_policy: string; revoked_at: number | null }>('SELECT * FROM git_tickets WHERE hash = ?', await hash(ticket)).one());
  expect(row).toMatchObject({ scope: 'write', job_id: merge.envelope.lease.jobId, revoked_at: null });
  expect(JSON.parse(row.ref_policy)).toMatchObject({ allow: ['refs/heads/master'], denyDelete: true });
  expect((await complete(merge, { status: 'success', commit: MERGED, pull: { baseCommit: commit } })).status).toBe(200);
  const merged = await (await stub.execute(human, 'pull', { pullId: pull.id })).json() as { state: string; mergeCommit: string };
  expect(merged).toMatchObject({ state: 'merged', mergeCommit: MERGED });
  const revoked = await runInDurableObject(stub, async (_o, state) => state.storage.sql.exec<{ revoked_at: number | null }>('SELECT revoked_at FROM git_tickets WHERE hash = ?', await hash(ticket)).one().revoked_at);
  expect(revoked).not.toBeNull();
});
