import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import worker from '../src/index';
import { setup, origin, oidA, oidB } from './lfs-fixture';
import schema from '../migrations/0001_identity.sql?raw';
import browserSchema from '../migrations/0002_browser_auth.sql?raw';
import directorySchema from '../migrations/0003_workspace_directory.sql?raw';

beforeAll(async () => { await env.DB.exec(schema); await env.DB.exec(browserSchema); await env.DB.exec(directorySchema); });

const MEDIA = 'application/vnd.git-lfs+json';
export function basic(username: string, password: string) { return 'Basic ' + btoa(`${username}:${password}`); }
export async function lfsFetch(path: string, init: RequestInit & { password?: string; username?: string; raw?: boolean } = {}) {
  const headers = new Headers(init.headers);
  if (init.password !== undefined) headers.set('Authorization', basic(init.username ?? '', init.password));
  if (!init.raw) { headers.set('Accept', MEDIA); if (init.body !== undefined && !headers.has('Content-Type')) headers.set('Content-Type', MEDIA); }
  return worker.fetch(new Request(origin + path, { ...init, headers }), env);
}
type Batch = { transfer: string; objects: { oid: string; size: number; authenticated?: boolean; actions?: Record<string, { href: string; header?: Record<string, string>; expires_in?: number }>; error?: { code: number; message: string } }[] };

describe('the batch endpoint', () => {
  it('challenges without credentials and refuses what git refuses', async () => {
    await setup();
    const anonymous = await lfsFetch('/git/senet.git/info/lfs/objects/batch', { method: 'POST', body: JSON.stringify({ operation: 'download', objects: [] }) });
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get('WWW-Authenticate')).toBe('Basic realm="Smith", charset="UTF-8"');
    expect(anonymous.headers.get('LFS-Authenticate')).toBe('Basic realm="Smith"');
    expect(anonymous.headers.get('Content-Type')).toBe(MEDIA);
    expect(((await anonymous.json()) as { message: string }).message).toBe('Sign in with a Smith token as the password');
    const machine = await lfsFetch('/git/senet.git/info/lfs/objects/batch', { method: 'POST', password: 'smn.x.y', body: '{}' });
    expect(machine.status).toBe(401);
    const noAccept = await lfsFetch('/git/senet.git/info/lfs/objects/batch', { method: 'POST', password: 'smith_pat_' + 'a'.repeat(64) + '_' + 'b'.repeat(40), raw: true, body: '{}' });
    expect(noAccept.status).toBe(406);
    const locks = await lfsFetch('/git/senet.git/info/lfs/locks/verify', { method: 'POST', password: 'x', body: '{}' });
    expect(locks.status).toBe(404);
  });
  it('answers download and upload batches with proxy transfer actions', async () => {
    const f = await setup();
    const token = await f.pat();
    const up = await lfsFetch('/git/senet.git/info/lfs/objects/batch', { method: 'POST', password: token, username: f.workspaceId.slice(0, 12), body: JSON.stringify({ operation: 'upload', transfers: ['basic'], objects: [{ oid: oidA, size: 3 }] }) });
    expect(up.status).toBe(200);
    expect(up.headers.get('Content-Type')).toBe(MEDIA);
    const body = await up.json() as Batch;
    expect(body.transfer).toBe('basic');
    expect(body.objects[0].oid).toBe(oidA);
    expect(body.objects[0].authenticated).toBeUndefined();   // same origin: the client reuses its own credential
    expect(body.objects[0].actions!.upload).toEqual({ href: origin + '/git/senet.git/info/lfs/objects/' + oidA, expires_in: 3600 });
    expect(body.objects[0].actions!.verify).toEqual({ href: origin + '/git/senet.git/info/lfs/objects/' + oidA + '/verify', expires_in: 3600 });
    const down = await (await lfsFetch('/git/senet.git/info/lfs/objects/batch', { method: 'POST', password: token, body: JSON.stringify({ operation: 'download', objects: [{ oid: oidA, size: 3 }, { oid: oidB, size: 1 }] }) })).json() as Batch;
    expect(down.objects[0].error).toEqual({ code: 404, message: 'Object not found' });   // pending, not ready
    expect(down.objects[1].error).toEqual({ code: 404, message: 'Object not found' });
    const stored = await f.stub.execute({ kind: 'token', token }, 'lfs-write', { repo: 'senet', step: 'stored', oid: oidA, size: 3 });
    expect(stored.status).toBe(200);
    const ready = await (await lfsFetch('/git/senet.git/info/lfs/objects/batch', { method: 'POST', password: token, body: JSON.stringify({ operation: 'download', objects: [{ oid: oidA, size: 3 }] }) })).json() as Batch;
    expect(ready.objects[0].actions!.download).toEqual({ href: origin + '/git/senet.git/info/lfs/objects/' + oidA, expires_in: 3600 });
    const same = await (await lfsFetch('/git/senet.git/info/lfs/objects/batch', { method: 'POST', password: token, body: JSON.stringify({ operation: 'upload', objects: [{ oid: oidA, size: 3 }] }) })).json() as Batch;
    expect(same.objects[0]).toEqual({ oid: oidA, size: 3 });   // already held: no actions
  });
  it('reports scope, workspace and project refusals as whole-request errors', async () => {
    const f = await setup();
    const reader = await f.pat(['read']);
    const scope = await lfsFetch('/git/senet.git/info/lfs/objects/batch', { method: 'POST', password: reader, body: JSON.stringify({ operation: 'upload', objects: [{ oid: oidA, size: 3 }] }) });
    expect(scope.status).toBe(403);
    expect(((await scope.json()) as { message: string }).message).toBe('This Smith token cannot upload large files. In the dashboard, create a token that can start builds and use it as the password');
    const wrongWs = await lfsFetch('/git/senet.git/info/lfs/objects/batch', { method: 'POST', password: reader, username: '0'.repeat(12), body: JSON.stringify({ operation: 'download', objects: [] }) });
    expect(wrongWs.status).toBe(401);
    const missing = await lfsFetch('/git/nope.git/info/lfs/objects/batch', { method: 'POST', password: reader, body: JSON.stringify({ operation: 'download', objects: [] }) });
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { message: string }).message).toBe('Repository not found');
    const bad = await lfsFetch('/git/senet.git/info/lfs/objects/batch', { method: 'POST', password: reader, body: JSON.stringify({ operation: 'download', objects: [{ oid: 'zz', size: 1 }] }) });
    expect(bad.status).toBe(422);
  });
});

async function sha256(bytes: Uint8Array) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join(''); }

describe('proxy transfers', () => {
  const bytes = new TextEncoder().encode('hello large world');
  it('uploads, verifies, downloads and refuses a wrong body', async () => {
    const f = await setup();
    const token = await f.pat(); const oid = await sha256(bytes);
    const up = await (await lfsFetch('/git/senet.git/info/lfs/objects/batch', { method: 'POST', password: token, body: JSON.stringify({ operation: 'upload', objects: [{ oid, size: bytes.byteLength }] }) })).json() as Batch;
    const upload = up.objects[0].actions!.upload, verify = up.objects[0].actions!.verify;
    const cred = { Authorization: basic('', token) };   // what git-lfs sends again on its own for same-origin hrefs
    const wrong = await worker.fetch(new Request(upload.href, { method: 'PUT', headers: { ...cred, 'Content-Type': 'application/octet-stream' }, body: new TextEncoder().encode('hello large worlD') }), env);
    expect(wrong.status).toBe(422);
    expect(((await wrong.json()) as { message: string }).message).toBe('Uploaded data does not match the object id');
    const short = await worker.fetch(new Request(upload.href, { method: 'PUT', headers: { ...cred, 'Content-Type': 'application/octet-stream' }, body: bytes.subarray(0, 5) }), env);
    expect(short.status).toBe(422);
    const put = await worker.fetch(new Request(upload.href, { method: 'PUT', headers: { ...cred, 'Content-Type': 'application/octet-stream' }, body: bytes }), env);
    expect(put.status).toBe(200);
    const verified = await worker.fetch(new Request(verify.href, { method: 'POST', headers: { ...cred, Accept: MEDIA, 'Content-Type': MEDIA }, body: JSON.stringify({ oid, size: bytes.byteLength }) }), env);
    expect(verified.status).toBe(200);
    // A retried PUT of a ready object is a no-op 200: the good object is never rewritten.
    const retry = await worker.fetch(new Request(upload.href, { method: 'PUT', headers: { ...cred, 'Content-Type': 'application/octet-stream' }, body: new Uint8Array(3) }), env);
    expect(retry.status).toBe(200);
    const down = await (await lfsFetch('/git/senet.git/info/lfs/objects/batch', { method: 'POST', password: token, body: JSON.stringify({ operation: 'download', objects: [{ oid, size: bytes.byteLength }] }) })).json() as Batch;
    const get = await worker.fetch(new Request(down.objects[0].actions!.download.href, { headers: cred }), env);
    expect(get.status).toBe(200);
    expect(get.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(get.headers.get('Content-Length')).toBe(String(bytes.byteLength));
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(bytes);
    const stored = await (env as unknown as { GIT: R2Bucket }).GIT.head(`lfs/${f.workspaceId}/senet/${oid}`);
    expect(stored?.size).toBe(bytes.byteLength);
  });
  it('refuses transfers that were never allowed by a batch, with a read token, and for unknown objects', async () => {
    const f = await setup();
    const reader = await f.pat(['read']); const writer = await f.pat(); const oid = await sha256(bytes);
    const unplanned = await worker.fetch(new Request(origin + '/git/senet.git/info/lfs/objects/' + oid, { method: 'PUT', headers: { Authorization: basic('', writer) }, body: bytes }), env);
    expect(unplanned.status).toBe(404);
    const readerPut = await worker.fetch(new Request(origin + '/git/senet.git/info/lfs/objects/' + oid, { method: 'PUT', headers: { Authorization: basic('', reader) }, body: bytes }), env);
    expect(readerPut.status).toBe(403);
    const missing = await worker.fetch(new Request(origin + '/git/senet.git/info/lfs/objects/' + oid, { headers: { Authorization: basic('', reader) } }), env);
    expect(missing.status).toBe(404);
    const verifyMissing = await worker.fetch(new Request(origin + '/git/senet.git/info/lfs/objects/' + oid + '/verify', { method: 'POST', headers: { Authorization: basic('', writer), Accept: MEDIA, 'Content-Type': MEDIA }, body: JSON.stringify({ oid, size: 1 }) }), env);
    expect(verifyMissing.status).toBe(404);
  });
});

describe('presigned mode', () => {
  const direct = { ...env, R2_ACCOUNT_ID: 'bab833826312fe2b0c81bd7608a6dbf7', GIT_BUCKET: 'smith-experiment-git', R2_ACCESS_KEY_ID: 'k', R2_SECRET_ACCESS_KEY: 's' } as unknown as typeof env;
  async function directFetch(path: string, password: string, body: unknown) {
    return worker.fetch(new Request(origin + path, { method: 'POST', headers: { Authorization: basic('', password), Accept: MEDIA, 'Content-Type': MEDIA }, body: JSON.stringify(body) }), direct);
  }
  it('hands out presigned R2 URLs and lifts the proxy cap', async () => {
    const f = await setup();
    const token = await f.pat();
    const up = await (await directFetch('/git/senet.git/info/lfs/objects/batch', token, { operation: 'upload', objects: [{ oid: oidA, size: 104857601 }] })).json() as Batch;
    const upload = up.objects[0].actions!.upload;
    expect(upload.header).toBeUndefined();
    expect(up.objects[0].authenticated).toBe(true);   // a presigned URL carries its own signature; no Smith credential
    const url = new URL(upload.href);
    expect(url.host).toBe('bab833826312fe2b0c81bd7608a6dbf7.r2.cloudflarestorage.com');
    expect(url.pathname).toBe(`/smith-experiment-git/lfs/${f.workspaceId}/senet/${oidA}`);
    expect(url.searchParams.get('X-Amz-Expires')).toBe('3600');
    expect(up.objects[0].actions!.verify.href).toBe(origin + '/git/senet.git/info/lfs/objects/' + oidA + '/verify');
  });
  it('verify hashes the stored object: a good one becomes ready, a bad one is deleted', async () => {
    const f = await setup();
    const token = await f.pat();
    const good = new TextEncoder().encode('good bytes'); const oid = await sha256(good);
    const bucket = (env as unknown as { GIT: R2Bucket }).GIT;
    await directFetch('/git/senet.git/info/lfs/objects/batch', token, { operation: 'upload', objects: [{ oid, size: good.byteLength }, { oid: oidB, size: 4 }] });
    await bucket.put(`lfs/${f.workspaceId}/senet/${oid}`, good);              // what the presigned PUT would have stored
    await bucket.put(`lfs/${f.workspaceId}/senet/${oidB}`, new Uint8Array(4)); // right length, wrong content
    expect((await directFetch('/git/senet.git/info/lfs/objects/' + oid + '/verify', token, { oid, size: good.byteLength })).status).toBe(200);
    const bad = await directFetch('/git/senet.git/info/lfs/objects/' + oidB + '/verify', token, { oid: oidB, size: 4 });
    expect(bad.status).toBe(422);
    expect(await bucket.head(`lfs/${f.workspaceId}/senet/${oidB}`)).toBeNull();
    const down = await (await directFetch('/git/senet.git/info/lfs/objects/batch', token, { operation: 'download', objects: [{ oid, size: 0 }, { oid: oidB, size: 0 }] })).json() as Batch;
    expect(new URL(down.objects[0].actions!.download.href).searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(down.objects[1].error?.code).toBe(404);
  });
});
