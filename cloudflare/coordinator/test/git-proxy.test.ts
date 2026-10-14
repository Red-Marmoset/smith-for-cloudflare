import { describe, expect, it } from 'vitest';
import { parseAdvertisement } from '../src/git-proxy';

const sha = (c: string) => c.repeat(40);
const pkt = (s: string) => (s.length + 4).toString(16).padStart(4, '0') + s;
describe('parseAdvertisement', () => {
  it('reads a v1 upload-pack advertisement into sorted tips and peeled tags', () => {
    const body = pkt('# service=git-upload-pack\n') + '0000' + pkt(`${sha('a')} HEAD\0multi_ack symref=HEAD:refs/heads/main agent=git/2.46\n`) +
      pkt(`${sha('a')} refs/heads/main\n`) + pkt(`${sha('b')} refs/heads/dev\n`) + pkt(`${sha('c')} refs/tags/v1\n`) + pkt(`${sha('d')} refs/tags/v1^{}\n`) + '0000';
    expect(parseAdvertisement(body)).toEqual({ tips: [[sha('b'), 'refs/heads/dev'], [sha('a'), 'refs/heads/main'], [sha('c'), 'refs/tags/v1']], peeled: { 'refs/tags/v1': sha('d') } });
  });
  it('answers no tips for an empty repository and refuses a malformed body', () => {
    expect(parseAdvertisement(pkt('# service=git-upload-pack\n') + '0000' + pkt(`${'0'.repeat(40)} capabilities^{}\0multi_ack\n`) + '0000')).toEqual({ tips: [], peeled: {} });
    expect(() => parseAdvertisement('not git')).toThrow(/advertisement/);
  });
});

import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeAll, vi } from 'vitest';
import worker from '../src/index';
import { setup, origin, type Fixture } from './lfs-fixture';
import { fakeArtifacts } from '../src/artifacts-repos';
import { GIT_HOST_LABEL, GIT_CLIENT_LABEL, tipsDigest } from '../src/git-host';
import schema from '../migrations/0001_identity.sql?raw';
import browserSchema from '../migrations/0002_browser_auth.sql?raw';
import directorySchema from '../migrations/0003_workspace_directory.sql?raw';

beforeAll(async () => { await env.DB.exec(schema); await env.DB.exec(browserSchema); await env.DB.exec(directorySchema); });
afterEach(() => vi.unstubAllGlobals());
const P = 'soccer-boy';

// A stand-in for Artifacts' git server: the v1 advertisement from `heads`, an echo of RPC bodies, and whatever
// `mode` says: 'ok', 'down' (connection refused), 'slow' (never answers), 'reject' (401 once, then ok).
function fakeGitServer(heads: Record<string, string>, mode: { value: string; afterPush?: string } = { value: 'ok' }) {
  const real = globalThis.fetch; const seen: { url: string; method: string; headers: Record<string, string>; body: string }[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init); const url = request.url;
    if (!url.includes('.artifacts.cloudflare.net/')) return real(input, init);
    seen.push({ url, method: request.method, headers: Object.fromEntries(request.headers), body: request.body ? await request.text() : '' });
    if (mode.value === 'down') throw new TypeError('connection refused');
    if (mode.value === 'slow') return new Promise<Response>(() => {});
    if (mode.value === 'reject') { mode.value = 'ok'; return new Response('bad token', { status: 401 }); }
    if (url.includes('/info/refs')) {
      const lines = Object.entries(heads).map(([ref, s]) => pkt(`${s} ${ref}\n`)).join('');
      return new Response(pkt('# service=git-upload-pack\n') + '0000' + lines + '0000', { headers: { 'Content-Type': 'application/x-git-upload-pack-advertisement' } });
    }
    if (url.endsWith('/git-receive-pack')) {
      // As a git server does it: the headers first, the ref update while the result streams; the new tip is visible only once the result ended.
      let sent = false;
      const result = new ReadableStream<Uint8Array>({ pull(controller) {
        if (!sent) { sent = true; controller.enqueue(new TextEncoder().encode('000eunpack ok\n0000')); return; }
        heads['refs/heads/master'] = sha('e'); if (mode.afterPush) mode.value = mode.afterPush; controller.close();
      } });
      return new Response(result, { headers: { 'Content-Type': 'application/x-git-receive-pack-result' } });
    }
    return new Response('echo:' + seen[seen.length - 1].body, { headers: { 'Content-Type': 'application/x-git-upload-pack-result' } });
  });
  return seen;
}
// A repository project whose home is Artifacts, as an import leaves it (Task 8 adds the real path; this seeds the record).
async function artifactsHome(f: Fixture) {
  const added = await f.stub.execute(f.human, 'add-repo-project', { source: 'git', url: `git@github.com:Red-Marmoset/${P}.git`, branch: 'master' });
  expect(added.status).toBe(201);
  const name = `${f.workspaceId.slice(0, 12)}-${P}`; const remote = fakeArtifacts.remote(name);
  fakeArtifacts.seed(name, 'master', sha('a'));
  await runInDurableObject(f.stub, async (instance: { seedArtifactsHomeForTest: (id: string, remote: string, tips: [string, string][]) => Promise<void> }) => {
    await instance.seedArtifactsHomeForTest(P, remote, [[sha('a'), 'refs/heads/master']]);
  });
  return remote;
}
const git = (f: Fixture, token: string, path: string, init: RequestInit = {}) => worker.fetch(new Request(`${origin}/git/${P}.git/${path}`, { ...init, headers: { Authorization: `Basic ${btoa(`${f.workspaceId.slice(0, 12)}:${token}`)}`, ...(init.headers ?? {}) } }), env);
const generation = (f: Fixture) => runInDurableObject(f.stub, (_o, state) => state.storage.sql.exec<{ generation: number; refs_json: string; state: string }>('SELECT generation, refs_json, state FROM git_repos WHERE id = ?', P).one());

describe('the proxy', () => {
  it('passes the advertisement and both RPCs through with headers, bodies and a cached token', async () => {
    const f = await setup(); const token = await f.pat(); const remote = await artifactsHome(f);
    const seen = fakeGitServer({ 'refs/heads/master': sha('a') });
    const adv = await git(f, token, 'info/refs?service=git-upload-pack', { headers: { 'Git-Protocol': 'version=2' } });
    expect([adv.status, adv.headers.get('Content-Type')]).toEqual([200, 'application/x-git-upload-pack-advertisement']);
    expect((await adv.text()).includes(sha('a'))).toBe(true);
    const rpc = await git(f, token, 'git-upload-pack', { method: 'POST', body: 'want', headers: { 'Content-Type': 'application/x-git-upload-pack-request', 'Content-Encoding': 'identity' } });
    expect([rpc.status, await rpc.text()]).toEqual([200, 'echo:want']);
    expect(seen.map(s => s.url)).toEqual([`${remote}/info/refs?service=git-upload-pack`, `${remote}/git-upload-pack`]);
    expect(seen[0].headers['git-protocol']).toBe('version=2');
    expect(seen[1].headers['content-type']).toBe('application/x-git-upload-pack-request');
    expect(seen[0].headers.authorization).toBe(seen[1].headers.authorization);   // one read token, reused
    expect(seen[0].headers.authorization).toMatch(/^Bearer art_v1_/);
    expect(adv.headers.get('Cache-Control')).toContain('no-cache');
  });
  it('a push refreshes the tips and bumps the generation', async () => {
    const f = await setup(); const token = await f.pat(); await artifactsHome(f);
    fakeGitServer({ 'refs/heads/master': sha('a') });
    const push = await git(f, token, 'git-receive-pack', { method: 'POST', body: 'pack', headers: { 'Content-Type': 'application/x-git-receive-pack-request' } });
    expect(push.status).toBe(200);
    await new Promise(resolve => setTimeout(resolve, 300));   // ctx.waitUntil
    const row = await generation(f);
    expect([row.generation, JSON.parse(row.refs_json)]).toEqual([2, [[sha('e'), 'refs/heads/master']]]);
    const shown = (await (await f.stub.execute(f.human, 'projects', {})).json() as { projects: { id: string; scan: { state: string } }[] }).projects.find(p => p.id === P)!;
    expect(['waiting', 'scanning']).toContain(shown.scan.state);
  });
  it('a failed tips fetch after a push leaves the record for the alarm, which retries it and fires Build on push', async () => {
    const f = await setup(); const token = await f.pat(); await artifactsHome(f);
    const mode = { value: 'ok', afterPush: 'down' }; fakeGitServer({ 'refs/heads/master': sha('a') }, mode);   // Artifacts answers the push; the advertisement that follows cannot be fetched
    const push = await git(f, token, 'git-receive-pack', { method: 'POST', body: 'pack', headers: { 'Content-Type': 'application/x-git-receive-pack-request' } });
    expect(push.status).toBe(200);
    await new Promise(resolve => setTimeout(resolve, 300));
    const row = await generation(f);
    expect([row.generation, row.state]).toEqual([1, 'artifacts']);
    const due = await runInDurableObject(f.stub, (_o, state) => state.storage.getAlarm());
    expect(due !== null && due - Date.now() <= 120000).toBe(true);   // the alarm is set to try again soon, not in a day
    mode.value = 'ok';
    await runInDurableObject(f.stub, (instance: { alarm(): Promise<void> }) => instance.alarm());
    const after = await generation(f);
    expect([after.generation, JSON.parse(after.refs_json)]).toEqual([2, [[sha('e'), 'refs/heads/master']]]);
    const shown = (await (await f.stub.execute(f.human, 'projects', {})).json() as { projects: { id: string; scan: { state: string } }[] }).projects.find(p => p.id === P)!;
    expect(['waiting', 'scanning']).toContain(shown.scan.state);   // the push that was missed still builds
  });
  it('Build on push waits for the push result to end, and a bare advertisement triggers nothing', async () => {
    const f = await setup(); const token = await f.pat(); await artifactsHome(f);
    const seen = fakeGitServer({ 'refs/heads/master': sha('a') });
    expect((await git(f, token, 'info/refs?service=git-receive-pack')).status).toBe(200);
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(seen.length).toBe(1);   // no tips fetch after a mere advertisement
    const push = await git(f, token, 'git-receive-pack', { method: 'POST', body: 'pack', headers: { 'Content-Type': 'application/x-git-receive-pack-request' } });
    expect(push.status).toBe(200);   // the client has not read the result yet; the tips are read once the result ended, not when its headers arrived
    await new Promise(resolve => setTimeout(resolve, 300));
    expect((await generation(f)).generation).toBe(2);
  });
  it('a copy reporting refs the record lacks makes the alarm refresh the tips instead of churning', async () => {
    const f = await setup(); await f.pat(); await artifactsHome(f);
    const heads = { 'refs/heads/master': sha('a') }; fakeGitServer(heads);
    const node = await f.node([GIT_HOST_LABEL, GIT_CLIENT_LABEL, 'smith-repo-projects']);
    expect((await f.stub.execute(node, 'heartbeat', { hostname: 'desktop-sem', os: 'linux', arch: 'x64', labels: [GIT_HOST_LABEL, GIT_CLIENT_LABEL, 'smith-repo-projects'], agentVersion: 'hosted-abcdef123456', hosting: { able: true, reason: '', free: 50 * 1024 * 1024 * 1024 } })).status).toBe(200);
    expect((await f.stub.execute(f.human, 'node-host', { nodeId: node.id, host: true })).status).toBe(200);
    const digest = await tipsDigest([[sha('a'), 'refs/heads/master']]);
    const uuid = await runInDurableObject(f.stub, (_o, state) => {
      state.storage.sql.exec("INSERT INTO git_replicas (repo_id, node_id, state, generation, tips_digest, bytes, last_sync_at, attempts, tips_json) VALUES (?, ?, 'current', 1, ?, 10, ?, 0, '[]')", P, node.id, digest, Date.now());
      return state.storage.sql.exec<{ uuid: string }>('SELECT uuid FROM git_repos WHERE id = ?', P).one().uuid;
    });
    heads['refs/heads/master'] = sha('e');   // storage moved on (a push with a leftover token); the copy saw it first
    const tips: [string, string][] = [[sha('e'), 'refs/heads/master']];
    expect((await f.stub.execute(node, 'git-tips', { repoUuid: uuid, tips, bytes: 10 })).status).toBe(200);
    await runInDurableObject(f.stub, (instance: { alarm(): Promise<void> }) => instance.alarm());
    const row = await generation(f);
    expect([row.generation, JSON.parse(row.refs_json)]).toEqual([2, tips]);
    const replica = await runInDurableObject(f.stub, (_o, state) => state.storage.sql.exec<{ state: string; generation: number }>('SELECT state, generation FROM git_replicas WHERE repo_id = ? AND node_id = ?', P, node.id).one());
    expect(replica).toEqual({ state: 'current', generation: 2 });   // the copy that reported the new refs holds them already
  });
  it('a push whose token storage rejects is refused with the reason, and the next push goes through', async () => {
    const f = await setup(); const token = await f.pat(); await artifactsHome(f);
    const mode = { value: 'reject' }; const seen = fakeGitServer({ 'refs/heads/master': sha('a') }, mode);
    const first = await git(f, token, 'git-receive-pack', { method: 'POST', body: 'pack', headers: { 'Content-Type': 'application/x-git-receive-pack-request' } });
    expect([first.status, (await first.text()).includes('refused'), seen.length]).toEqual([503, true, 1]);   // the body went once; nothing claims storage is down
    const second = await git(f, token, 'git-receive-pack', { method: 'POST', body: 'pack', headers: { 'Content-Type': 'application/x-git-receive-pack-request' } });
    expect(second.status).toBe(200);
    expect(seen[1].headers.authorization).not.toBe(seen[0].headers.authorization);   // a fresh token
  });
  it('refuses a push and falls a read over to a copy when Artifacts is unreachable', async () => {
    const f = await setup(); const token = await f.pat(); await artifactsHome(f);
    fakeGitServer({}, { value: 'down' });
    const adv = await git(f, token, 'info/refs?service=git-receive-pack');
    expect(await adv.text()).toContain("ERR Smith's storage is unreachable; nothing was pushed. Try again in a few minutes");
    const rpc = await git(f, token, 'git-receive-pack', { method: 'POST', body: 'pack', headers: { 'Content-Type': 'application/x-git-receive-pack-request' } });
    expect([rpc.status, (await rpc.text()).trim()]).toEqual([503, "Smith's storage is unreachable; nothing was pushed. Try again in a few minutes"]);
    // No machine holds a current copy: the read says so too.
    const read = await git(f, token, 'info/refs?service=git-upload-pack');
    expect(await read.text()).toContain('ERR No machine holding a copy of this repository is online');
  });
  it('re-mints once when Artifacts rejects the token, then gives up with a 502', async () => {
    const f = await setup(); const token = await f.pat(); await artifactsHome(f);
    const mode = { value: 'reject' }; const seen = fakeGitServer({ 'refs/heads/master': sha('a') }, mode);
    expect((await git(f, token, 'info/refs?service=git-upload-pack')).status).toBe(200);
    expect(seen.length).toBe(2);
    expect(seen[0].headers.authorization).not.toBe(seen[1].headers.authorization);
    fakeArtifacts.failNext = { status: 502, code: 'artifacts_failed' };   // the next mint fails
    mode.value = 'reject'; const again = await git(f, token, 'info/refs?service=git-upload-pack');
    expect(again.status).toBe(502);
  });
});
