// A job's named blob (spec §5): the original-history bundle of an import, uploaded in parts under the job lease, checked by
// size and digest, kept as an 'original' backup with a download for owners and admins.
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
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
  const started = await f.stub.execute(f.human, 'import-start', { org: 'Red-Marmoset', repos: [{ fullName: 'Red-Marmoset/tools', url: 'git@github.com:Red-Marmoset/tools.git', defaultBranch: 'main' }], thresholdBytes: 10485760, link: true });
  expect(started.status).toBe(201);
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
    // The parts are gone with the mismatch; the machine sends them again.
    for (const [n, bytes] of [[1, part1], [2, part2]] as const) expect((await blob(f, node, lease.jobId, lease.leaseToken, `original.bundle?part=${n}`, { method: 'POST', body: bytes, headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.byteLength) } })).status).toBe(200);
    const done = await blob(f, node, lease.jobId, lease.leaseToken, 'original.bundle/complete', { method: 'POST', body: JSON.stringify({ size: whole.byteLength, sha256: await sha256(whole) }), headers: { 'Content-Type': 'application/json' } });
    expect(done.status).toBe(200);
    const { key } = await done.json() as { key: string };
    expect(key).toMatch(new RegExp(`^backups/${f.workspaceId}/[a-f0-9-]{36}/original-${lease.jobId}\\.bundle$`));
    expect((await bucket.head(key))?.size).toBe(whole.byteLength);
    const stale = await blob(f, node, lease.jobId, 'not-the-lease', 'original.bundle?part=3', { method: 'POST', body: part2, headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': '1000' } });
    expect(stale.status).toBe(409);
    const originals = await runInDurableObject(f.stub, (_o, state) => state.storage.sql.exec<{ id: string; kind: string; size: number; ready: number }>("SELECT id, kind, size, ready FROM git_backups WHERE repo_id = 'tools'").toArray());
    expect(originals).toEqual([{ id: expect.any(String), kind: 'original', size: whole.byteLength, ready: 1 }]);
    // Owners and admins download it; an operator cannot.
    const operator = crypto.randomUUID();
    await runInDurableObject(f.stub, (_o, state) => { state.storage.sql.exec('INSERT INTO members (user_id, role) VALUES (?, ?)', operator, 'operator'); });
    expect((await f.stub.execute({ kind: 'human', userId: operator }, 'backup-download', { projectId: 'tools', backupId: originals[0].id })).status).toBe(403);
    const download = await f.stub.execute(f.human, 'backup-download', { projectId: 'tools', backupId: originals[0].id });
    expect(download.status).toBe(200);
    expect(await download.json()).toEqual({ key, size: whole.byteLength, name: 'tools-original-history.bundle' });
  });
  it('refuses a blob for a job that is not an import, and parts over 5 MiB', async () => {
    const f = await setup(); const { node, lease } = await importJob(f);
    const big = await blob(f, node, lease.jobId, lease.leaseToken, 'original.bundle?part=1', { method: 'POST', body: new Uint8Array(6 * 1024 * 1024), headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(6 * 1024 * 1024) } });
    expect(big.status).toBe(413);
    const other = await blob(f, node, lease.jobId, lease.leaseToken, 'something-else.bin?part=1', { method: 'POST', body: new Uint8Array(10), headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': '10' } });
    expect(other.status).toBe(409);   // only the blob the job's spec names
  });
});
