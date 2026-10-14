import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { hash } from '../src/http';
import { HostedGit, newTicket } from '../src/git-host';
import { setup, origin, project, oidA, oidB } from './lfs-fixture';
import schema from '../migrations/0001_identity.sql?raw';
import browserSchema from '../migrations/0002_browser_auth.sql?raw';
import directorySchema from '../migrations/0003_workspace_directory.sql?raw';

type Verdicts = { verdicts: ({ oid: string; size: number; have?: true; upload?: true; error?: { code: number; message: string } })[]; who: string };

beforeAll(async () => { await env.DB.exec(schema); await env.DB.exec(browserSchema); await env.DB.exec(directorySchema); });

describe('lfs durable object actions', () => {
  it('answers a download batch from the record and an upload batch with pending rows', async () => {
    const f = await setup();
    const token = await f.pat();
    const down = await f.stub.execute({ kind: 'token', token }, 'lfs-read', { repo: 'senet', step: 'batch', username: '', objects: [{ oid: oidA, size: 3 }] });
    expect(down.status).toBe(200);
    expect((await down.json() as Verdicts).verdicts).toEqual([{ oid: oidA, size: 3, error: { code: 404, message: 'Object not found' } }]);
    const up = await f.stub.execute({ kind: 'token', token }, 'lfs-write', { repo: 'senet', step: 'batch', username: '', objects: [{ oid: oidA, size: 3 }, { oid: oidA, size: 3 }, { oid: oidB, size: 5 }], presign: false });
    expect(up.status).toBe(200);
    const body = await up.json() as Verdicts;
    expect(body.who).toBe('member');
    expect(body.verdicts).toEqual([{ oid: oidA, size: 3, upload: true }, { oid: oidA, size: 3, upload: true }, { oid: oidB, size: 5, upload: true }]);
    const stored = await f.stub.execute({ kind: 'token', token }, 'lfs-write', { repo: 'senet', step: 'stored', oid: oidA, size: 3 });
    expect(stored.status).toBe(200);
    expect((await stored.json() as { row: { state: string } }).row.state).toBe('ready');
    const again = await (await f.stub.execute({ kind: 'token', token }, 'lfs-write', { repo: 'senet', step: 'batch', username: '', objects: [{ oid: oidA, size: 3 }, { oid: oidA, size: 4 }], presign: false })).json() as Verdicts;
    expect(again.verdicts).toEqual([{ oid: oidA, size: 3, have: true }, { oid: oidA, size: 4, error: { code: 422, message: 'Object exists with a different size (3 bytes)' } }]);
    const have = await (await f.stub.execute({ kind: 'token', token }, 'lfs-read', { repo: 'senet', step: 'batch', username: '', objects: [{ oid: oidA, size: 0 }] })).json() as Verdicts;
    expect(have.verdicts).toEqual([{ oid: oidA, size: 3, have: true }]);
    const authorize = await f.stub.execute({ kind: 'token', token }, 'lfs-read', { repo: 'senet', step: 'authorize', oid: oidA });
    expect(authorize.status).toBe(200);
    expect((await f.stub.execute({ kind: 'token', token }, 'lfs-read', { repo: 'senet', step: 'authorize', oid: oidB })).status).toBe(404);   // pending is not downloadable
  });
  it('applies caps and the quota once per batch', async () => {
    const f = await setup();
    const token = await f.pat();
    const capped = await (await f.stub.execute({ kind: 'token', token }, 'lfs-write', { repo: 'senet', step: 'batch', username: '', objects: [{ oid: oidA, size: 104857601 }, { oid: oidB, size: 5368709121 }], presign: false })).json() as Verdicts;
    expect(capped.verdicts[0].error).toEqual({ code: 413, message: 'Objects over 100 MB need direct uploads to R2; see Settings → Large files' });
    expect(capped.verdicts[1].error).toEqual({ code: 413, message: 'Objects over 5 GB cannot be stored' });
    const direct = await (await f.stub.execute({ kind: 'token', token }, 'lfs-write', { repo: 'senet', step: 'batch', username: '', objects: [{ oid: oidA, size: 104857601 }], presign: true })).json() as Verdicts;
    expect(direct.verdicts[0]).toEqual({ oid: oidA, size: 104857601, upload: true });
    const over = await f.stub.execute({ kind: 'token', token }, 'lfs-write', { repo: 'senet', step: 'batch', username: '', objects: [{ oid: oidB, size: 5368709120 }], presign: true });
    expect(over.status).toBe(507);
    expect(((await over.json()) as { error: { message: string } }).error.message).toBe('Smith keeps 5 GB of large files for this workspace; this push needs 5.1 GB');
  });
  it('refuses the wrong scope, the wrong workspace, an unknown project and a foreign ticket', async () => {
    const f = await setup();
    const reader = await f.pat(['read']);
    const refused = await f.stub.execute({ kind: 'token', token: reader }, 'lfs-write', { repo: 'senet', step: 'batch', username: '', objects: [], presign: false });
    expect(refused.status).toBe(403);
    expect((await f.stub.execute({ kind: 'token', token: reader }, 'lfs-read', { repo: 'senet', step: 'batch', username: '0'.repeat(12), objects: [] })).status).toBe(401);
    expect((await f.stub.execute({ kind: 'token', token: reader }, 'lfs-read', { repo: 'nope', step: 'batch', username: '', objects: [] })).status).toBe(404);
    // A ticket minted for another repository id never reaches this project's objects.
    const ticket = newTicket(f.workspaceId);
    await f.stub.execute(f.human, 'put-project', { ...project, id: 'other', name: 'Other' });
    const box = await f.node();
    const ticketHash = await hash(ticket);
    await runInDurableObject(f.stub, (_o, state) => {
      new HostedGit(state.storage.sql, f.workspaceId, origin).issueTicket(ticketHash, 'other', 'read', { nodeId: box.id, jobId: null, ttlMs: 3600000, label: 'build' }, Date.now());
    });
    const foreign = await f.stub.execute({ kind: 'ticket', token: ticket, nodeToken: box.token }, 'lfs-read', { repo: 'senet', step: 'batch', username: '', objects: [{ oid: oidA, size: 1 }] });
    expect([401, 403, 404]).toContain(foreign.status);
    const own = await f.stub.execute({ kind: 'ticket', token: ticket, nodeToken: box.token }, 'lfs-read', { repo: 'other', step: 'batch', username: '', objects: [{ oid: oidA, size: 1 }] });
    expect(own.status).toBe(200);
  });
});

describe('lfs settings, project usage and sweeps', () => {
  it('shows mode and usage in settings and on the project, and sweeps stale pending rows and deleted projects', async () => {
    const f = await setup();
    const token = await f.pat();
    await f.stub.execute({ kind: 'token', token }, 'lfs-write', { repo: 'senet', step: 'batch', username: '', objects: [{ oid: oidA, size: 3 }, { oid: oidB, size: 5 }], presign: false });
    await f.stub.execute({ kind: 'token', token }, 'lfs-write', { repo: 'senet', step: 'stored', oid: oidA, size: 3 });
    const settings = await (await f.stub.execute(f.human, 'settings', {})).json() as { lfs: { mode: string; proxyMaxBytes: number; objects: number; bytes: number }; lfsQuotaBytes: number };
    expect(settings.lfs).toMatchObject({ mode: 'proxy', proxyMaxBytes: 104857600, objects: 2, bytes: 8 });
    expect(settings.lfsQuotaBytes).toBe(5368709120);
    const [shown] = (await (await f.stub.execute(f.human, 'projects', {})).json() as { projects: { id: string; lfs: { objects: number; bytes: number } }[] }).projects;
    expect(shown.lfs).toMatchObject({ objects: 2, bytes: 8 });
    // The quota is the setting: 4 bytes allowed, 8 used -> a new upload is refused with the numbers.
    expect((await f.stub.execute(f.human, 'put-settings', { lfsQuotaBytes: 4 })).status).toBe(200);
    const over = await f.stub.execute({ kind: 'token', token }, 'lfs-write', { repo: 'senet', step: 'batch', username: '', objects: [{ oid: 'c'.repeat(64), size: 1 }], presign: false });
    expect(over.status).toBe(507);
    // A pending row a day old is swept with its object; a ready one stays.
    const bucket = (env as unknown as { GIT: R2Bucket }).GIT;
    await bucket.put(`lfs/${f.workspaceId}/senet/${oidB}`, new Uint8Array(5));
    await runInDurableObject(f.stub, async (instance: { sweepLfsForTest: (now: number) => Promise<void> }, state) => {
      state.storage.sql.exec('UPDATE lfs_objects SET created_at = created_at - 90000000');
      await instance.sweepLfsForTest(Date.now());
    });
    expect(await bucket.head(`lfs/${f.workspaceId}/senet/${oidB}`)).toBeNull();
    const after = await (await f.stub.execute(f.human, 'settings', {})).json() as { lfs: { objects: number; bytes: number } };
    expect(after.lfs).toMatchObject({ objects: 1, bytes: 3 });
  });
});

describe('builds of projects with large files', () => {
  it('require the git-lfs label and carry a read ticket for the LFS endpoint', async () => {
    const f = await setup();
    const token = await f.pat();
    await f.stub.execute({ kind: 'token', token }, 'lfs-write', { repo: 'senet', step: 'batch', username: '', objects: [{ oid: oidA, size: 3 }], presign: false });
    await f.stub.execute({ kind: 'token', token }, 'lfs-write', { repo: 'senet', step: 'stored', oid: oidA, size: 3 });
    expect((await f.stub.execute(f.human, 'enqueue', { requestId: crypto.randomUUID(), projectId: 'senet', product: 'build' })).status).toBe(201);
    const plain = await f.node([]);
    const nothing = await (await f.stub.execute(plain, 'claim', {})).json() as { hasJob: boolean };
    expect(nothing.hasJob).toBe(false);
    const capable = await f.node(['git-lfs']);
    const claimed = await (await f.stub.execute(capable, 'claim', {})).json() as { hasJob: boolean; envelope: { spec: { lfs?: { url: string; authToken: string } } } };
    expect(claimed.hasJob).toBe(true);
    expect(claimed.envelope.spec.lfs?.url).toBe(origin + '/git/senet.git');
    expect(claimed.envelope.spec.lfs?.authToken).toMatch(/^smith_git_/);
    // The ticket reads this project's objects and nothing else.
    const ticket = { kind: 'ticket' as const, token: claimed.envelope.spec.lfs!.authToken, nodeToken: capable.token };
    expect((await f.stub.execute(ticket, 'lfs-read', { repo: 'senet', step: 'batch', username: '', objects: [{ oid: oidA, size: 3 }] })).status).toBe(200);
    expect((await f.stub.execute(ticket, 'lfs-write', { repo: 'senet', step: 'batch', username: '', objects: [{ oid: oidB, size: 3 }], presign: false })).status).not.toBe(200);
  });
});
