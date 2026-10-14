import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import worker from '../src/index';
import { hash } from '../src/http';
import schema from '../migrations/0001_identity.sql?raw';
import browserSchema from '../migrations/0002_browser_auth.sql?raw';
import directorySchema from '../migrations/0003_workspace_directory.sql?raw';
const origin = 'https://exp.redmarmosetstudios.com';
beforeAll(async () => { await env.DB.exec(schema); await env.DB.exec(browserSchema); await env.DB.exec(directorySchema); });
const project = { id: 'fork', name: 'Fork', repoUrl: 'https://github.com/customer/smith.git', branch: 'main', commit: 'a'.repeat(40),
  products: [{ name: 'release', commands: { windows: { interpreter: 'ps1', script: 'build.ps1', args: [] } }, artifacts: { globs: ['out/release.zip'], package: 'none' } }] };
type Nodes = { nodes: { id: string; active: boolean; lastSeenAt: number; hostname: string }[] };
type Assignment = { hasJob: boolean; envelope: { workspaceId: string; lease: { jobId: string; attemptId: string; leaseToken: string; leaseExpiresAt: number; nodeId: string } } };

async function person() {
  const userId = crypto.randomUUID(), token = crypto.randomUUID();
  await env.DB.batch([env.DB.prepare('INSERT INTO users (id, created_at) VALUES (?, ?)').bind(userId, Date.now()),
    env.DB.prepare('INSERT INTO sessions (token_hash,user_id,expires_at) VALUES (?,?,?)').bind(await hash(token), userId, Date.now() + 600000)]);
  async function request(path: string, credential = token, body?: unknown, headers: Record<string, string> = {}) {
    return worker.fetch(new Request(origin + path, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) }), env);
  }
  async function workspace(requestId: string) {
    const created = await (await request('/api/v2/workspaces', token, { requestId })).json() as { workspaceId: string };
    return '/api/v2/workspaces/' + created.workspaceId;
  }
  return { request, workspace, token };
}
const beat = { hostname: 'build-pc', os: 'windows', arch: 'x64', labels: [], agentVersion: '0.1.0' };

describe('a machine serves every workspace of its owner', () => {
  it('shows online in all of them and builds for any of them through its home routes', async () => {
    const p = await person();
    const home = await p.workspace('home'), other = await p.workspace('other');
    const code = await (await p.request(home + '/enrollments', p.token, {})).json() as { code: string };
    const node = await (await p.request(home + '/nodes/enroll', '', { code: code.code, os: 'windows', protocolVersion: 2, hostname: 'build-pc' })).json() as { token: string; nodeId: string };
    expect(((await (await p.request(other + '/nodes')).json()) as Nodes).nodes).toEqual([]);
    // The agent only ever talks to its home workspace.
    expect((await p.request(home + '/heartbeat', node.token, beat)).status).toBe(200);
    const listed = (await (await p.request(other + '/nodes')).json()) as Nodes;
    expect(listed.nodes).toMatchObject([{ id: node.nodeId, active: true, hostname: 'build-pc' }]);
    expect(Date.now() - listed.nodes[0].lastSeenAt).toBeLessThan(5000);
    // A build queued in the other workspace is claimed from home, and its follow-ups find their way back.
    expect((await p.request(other + '/projects', p.token, project)).status).toBe(201);
    const job = await (await p.request(other + '/jobs', p.token, { requestId: crypto.randomUUID(), projectId: 'fork', product: 'release' })).json() as { id: string };
    const assignment = await (await p.request(home + '/claims', node.token, {})).json() as Assignment;
    expect(assignment.hasJob).toBe(true);
    expect(assignment.envelope.workspaceId).toBe(home.split('/').at(-1));
    expect(assignment.envelope.lease.jobId).toBe(job.id);
    const lease = assignment.envelope.lease;
    expect((await p.request(home + '/renew', node.token, lease)).status).toBe(200);
    expect((await p.request(home + '/logs', node.token, { ...lease, seq: 0, stream: 'stdout', lines: ['built'] })).status).toBe(200);
    const bytes = 'release payload';
    const uploaded = await worker.fetch(new Request(origin + home + '/artifacts', { method: 'POST', body: bytes, headers: { Authorization: `Bearer ${node.token}`, 'Content-Type': 'application/octet-stream',
      'Content-Length': String(bytes.length), 'X-Smith-Job-Id': job.id, 'X-Smith-Attempt-Id': lease.attemptId, 'X-Smith-Lease-Token': lease.leaseToken, 'X-Smith-Artifact-Name': 'release.zip', 'X-Smith-SHA256': await hash(bytes) } }), env);
    expect(uploaded.status).toBe(201);
    expect((await p.request(home + '/complete', node.token, { ...lease, result: { status: 'success', exitCode: 0, durationMs: 5, message: '' } })).status).toBe(200);
    expect(await (await p.request(other + '/jobs/' + job.id)).json()).toMatchObject({ state: 'success', artifacts: [{ name: 'release.zip' }] });
    expect(await (await p.request(home + '/claims', node.token, {})).json()).toEqual({ hasJob: false });
  });
  it('hands out and completes a linked workspace’s large-file tasks through the home routes', async () => {
    const p = await person();
    const home = await p.workspace('home'), other = await p.workspace('other');
    const otherId = other.split('/').at(-1)!;
    const code = await (await p.request(home + '/enrollments', p.token, {})).json() as { code: string };
    const node = await (await p.request(home + '/nodes/enroll', '', { code: code.code, os: 'linux', protocolVersion: 2, hostname: 'build-pc', labels: ['git-lfs'] })).json() as { token: string; nodeId: string };
    expect((await p.request(home + '/heartbeat', node.token, { ...beat, os: 'linux', hosting: { able: true, reason: '', free: 50 * 1024 * 1024 * 1024 } })).status).toBe(200);
    // The other workspace keeps one large file and switches the machine on for copies.
    expect((await p.request(other + '/projects', p.token, project)).status).toBe(201);
    const { token: pat } = await (await p.request(other + '/tokens', p.token, { name: 'lfs', scopes: ['read', 'build'], expiresInDays: null })).json() as { token: string };
    const bytes = new TextEncoder().encode('linked copy'); const oid = await hash('linked copy');   // sha256 hex of the bytes
    const stub = env.WORKSPACES.getByName(otherId);
    await stub.execute({ kind: 'token', token: pat }, 'lfs-write', { repo: 'fork', step: 'batch', username: '', objects: [{ oid, size: bytes.byteLength }], presign: false });
    await (env as unknown as { GIT: R2Bucket }).GIT.put(`lfs/${otherId}/fork/${oid}`, bytes);
    await stub.execute({ kind: 'token', token: pat }, 'lfs-write', { repo: 'fork', step: 'stored', oid, size: bytes.byteLength });
    expect((await p.request(other + `/nodes/${node.nodeId}/host`, p.token, { host: true })).status).toBe(200);
    const polled = await (await p.request(home + '/git/poll', node.token, {})).json() as { lfs: { id: string; leaseToken: string; oid: string }[] };
    expect(polled.lfs).toHaveLength(1);
    expect(polled.lfs[0].oid).toBe(oid);
    expect(polled.lfs[0].leaseToken.startsWith(`lw.${otherId}.`)).toBe(true);   // routed to the workspace that owns the task
    const body = await worker.fetch(new Request(`${origin}${home}/lfs/task/${polled.lfs[0].id}/body`, { headers: { Authorization: `Bearer ${node.token}`, 'X-Smith-Lease-Token': polled.lfs[0].leaseToken } }), env);
    expect(body.status).toBe(200);
    expect(new Uint8Array(await body.arrayBuffer())).toEqual(bytes);
    const done = await worker.fetch(new Request(`${origin}${home}/lfs/task/${polled.lfs[0].id}/complete`, { method: 'POST', headers: { Authorization: `Bearer ${node.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ taskId: polled.lfs[0].id, leaseToken: polled.lfs[0].leaseToken, ok: true, message: '' }) }), env);
    expect(done.status).toBe(200);
    expect(((await (await p.request(other + '/projects')).json()) as { projects: { lfs: { copies: { held: number }[] } }[] }).projects[0].lfs.copies).toEqual([{ hostname: 'build-pc', held: 1, current: true }]);
  });
  it('stays out of a workspace that removed it, and never reaches another person\'s workspace', async () => {
    const p = await person(), stranger = await person();
    const home = await p.workspace('home'), other = await p.workspace('other'), theirs = await stranger.workspace('theirs');
    const code = await (await p.request(home + '/enrollments', p.token, {})).json() as { code: string };
    const node = await (await p.request(home + '/nodes/enroll', '', { code: code.code, os: 'windows', protocolVersion: 2 })).json() as { token: string; nodeId: string };
    expect((await p.request(home + '/heartbeat', node.token, beat)).status).toBe(200);
    expect((await p.request(other + `/nodes/${node.nodeId}/revoke`, p.token, {})).status).toBe(200);
    expect((await p.request(home + '/heartbeat', node.token, beat)).status).toBe(200);
    expect(((await (await p.request(other + '/nodes')).json()) as Nodes).nodes.filter(n => n.active)).toEqual([]);
    expect(((await (await stranger.request(theirs + '/nodes')).json()) as Nodes).nodes).toEqual([]);
    // A lease token naming a workspace the machine is not in is refused there.
    const forged = { jobId: crypto.randomUUID(), attemptId: crypto.randomUUID(), leaseToken: `lw.${theirs.split('/').at(-1)}.x`, leaseExpiresAt: 0, nodeId: node.nodeId };
    expect((await p.request(home + '/renew', node.token, forged)).status).toBe(401);
  });
});
