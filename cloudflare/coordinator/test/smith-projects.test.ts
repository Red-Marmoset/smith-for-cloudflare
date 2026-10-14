// Projects started in Smith: empty, or from an uploaded zip. With Cloudflare Artifacts the coordinator makes the first commit
// itself and pushes it there, so no machine is needed; a machine that keeps copies takes a copy once one is online, and
// pushes to that copy are mirrored back. Without Artifacts (or for a project too big for it) a machine creates it.
import { env } from 'cloudflare:workers';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import worker from '../src/index';
import { hash } from '../src/http';
import { GIT_HOST_LABEL, GIT_CLIENT_LABEL, GIT_INIT_LABEL, hostInitSpecs, smithRemote, cloneUsername } from '../src/git-host';
import { archiveName } from '../src/project-import';
import { fakeArtifacts, repoNameFor } from '../src/artifacts-repos';
import { zipEntryPath, zipCommonRoot } from '../src/zip-read';
import { addIgnoreFile, isIgnored } from '../src/gitignore';
import identity from '../migrations/0001_identity.sql?raw';
import browser from '../migrations/0002_browser_auth.sql?raw';
import directory from '../migrations/0003_workspace_directory.sql?raw';
import profile from '../migrations/0005_account_profile.sql?raw';

const origin = 'https://exp.redmarmosetstudios.com';
const commit = 'd45d5d166ff384710a2f63cfa24271395b689c41';
type Lease = { jobId: string; attemptId: string; leaseToken: string; leaseExpiresAt: number; nodeId: string };
type Assignment = { hasJob: boolean; envelope: { lease: Lease; spec: { kind: string; projectId: string; repos: unknown[]; host?: { repoUuid: string; defaultBranch: string; init?: { kind: string; name: string; archiveName: string; archiveSize: number } } } } };
type Shown = { id: string; name: string; source: string; repoUrl: string; branch: string; scan: { state: string; message: string; jobId: string | null }; hosted?: { status: string; init?: Record<string, unknown>; message?: string } };

beforeAll(async () => { for (const schema of [identity, browser, directory, profile]) await env.DB.exec(schema); });

async function signIn() {
  const userId = crypto.randomUUID(); const code = crypto.randomUUID() + crypto.randomUUID();
  await env.DB.batch([env.DB.prepare('INSERT INTO users (id, created_at, display_name, email) VALUES (?, ?, ?, ?)').bind(userId, Date.now(), '', ''),
    env.DB.prepare('INSERT INTO invites VALUES (?, ?, ?)').bind(await hash(code), userId, Date.now() + 60000)]);
  const login = await worker.fetch(new Request(origin + '/auth/invite', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ code }) }), env);
  const { csrfToken } = await login.json() as { csrfToken: string };
  const cookie = login.headers.get('Set-Cookie')!.split(';')[0];
  const headers = { Origin: origin, Cookie: cookie, 'X-Smith-CSRF': csrfToken };
  const post = (path: string, body: unknown = {}) => worker.fetch(new Request(origin + path, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), env);
  const upload = (path: string, bytes: Uint8Array, type = 'application/zip') => worker.fetch(new Request(origin + path, { method: 'POST', headers: { ...headers, 'Content-Type': type }, body: bytes }), env);
  const created = await post('/api/v2/workspaces', { requestId: crypto.randomUUID() });
  expect(created.status).toBe(201);
  const workspaceId = (await created.json() as { workspaceId: string }).workspaceId;
  const stub = env.WORKSPACES.getByName(workspaceId);
  const human = { kind: 'human' as const, userId };
  async function node(labels = [GIT_HOST_LABEL, GIT_INIT_LABEL, GIT_CLIENT_LABEL, 'smith-repo-projects'], hostname = 'desktop-sem') {
    const { code } = await (await stub.execute(human, 'enrollments', {})).json() as { code: string };
    const response = await stub.execute({ kind: 'enrollment' }, 'enroll', { code, protocolVersion: 2, os: 'linux', hostname, arch: 'x64', labels, agentVersion: 'hosted-abcdef123456' });
    const { token, nodeId } = await response.json() as { token: string; nodeId: string };
    const credential = { kind: 'node' as const, token };
    const beat = () => stub.execute(credential, 'heartbeat', { hostname, os: 'linux', arch: 'x64', labels, agentVersion: 'hosted-abcdef123456', hosting: { able: true, reason: '', free: 50 * 1024 * 1024 * 1024 } });
    await beat();
    expect((await stub.execute(human, 'node-host', { nodeId, host: true })).status).toBe(200);
    await beat();   // the next heartbeat, as the agent sends every 20 s
    return { ...credential, id: nodeId, beat };
  }
  const projects = async () => (await (await stub.execute(human, 'projects', {})).json() as { projects: Shown[] }).projects;
  return { base: `/api/v2/workspaces/${workspaceId}`, workspaceId, stub, human, node, post, upload, projects };
}
type Fixture = Awaited<ReturnType<typeof signIn>>;
type Node = Awaited<ReturnType<Fixture['node']>>;
const claim = async (f: Fixture, n: Node) => await (await f.stub.execute(n, 'claim', {})).json() as Assignment;
const complete = (f: Fixture, n: Node, lease: Lease, status: 'success' | 'failed', extra: Record<string, unknown> = {}, message = '') =>
  f.stub.execute(n, 'complete', { ...lease, result: { status, exitCode: status === 'success' ? 0 : 1, durationMs: 1, message, ...extra } });
// The machine's side of one relay (as in git-host.test.ts): poll until it arrives, take the body, answer, complete.
async function serveRelay(f: Fixture, n: Node, output: Uint8Array, extra: Record<string, unknown>) {
  type Relay = { id: string; leaseToken: string; hasBody: boolean };
  let relay: Relay | null = null;
  for (let i = 0; ; i++) {
    relay = (await (await f.stub.execute(n, 'git-poll', {})).json() as { relay: Relay | null }).relay;
    if (relay) break;
    if (i > 100) throw new Error('no relay arrived');
    await new Promise(r => setTimeout(r, 20));
  }
  const headers = { Authorization: `Bearer ${n.token}`, 'X-Smith-Lease-Token': relay.leaseToken };
  const at = `${origin}/api/v2/workspaces/${f.workspaceId}/git/relay/${relay.id}`;
  if (relay.hasBody) await (await worker.fetch(new Request(`${at}/body`, { headers }), env)).arrayBuffer();
  expect((await worker.fetch(new Request(`${at}/response?part=1`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/octet-stream', 'Content-Length': String(output.byteLength) }, body: output }), env)).status).toBe(200);
  const done = await worker.fetch(new Request(`${at}/complete`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ relayId: relay.id, leaseToken: relay.leaseToken, status: 200, size: output.byteLength, message: '', ...extra }) }), env);
  expect(done.status).toBe(200);
}
const zip = (size = 64) => { const bytes = new Uint8Array(size); bytes.set([0x50, 0x4b, 0x03, 0x04]); return bytes; };

describe('the init host job', () => {
  it('creates instead of copying, on every OS', () => {
    const specs = hostInitSpecs('game', 'job', 'uuid', 'main', { kind: 'zip', name: 'Game', archiveName: 'game.zip', archiveSize: 9 });
    expect(Object.keys(specs)).toEqual(['windows', 'linux', 'mac']);
    expect(specs.linux).toMatchObject({ kind: 'host', projectId: 'game', repos: [], host: { repoUuid: 'uuid', defaultBranch: 'main', init: { kind: 'zip', name: 'Game', archiveName: 'game.zip', archiveSize: 9 } } });
  });
  it('keeps only a plain file name for the zip', () => {
    expect(archiveName('C:\\Users\\me\\My Game (v2).zip')).toBe('My Game (v2).zip');
    expect(archiveName('../../etc/passwd')).toBe('passwd');
    expect(archiveName('"><script>.zip')).toBe('script.zip');
    expect(archiveName(null)).toBe('upload.zip');
  });
});

describe('an empty project on a machine (no Artifacts)', () => {
  beforeEach(() => { fakeArtifacts.reset(); fakeArtifacts.entitled = false; });
  it('needs a machine that keeps copies, and says so', async () => {
    const f = await signIn();
    const refused = await f.post(f.base + '/projects', { source: 'empty', name: 'My Game' });
    expect(refused.status).toBe(503);
    expect((await refused.json() as { error: { message: string } }).error.message).toContain('Keep copies of repositories here');
  });
  it('is created by a machine that can, read once it exists, and read again after a push', async () => {
    const f = await signIn();
    // Only hosts whose agent is too old to create repositories: refused, naming the machine to update.
    const old = await f.node([GIT_HOST_LABEL, GIT_CLIENT_LABEL, 'smith-repo-projects'], 'old-agent');
    const outdated = await f.post(f.base + '/projects', { source: 'empty', name: 'My Game' });
    expect(outdated.status).toBe(503);
    expect((await outdated.json() as { error: { message: string } }).error.message).toContain('old-agent');
    const host = await f.node();
    const created = await f.post(f.base + '/projects', { source: 'empty', name: 'My Game' });
    expect(created.status).toBe(201);
    const project = await created.json() as Shown;
    expect(project).toMatchObject({ id: 'my-game', name: 'My Game', source: 'smith', branch: 'main', repoUrl: smithRemote(origin, 'my-game'), hosted: { status: 'copying', init: { kind: 'empty', name: 'My Game' } } });
    // The old agent never takes the job; the updated one does.
    expect((await claim(f, old)).hasJob).toBe(false);
    const assignment = await claim(f, host);
    expect(assignment.envelope.spec).toMatchObject({ kind: 'host', projectId: 'my-game', repos: [], host: { defaultBranch: 'main', init: { kind: 'empty', name: 'My Game', archiveName: '', archiveSize: 0 } } });
    // No zip to download for an empty project.
    expect((await f.stub.execute(host, 'host-import', { jobId: assignment.envelope.lease.jobId, attemptId: assignment.envelope.lease.attemptId, leaseToken: assignment.envelope.lease.leaseToken })).status).toBe(404);
    expect((await complete(f, host, assignment.envelope.lease, 'success', { host: { tips: [[commit, 'refs/heads/main']], defaultBranch: 'main', bytes: 1024 } })).status).toBe(200);
    const [ready] = await f.projects();
    expect(ready.hosted?.status).toBe('ready');
    expect(ready.repoUrl).toBe(smithRemote(origin, 'my-game'));
    expect(ready.scan.state).toBe('waiting');
    expect(ready.scan.jobId).toBeTruthy();
    // The scan finds no smith.json: the card says how to add one.
    const scan = await claim(f, host);
    expect(scan.envelope.spec.kind).toBe('scan');
    await complete(f, host, scan.envelope.lease, 'success', { scan: { commit, branch: 'main', smithJson: null, paths: ['README.md'], truncated: false } });
    const [empty] = await f.projects();
    expect(empty.scan).toMatchObject({ state: 'error' });
    expect(empty.scan.message).toContain('add a smith.json and push');
    // Someone pushes a smith.json: the branch moved, so Smith reads it again without a Rescan.
    const { token } = await (await f.stub.execute(f.human, 'token-create', { name: 'laptop', scopes: ['read', 'build'], expiresInDays: null })).json() as { token: string };
    const basic = 'Basic ' + btoa(`${cloneUsername(f.workspaceId)}:${token}`);
    const push = worker.fetch(new Request(`${origin}/git/my-game.git/git-receive-pack`, { method: 'POST', headers: { Authorization: basic, 'Content-Type': 'application/x-git-receive-pack-request' }, body: new Uint8Array([0x30, 0x30, 0x30, 0x30]) }), env);
    await serveRelay(f, host, new TextEncoder().encode('000eunpack ok\n0000'), { tips: [['2'.repeat(40), 'refs/heads/main']], bytes: 2048 });
    expect((await push).status).toBe(200);
    const [rescanned] = await f.projects();
    expect(rescanned.scan.state).toBe('waiting');
    expect(rescanned.scan.message).toContain('after a push');
    expect(rescanned.scan.jobId).not.toBe(empty.scan.jobId);
  });
  it('rejects an upload key on the JSON route', async () => {
    const f = await signIn(); await f.node();
    expect((await f.post(f.base + '/projects', { source: 'zip', name: 'x' })).status).toBe(400);
    expect((await f.post(f.base + '/projects', { source: 'empty', name: 'x', upload: { key: `imports/${f.workspaceId}/a.zip`, size: 9, fileName: 'a.zip' } })).status).toBe(400);
  });
  it('can be tried again after the machine failed to create it', async () => {
    const f = await signIn(); const host = await f.node();
    await f.post(f.base + '/projects', { source: 'empty', name: 'Retry Me' });
    const first = await claim(f, host);
    await complete(f, host, first.envelope.lease, 'failed', {}, 'git init failed');
    const [failed] = await f.projects();
    expect(failed.hosted).toMatchObject({ status: 'failed', message: 'git init failed' });
    const again = await f.stub.execute(f.human, 'host-project', { requestId: crypto.randomUUID(), projectId: 'retry-me' });
    expect(again.status).toBe(201);
    const second = await claim(f, host);
    expect(second.envelope.spec.host?.init?.kind).toBe('empty');
  });
});

describe('a project from a zip on a machine (no Artifacts)', () => {
  beforeEach(() => { fakeArtifacts.reset(); fakeArtifacts.entitled = false; });
  it('stores the upload, hands it only to the job holding it, and deletes it once the repository exists', async () => {
    const f = await signIn(); const host = await f.node();
    const bytes = zip(300);
    const created = await f.upload(f.base + '/projects/import?name=' + encodeURIComponent('Old Game') + '&file=' + encodeURIComponent('old-game.zip'), bytes);
    expect(created.status).toBe(201);
    const project = await created.json() as Shown;
    expect(project).toMatchObject({ id: 'old-game', source: 'smith', hosted: { status: 'copying', init: { kind: 'zip', archiveName: 'old-game.zip', archiveSize: 300 } } });
    const stored = await env.GIT.list({ prefix: `imports/${f.workspaceId}/` });
    expect(stored.objects).toHaveLength(1);
    const assignment = await claim(f, host);
    const lease = assignment.envelope.lease;
    expect(assignment.envelope.spec.host?.init).toMatchObject({ kind: 'zip', archiveName: 'old-game.zip', archiveSize: 300 });
    expect(JSON.stringify(assignment.envelope.spec)).not.toContain('imports/');   // the R2 key stays with the coordinator
    // The machine downloads it through the Worker with its lease; anything else is refused.
    const fetchZip = (headers: Record<string, string>) => worker.fetch(new Request(`${origin}/api/v2/workspaces/${f.workspaceId}/jobs/${lease.jobId}/import`, { headers }), env);
    expect((await fetchZip({ Authorization: `Bearer ${host.token}`, 'X-Smith-Attempt-Id': lease.attemptId, 'X-Smith-Lease-Token': 'wrong' })).status).toBe(409);
    const other = await f.node(undefined, 'other-machine');
    expect((await fetchZip({ Authorization: `Bearer ${other.token}`, 'X-Smith-Attempt-Id': lease.attemptId, 'X-Smith-Lease-Token': lease.leaseToken })).status).toBe(409);
    const download = await fetchZip({ Authorization: `Bearer ${host.token}`, 'X-Smith-Attempt-Id': lease.attemptId, 'X-Smith-Lease-Token': lease.leaseToken });
    expect(download.status).toBe(200);
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(bytes);
    expect((await complete(f, host, lease, 'success', { host: { tips: [[commit, 'refs/heads/main']], defaultBranch: 'main', bytes: 4096 } })).status).toBe(200);
    expect((await env.GIT.list({ prefix: `imports/${f.workspaceId}/` })).objects).toHaveLength(0);
    const [ready] = await f.projects();
    expect(ready.hosted?.status).toBe('ready');
    expect(ready.hosted?.init).not.toHaveProperty('uploadKey');
  });
  it('refuses what is not a zip, and leaves nothing behind', async () => {
    const f = await signIn(); await f.node();
    expect((await f.upload(f.base + '/projects/import?name=x', new TextEncoder().encode('just some text, not an archive'))).status).toBe(400);
    expect((await f.upload(f.base + '/projects/import?name=x', zip(), 'text/plain')).status).toBe(415);
    expect((await env.GIT.list({ prefix: `imports/${f.workspaceId}/` })).objects).toHaveLength(0);
  });
  it('is refused before the upload when no machine keeps copies', async () => {
    const f = await signIn();
    expect((await f.upload(f.base + '/projects/import?name=x', zip())).status).toBe(503);
    expect((await env.GIT.list({ prefix: `imports/${f.workspaceId}/` })).objects).toHaveLength(0);
  });
});

// A zip with stored (uncompressed) entries: enough for the coordinator's reader, which checks names and sizes, not CRCs.
// `claim` overrides an entry's recorded size, for a zip that says it holds a file too big for Artifacts.
function storedZip(files: [string, string][], claim: Record<string, number> = {}): Uint8Array {
  const enc = new TextEncoder(); const locals: Uint8Array[] = []; const central: Uint8Array[] = []; let offset = 0;
  for (const [name, text] of files) {
    const n = enc.encode(name), d = enc.encode(text), size = claim[name] ?? d.length;
    const local = new Uint8Array(30 + n.length + d.length); const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x800, true); lv.setUint32(18, d.length, true); lv.setUint32(22, size, true); lv.setUint16(26, n.length, true);
    local.set(n, 30); local.set(d, 30 + n.length); locals.push(local);
    const entry = new Uint8Array(46 + n.length); const cv = new DataView(entry.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x800, true); cv.setUint32(20, d.length, true); cv.setUint32(24, size, true); cv.setUint16(28, n.length, true); cv.setUint32(42, offset, true);
    entry.set(n, 46); central.push(entry); offset += local.length;
  }
  const dirSize = central.reduce((a, c) => a + c.length, 0);
  const end = new Uint8Array(22); const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true); ev.setUint32(12, dirSize, true); ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + dirSize + 22); let at = 0;
  for (const part of [...locals, ...central, end]) { out.set(part, at); at += part.length; }
  return out;
}

describe('zip names and .gitignore', () => {
  it('unwraps one folder and refuses names that leave the project or that Windows cannot hold', () => {
    expect(zipCommonRoot(['game/', 'game/a.txt', 'game/src/b.c', '__MACOSX/game/._a.txt'])).toBe('game/');
    expect(zipCommonRoot(['game/a.txt', 'readme.txt'])).toBe('');
    expect(zipEntryPath('game/src/b.c', 'game/')).toBe('src/b.c');
    expect(zipEntryPath('game\\src\\b.c', 'game/')).toBe('src/b.c');
    expect(zipEntryPath('game/.git/config', 'game/')).toBe('');
    expect(zipEntryPath('__MACOSX/game/._a', 'game/')).toBe('');
    for (const bad of ['../evil', 'a/../../evil', '/etc/passwd', 'C:/x.dll', 'a/CON.txt', 'a/what?.txt', 'a/dot.']) expect(() => zipEntryPath(bad, '')).toThrow();
  });
  it('leaves out what the project ignores, as git does', () => {
    const rules = { rules: [] as never[] };
    addIgnoreFile(rules, '', 'Library/\n*.log\n!keep.log\n/build\n# comment\ndocs/**/*.tmp\n');
    addIgnoreFile(rules, 'tools/', 'out/\n');
    expect(isIgnored(rules, 'Library/cache.bin')).toBe(true);
    expect(isIgnored(rules, 'sub/Library/x')).toBe(true);
    expect(isIgnored(rules, 'debug.log')).toBe(true);
    expect(isIgnored(rules, 'keep.log')).toBe(false);
    expect(isIgnored(rules, 'build/a.o')).toBe(true);
    expect(isIgnored(rules, 'src/build/a.o')).toBe(false);
    expect(isIgnored(rules, 'docs/a/b/c.tmp')).toBe(true);
    expect(isIgnored(rules, 'tools/out/x')).toBe(true);
    expect(isIgnored(rules, 'out/x')).toBe(false);
    expect(isIgnored(rules, 'src/main.c')).toBe(false);
  });
});

describe('a project on Cloudflare Artifacts', () => {
  beforeEach(() => { fakeArtifacts.reset(); });
  it('is created with no machine at all and lives in storage behind Smith’s URL from the start', async () => {
    const f = await signIn();
    const created = await f.post(f.base + '/projects', { source: 'empty', name: 'Cloud Game' });
    expect(created.status).toBe(201);
    const project = await created.json() as Shown & { home?: string; artifacts: { status: string; remote: string; pushedCommit: string; repo: string }; commit: string; hosted?: { state?: string } };
    const repo = repoNameFor(f.workspaceId, 'cloud-game');
    expect(project).toMatchObject({ id: 'cloud-game', source: 'smith', home: 'artifacts', repoUrl: smithRemote(origin, 'cloud-game'), artifacts: { status: 'done', remote: fakeArtifacts.remote(repo) } });
    expect(project.hosted?.state).toBe('artifacts');
    // The first commit arrived as a pack, and the record names it.
    const pack = fakeArtifacts.packs.get(fakeArtifacts.remote(repo))!;
    expect(new TextDecoder().decode(pack.subarray(0, 4))).toBe('PACK');
    expect(new DataView(pack.buffer, pack.byteOffset).getUint32(8)).toBe(3);   // README blob, root tree, commit
    expect(project.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(project.artifacts.pushedCommit).toBe(project.commit);
    expect([...fakeArtifacts.repos.values()][0].heads.main).toBe(project.commit);
    // Smith read it already: no smith.json yet, and the card says how to add one.
    expect(project.scan.state).toBe('error');
    expect(project.scan.message).toContain('add a smith.json and push');
    // Every write token Smith used for the push is revoked again.
    expect([...fakeArtifacts.tokens.values()].filter(t => t.scope === 'write').every(t => t.revoked)).toBe(true);
    // A machine that keeps copies comes online: nothing moves the project onto it; storage stays the home.
    const host = await f.node();
    expect((await claim(f, host)).hasJob).toBe(false);
    const [shown] = await f.projects() as (Shown & { home?: string })[];
    expect([shown.home, shown.repoUrl]).toEqual(['artifacts', smithRemote(origin, 'cloud-game')]);
  });
  it('makes the first commit from a zip, honouring its .gitignore, and reads its smith.json', async () => {
    const f = await signIn();
    const zip = storedZip([['game/README.md', '# Game\n'], ['game/.gitignore', 'Library/\n'], ['game/Library/cache.bin', 'junk'], ['game/src/main.c', 'int main(){}\n'], ['game/.git/config', '[core]\n']]);
    const created = await f.upload(f.base + '/projects/import?name=Zip%20Game&file=game.zip', zip);
    expect(created.status).toBe(201);
    const project = await created.json() as Shown & { artifacts: { status: string; remote: string } };
    expect(project).toMatchObject({ id: 'zip-game', source: 'smith', artifacts: { status: 'done' } });
    const pack = fakeArtifacts.packs.get(project.artifacts.remote)!;
    // .gitignore, README.md and src/main.c (Library/ and .git/ left out), two trees and the commit.
    expect(new DataView(pack.buffer, pack.byteOffset).getUint32(8)).toBe(6);
    // The zip is gone once the repository holds its files.
    expect((await env.GIT.list({ prefix: `imports/${f.workspaceId}/` })).objects).toHaveLength(0);
  });
  it('refuses a file too big for Artifacts when no machine could keep it, and leaves nothing behind', async () => {
    const f = await signIn();
    const zip = storedZip([['big.bin', 'x'], ['a.txt', 'a']], { 'big.bin': 40 * 1024 * 1024 });
    const refused = await f.upload(f.base + '/projects/import?name=Big', zip);
    expect(refused.status).toBe(413);
    expect((await refused.json() as { error: { message: string } }).error.message).toContain('Keep copies of repositories here');
    expect(fakeArtifacts.repos.size).toBe(0);
    expect(await f.projects()).toHaveLength(0);
  });
  it('sends a project too big for Artifacts to a machine when one can keep it', async () => {
    const f = await signIn(); await f.node();
    const zip = storedZip([['big.bin', 'x'], ['a.txt', 'a']], { 'big.bin': 40 * 1024 * 1024 });
    const created = await f.upload(f.base + '/projects/import?name=Big', zip);
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ id: 'big', hosted: { status: 'copying', init: { kind: 'zip' } } });
    expect(fakeArtifacts.repos.size).toBe(0);
  });
  it('removes the repository again when Artifacts refuses the push', async () => {
    const f = await signIn();
    fakeArtifacts.pushRefusal = 'pre-receive hook declined';
    const refused = await f.post(f.base + '/projects', { source: 'empty', name: 'Refused' });
    expect(refused.status).toBe(502);
    expect((await refused.json() as { error: { message: string } }).error.message).toContain('pre-receive hook declined');
    expect(fakeArtifacts.repos.size).toBe(0);
    expect(await f.projects()).toHaveLength(0);
  });
  it('says what to set up when neither Artifacts nor a machine can keep a project', async () => {
    const f = await signIn(); fakeArtifacts.entitled = false;
    const refused = await f.post(f.base + '/projects', { source: 'empty', name: 'Nowhere' });
    expect(refused.status).toBe(503);
    expect((await refused.json() as { error: { message: string } }).error.message).toMatch(/Cloudflare Artifacts.*Keep copies of repositories here/);
  });
});
