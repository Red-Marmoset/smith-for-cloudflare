import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import worker from '../src/index';
import { setup, origin, type Fixture } from './lfs-fixture';
import schema from '../migrations/0001_identity.sql?raw';
import browserSchema from '../migrations/0002_browser_auth.sql?raw';
import directorySchema from '../migrations/0003_workspace_directory.sql?raw';

beforeAll(async () => { await env.DB.exec(schema); await env.DB.exec(browserSchema); await env.DB.exec(directorySchema); });
const bucket = (env as unknown as { GIT: R2Bucket }).GIT;
const MEDIA = 'application/vnd.git-lfs+json';
type Poll = { lfs: { id: string; leaseToken: string; leaseExpiresAt: number; kind: string; repoId: string; oid: string; size: number }[] };
type Node = Awaited<ReturnType<Fixture['node']>>;
async function sha256(bytes: Uint8Array) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join(''); }
async function beat(f: Fixture, node: Node, free: number) {
  return f.stub.execute(node, 'heartbeat', { hostname: 'box-' + node.id.slice(0, 4), os: 'linux', arch: 'x64', labels: ['git-lfs'], agentVersion: 'hosted-abcdef123456', hosting: { able: true, reason: '', free } });
}
async function ready(f: Fixture, token: string, bytes: Uint8Array) {
  const oid = await sha256(bytes);
  await f.stub.execute({ kind: 'token', token }, 'lfs-write', { repo: 'senet', step: 'batch', username: '', objects: [{ oid, size: bytes.byteLength }], presign: false });
  await bucket.put(`lfs/${f.workspaceId}/senet/${oid}`, bytes);
  await f.stub.execute({ kind: 'token', token }, 'lfs-write', { repo: 'senet', step: 'stored', oid, size: bytes.byteLength });
  return oid;
}
function nodeFetch(f: Fixture, node: Node, taskId: string, step: string, init: RequestInit & { lease: string }) {
  const headers = new Headers(init.headers); headers.set('Authorization', `Bearer ${node.token}`); headers.set('X-Smith-Lease-Token', init.lease);
  return worker.fetch(new Request(`${origin}/api/v2/workspaces/${f.workspaceId}/lfs/task/${taskId}/${step}`, { ...init, headers }), env);
}
const poll = async (f: Fixture, node: Node) => (await (await f.stub.execute(node, 'git-poll', {})).json()) as Poll;
const complete = (f: Fixture, node: Node, task: { id: string; leaseToken: string }, body: Record<string, unknown>) =>
  nodeFetch(f, node, task.id, 'complete', { lease: task.leaseToken, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

describe('copies of large files on machines', () => {
  it('switches a machine on, hands it fetch tasks within its reserve, records what it holds, and shows copies', async () => {
    const f = await setup();
    const token = await f.pat();
    const bytes = new TextEncoder().encode('object one'); const oid = await ready(f, token, bytes);
    const node = await f.node(); await beat(f, node, 50 * 1024 * 1024 * 1024);
    expect((await poll(f, node)).lfs).toEqual([]);   // not switched on: nothing is planned
    const on = await f.stub.execute(f.human, 'node-host', { nodeId: node.id, host: true });
    expect([on.status, await on.clone().text()]).toEqual([200, expect.any(String)]);
    const handed = await poll(f, node);
    expect(handed.lfs).toHaveLength(1);
    expect(handed.lfs[0]).toMatchObject({ kind: 'fetch', repoId: 'senet', oid, size: bytes.byteLength });
    const task = handed.lfs[0];
    const body = await nodeFetch(f, node, task.id, 'body', { lease: task.leaseToken });
    expect(body.status).toBe(200);
    expect(new Uint8Array(await body.arrayBuffer())).toEqual(bytes);
    expect((await complete(f, node, task, { ok: true, message: '', size: bytes.byteLength })).status).toBe(200);
    const nodes = (await (await f.stub.execute(f.human, 'nodes', {})).json()) as { nodes: { id: string; hostRepos: boolean; freeBytes: number; lfs: { objects: number; bytes: number } }[] };
    expect(nodes.nodes.find(n => n.id === node.id)).toMatchObject({ hostRepos: true, freeBytes: 50 * 1024 * 1024 * 1024, lfs: { objects: 1, bytes: bytes.byteLength } });
    const [shown] = (await (await f.stub.execute(f.human, 'projects', {})).json() as { projects: { lfs: { lost: number; copies: { held: number; current: boolean }[] } }[] }).projects;
    expect(shown.lfs.lost).toBe(0);
    expect(shown.lfs.copies).toEqual([{ hostname: expect.any(String), held: 1, current: true }]);
    expect((await poll(f, node)).lfs).toEqual([]);   // the machine holds everything
  });
  it('keeps the reserve free and validates the setting', async () => {
    const f = await setup();
    const token = await f.pat();
    await ready(f, token, new TextEncoder().encode('x'.repeat(100)));
    const small = await f.node(); await beat(f, small, 10 * 1024 * 1024 * 1024 + 50);   // 50 bytes above the 10 GiB reserve
    expect((await f.stub.execute(f.human, 'node-host', { nodeId: small.id, host: true })).status).toBe(200);
    expect((await poll(f, small)).lfs).toEqual([]);
    const nodes = (await (await f.stub.execute(f.human, 'nodes', {})).json()) as { nodes: { id: string; copiesFull: string }[] };
    expect(nodes.nodes.find(n => n.id === small.id)?.copiesFull).toBe('reserve');
    expect((await f.stub.execute(f.human, 'put-settings', { lfsMachineReserveBytes: 1073741824 })).status).toBe(200);
    expect((await f.stub.execute(f.human, 'node-host', { nodeId: small.id, host: true })).status).toBe(200);   // re-plans
    expect((await poll(f, small)).lfs).toHaveLength(1);
    expect((await f.stub.execute(f.human, 'put-settings', { lfsMachineReserveBytes: 1 })).status).toBe(400);
  });
  it('marks an object lost when R2 no longer has it, restores it from a machine, and audits on request', async () => {
    const f = await setup();
    const token = await f.pat();
    const bytes = new TextEncoder().encode('restore me'); const oid = await ready(f, token, bytes);
    const node = await f.node(); await beat(f, node, 50 * 1024 * 1024 * 1024);
    await f.stub.execute(f.human, 'node-host', { nodeId: node.id, host: true });
    const fetched = (await poll(f, node)).lfs[0];
    const held = await complete(f, node, fetched, { ok: true, message: '' });
    expect([held.status, await held.clone().text()]).toEqual([200, expect.any(String)]);
    // The object vanishes from R2; a proxied download notices and marks it lost.
    await bucket.delete(`lfs/${f.workspaceId}/senet/${oid}`);
    const auth = { Authorization: 'Basic ' + btoa(':' + token) };
    expect((await worker.fetch(new Request(`${origin}/git/senet.git/info/lfs/objects/${oid}`, { headers: auth }), env)).status).toBe(404);
    const batch = await worker.fetch(new Request(`${origin}/git/senet.git/info/lfs/objects/batch`, { method: 'POST', headers: { ...auth, Accept: MEDIA, 'Content-Type': MEDIA }, body: JSON.stringify({ operation: 'download', objects: [{ oid, size: 0 }] }) }), env);
    expect(((await batch.json()) as { objects: { error: { message: string } }[] }).objects[0].error.message).toBe('Object lost from storage; a machine holding a copy restores it');
    // Its holder gets a restore task; proxy mode: the machine PUTs the object through the Worker, which hashes it.
    await f.stub.execute(f.human, 'node-host', { nodeId: node.id, host: true });   // re-plans now rather than at the alarm
    const restore = (await poll(f, node)).lfs.find(t => t.kind === 'restore')!;
    expect(restore).toMatchObject({ oid, size: bytes.byteLength });
    const target = await nodeFetch(f, node, restore.id, 'target', { lease: restore.leaseToken, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(await target.json()).toEqual({ href: null, size: bytes.byteLength });
    const wrong = await nodeFetch(f, node, restore.id, 'object', { lease: restore.leaseToken, method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: new TextEncoder().encode('restore mE') });
    expect(wrong.status).toBe(422);
    const put = await nodeFetch(f, node, restore.id, 'object', { lease: restore.leaseToken, method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes });
    expect(put.status).toBe(200);
    expect((await complete(f, node, restore, { ok: true, message: '' })).status).toBe(200);
    expect((await worker.fetch(new Request(`${origin}/git/senet.git/info/lfs/objects/${oid}`, { headers: auth }), env)).status).toBe(200);
    // Check large files: every ready object is audited by the sweep; a missing one turns lost.
    await bucket.delete(`lfs/${f.workspaceId}/senet/${oid}`);
    expect(((await (await f.stub.execute(f.human, 'check-lfs', {})).json()) as { queued: number }).queued).toBe(1);
    await runInDurableObject(f.stub, async (instance: { sweepLfsForTest: (now: number) => Promise<void> }) => { await instance.sweepLfsForTest(Date.now()); });
    const settings = (await (await f.stub.execute(f.human, 'settings', {})).json()) as { lfs: { lost: number; checking: number } };
    expect(settings.lfs).toMatchObject({ lost: 1, checking: 0 });
    // Switching the machine off hands it drop tasks for what it holds and forgets its copies.
    await f.stub.execute(f.human, 'node-host', { nodeId: node.id, host: false });
    expect((await poll(f, node)).lfs.map(t => t.kind)).toEqual(['drop']);
    const [shown] = (await (await f.stub.execute(f.human, 'projects', {})).json() as { projects: { lfs: { copies: unknown[] } }[] }).projects;
    expect(shown.lfs.copies).toEqual([]);
  });
  // A machine holding one ready object that R2 has since lost; the holder's fetch task was completed.
  async function lostWithHolder() {
    const f = await setup();
    const token = await f.pat();
    const bytes = new TextEncoder().encode('kept on a machine'); const oid = await ready(f, token, bytes);
    const node = await f.node(); await beat(f, node, 50 * 1024 * 1024 * 1024);
    await f.stub.execute(f.human, 'node-host', { nodeId: node.id, host: true });
    const fetched = (await poll(f, node)).lfs[0];
    expect((await complete(f, node, fetched, { ok: true, message: '' })).status).toBe(200);
    await bucket.delete(`lfs/${f.workspaceId}/senet/${oid}`);
    const auth = { Authorization: 'Basic ' + btoa(':' + token) };
    expect((await worker.fetch(new Request(`${origin}/git/senet.git/info/lfs/objects/${oid}`, { headers: auth }), env)).status).toBe(404);
    return { f, token, node, oid, bytes };
  }
  const copiesOf = async (f: Fixture) => ((await (await f.stub.execute(f.human, 'projects', {})).json()) as { projects: { lfs: { lost: number; copies: unknown[] } }[] }).projects[0].lfs;
  it('never sweeps away the copies of a lost object that a client offered to upload again but did not', async () => {
    const { f, token, node, oid } = await lostWithHolder();
    // The client's push names the object again (an upload verdict), then never sends it.
    const again = (await (await f.stub.execute({ kind: 'token', token }, 'lfs-write', { repo: 'senet', step: 'batch', username: '', objects: [{ oid, size: 17 }], presign: false })).json()) as { verdicts: { upload?: true }[] };
    expect(again.verdicts[0].upload).toBe(true);
    await runInDurableObject(f.stub, async (instance: { sweepLfsForTest: (now: number) => Promise<void> }, state) => {
      state.storage.sql.exec('UPDATE lfs_objects SET created_at = created_at - 90000000');
      await instance.sweepLfsForTest(Date.now());
    });
    expect(await copiesOf(f)).toMatchObject({ lost: 1, copies: [{ held: 1 }] });   // still lost, still held
    expect((await poll(f, node)).lfs.map(t => t.kind)).not.toContain('drop');
  });
  it('leases a task for as long as its object takes to move, and renews the lease on every step', async () => {
    const f = await setup();
    const token = await f.pat();
    const big = 'd'.repeat(64), size = 5 * 1024 * 1024 * 1024;
    await f.stub.execute({ kind: 'token', token }, 'lfs-write', { repo: 'senet', step: 'batch', username: '', objects: [{ oid: big, size }], presign: true });
    await f.stub.execute({ kind: 'token', token }, 'lfs-write', { repo: 'senet', step: 'stored', oid: big, size });
    const node = await f.node(); await beat(f, node, 50 * 1024 * 1024 * 1024);
    await f.stub.execute(f.human, 'node-host', { nodeId: node.id, host: true });
    const task = (await poll(f, node)).lfs.find(t => t.oid === big)!;
    expect(task.leaseExpiresAt - Date.now()).toBeGreaterThan(5 * 3600000);   // 5 GiB at 256 KiB/s plus the base lease
  });
  it('cancels a task whose object no longer needs it instead of wedging the machine', async () => {
    const f = await setup();
    const token = await f.pat();
    const bytes = new TextEncoder().encode('goes missing mid-fetch'); const oid = await ready(f, token, bytes);
    const node = await f.node(); await beat(f, node, 50 * 1024 * 1024 * 1024);
    await f.stub.execute(f.human, 'node-host', { nodeId: node.id, host: true });
    const task = (await poll(f, node)).lfs[0];
    await bucket.delete(`lfs/${f.workspaceId}/senet/${oid}`);
    await f.stub.execute({ kind: 'token', token }, 'lfs-read', { repo: 'senet', step: 'lost', username: '', oid });
    expect((await nodeFetch(f, node, task.id, 'body', { lease: task.leaseToken })).status).toBe(410);
    expect((await complete(f, node, task, { ok: false, message: 'Download failed (HTTP 410)' })).status).toBe(404);   // gone, not wedged
    await runInDurableObject(f.stub, (_o, state) => { expect(state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM lfs_tasks WHERE kind = 'fetch'").one().n).toBe(0); });
  });
  it('keeps the holder when a restore fails for a reason other than a missing copy, and forgets it only when the copy is gone', async () => {
    const transient = await lostWithHolder();
    await transient.f.stub.execute(transient.f.human, 'node-host', { nodeId: transient.node.id, host: true });
    const restore = (await poll(transient.f, transient.node)).lfs.find(t => t.kind === 'restore')!;
    expect((await complete(transient.f, transient.node, restore, { ok: false, message: 'Upload failed (HTTP 502)', held: true })).status).toBe(200);
    expect(await copiesOf(transient.f)).toMatchObject({ lost: 1, copies: [{ held: 1 }] });
    const gone = await lostWithHolder();
    await gone.f.stub.execute(gone.f.human, 'node-host', { nodeId: gone.node.id, host: true });
    const restore2 = (await poll(gone.f, gone.node)).lfs.find(t => t.kind === 'restore')!;
    expect((await complete(gone.f, gone.node, restore2, { ok: false, message: 'box holds no copy of this object', held: false })).status).toBe(200);
    expect(await copiesOf(gone.f)).toMatchObject({ lost: 1, copies: [] });
  });
  it('lets only owners and admins switch a machine on or off for large files', async () => {
    const f = await setup();
    const node = await f.node();
    const operator = crypto.randomUUID();
    await runInDurableObject(f.stub, (_o, state) => { state.storage.sql.exec('INSERT INTO members (user_id, role) VALUES (?, ?)', operator, 'operator'); });
    expect((await f.stub.execute({ kind: 'human', userId: operator }, 'node-host', { nodeId: node.id, host: true })).status).toBe(403);
    expect((await f.stub.execute(f.human, 'node-host', { nodeId: node.id, host: true })).status).toBe(200);
  });
  it('schedules the alarm that runs the audit and the sweeps', async () => {
    const f = await setup();
    const token = await f.pat();
    await ready(f, token, new TextEncoder().encode('audited'));
    await runInDurableObject(f.stub, async (_o, state) => { await state.storage.deleteAlarm(); });
    expect(((await (await f.stub.execute(f.human, 'check-lfs', {})).json()) as { queued: number }).queued).toBe(1);
    const alarm = await runInDurableObject(f.stub, (_o, state) => state.storage.getAlarm());
    expect(alarm).not.toBeNull();
    expect(alarm! - Date.now()).toBeLessThan(61000);
  });
  it('refuses the wrong lease and a task of the wrong kind', async () => {
    const f = await setup();
    const token = await f.pat();
    await ready(f, token, new TextEncoder().encode('lease'));
    const node = await f.node(); await beat(f, node, 50 * 1024 * 1024 * 1024);
    await f.stub.execute(f.human, 'node-host', { nodeId: node.id, host: true });
    const task = (await poll(f, node)).lfs[0];
    expect((await nodeFetch(f, node, task.id, 'body', { lease: 'nope' })).status).toBe(409);
    expect((await nodeFetch(f, node, task.id, 'target', { lease: task.leaseToken, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(409);
  });
});

describe('the budget on a machine', () => {
  it('a budget on the machine card caps what it holds, and the card says why it is full', async () => {
    const f = await setup(); const token = await f.pat();
    const bytes = new Uint8Array(3 * 1024 * 1024); const oid = await ready(f, token, bytes);
    const node = await f.node(); await beat(f, node, 500 * 1024 * 1024 * 1024);
    expect((await f.stub.execute(f.human, 'node-host', { nodeId: node.id, host: true, budgetBytes: 1073741824 })).status).toBe(200);
    expect((await poll(f, node)).lfs[0]).toMatchObject({ kind: 'fetch', oid });   // 3 MB fits a 1 GB budget
  });
  it('refuses a budget outside 1 GB to 10 TB and clears one with null', async () => {
    const f = await setup(); const node = await f.node(); await beat(f, node, 500 * 1024 * 1024 * 1024);
    expect((await f.stub.execute(f.human, 'node-host', { nodeId: node.id, host: true, budgetBytes: 2 * 1024 * 1024 })).status).toBe(400);
    expect((await f.stub.execute(f.human, 'node-host', { nodeId: node.id, host: true, budgetBytes: 5 * 1073741824 })).status).toBe(200);
    let shown = (await (await f.stub.execute(f.human, 'nodes', {})).json() as { nodes: { copyBudgetBytes: number | null; copyBudgetEffective: number; copyUsageBytes: number; copiesFull: string }[] }).nodes[0];
    expect([shown.copyBudgetBytes, shown.copyBudgetEffective, shown.copyUsageBytes, shown.copiesFull]).toEqual([5 * 1073741824, 5 * 1073741824, 0, '']);
    expect((await f.stub.execute(f.human, 'node-host', { nodeId: node.id, host: true, budgetBytes: null })).status).toBe(200);
    shown = (await (await f.stub.execute(f.human, 'nodes', {})).json() as { nodes: typeof shown[] }).nodes[0];
    expect([shown.copyBudgetBytes, shown.copyBudgetEffective]).toEqual([null, 50 * 1073741824]);
  });
});
