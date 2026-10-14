import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { hash } from '../src/http';
import { smithRemote, smithRemoteRepo, cloneUrl, cloneUsername, pktErr, pktLine, validateTips, hostEligible, tipsDigest, GIT_HOST_LABEL, GIT_CLIENT_LABEL, hostSpecs, validRef, parseLsRefs, lsRefsLines, v2Advertisement } from '../src/git-host';
import { NEVER_EXPIRES } from '../src/tokens';
import { retainBackups, restoreChain } from '../src/git-tasks';
import schema from '../migrations/0001_identity.sql?raw';
import browserSchema from '../migrations/0002_browser_auth.sql?raw';
import directorySchema from '../migrations/0003_workspace_directory.sql?raw';
import providerTokens from '../migrations/0006_provider_tokens.sql?raw';
import { fakeGitHub } from '../src/github-reader';

const origin = 'https://exp.redmarmosetstudios.com';
const commit = 'd45d5d166ff384710a2f63cfa24271395b689c41';
const other = '1'.repeat(40);
const project = { id: 'senet', name: 'Senet', repoUrl: 'git@github.com:Red-Marmoset/senet.git', branch: 'master', commit,
  products: [{ name: 'build', description: '', labels: [], timeoutSeconds: 1800, commands: { windows: { interpreter: 'ps1', script: 'Build.ps1', args: [] }, linux: { interpreter: 'sh', script: 'Build.sh', args: [] } } }] };
const tips: [string, string][] = [[commit, 'refs/heads/master'], [other, 'refs/tags/v1']];
type Lease = { jobId: string; attemptId: string; leaseToken: string; leaseExpiresAt: number; nodeId: string };
type Repo = { url: string; branch: string; commit: string; authToken: string; hostedUuid?: string; tip?: string };
type Assignment = { hasJob: boolean; envelope: { lease: Lease; spec: { kind: string; projectId: string; repos: Repo[]; host?: { repoUuid: string; defaultBranch: string } } } };
type Hosted = { status: string; repoId: string; uuid: string; message?: string; state?: string; primaryHost?: string | null; copies?: { host: string; primary: boolean; state: string }[]; serving?: number; cloneUrl?: string };
type Shown = { id: string; repoUrl: string; hosted?: Hosted };
type HostResponse = { project: Shown; job: { id: string; kind: string; state: string; product: string } };
type Poll = { relay: { id: string; leaseToken: string; repoUuid: string; service: string; op: string; writer: boolean; gitProtocol: string; hasBody: boolean; bodySize: number; refPolicy: { allow: string[]; protected: string[]; denyDelete: boolean } } | null; held: { repoId: string; primary: boolean }[] };

beforeAll(async () => { await env.DB.exec(schema); await env.DB.exec(browserSchema); await env.DB.exec(directorySchema); await env.DB.exec(providerTokens.split('\n').filter(line => line.trim() && !line.trim().startsWith('--')).join('\n')); });

async function setup() {
  const id = await hash(crypto.randomUUID()); const userId = crypto.randomUUID();   // workspace IDs are 64 hex digits, as the token formats require
  const stub = env.WORKSPACES.getByName(id);
  await stub.initialize(id, userId);
  const human = { kind: 'human' as const, userId };
  const workspaceId = (await (await stub.execute(human, 'summary', {})).json() as { id: string }).id;
  // The Worker's git route checks the workspace directory in D1, as /mcp does.
  await env.DB.prepare('INSERT OR IGNORE INTO workspaces VALUES (?, ?)').bind(workspaceId, Date.now()).run();
  async function node(labels = [GIT_HOST_LABEL, GIT_CLIENT_LABEL, 'smith-repo-projects'], hostname = 'desktop-sem', purpose: 'build' | 'personal' = 'build') {
    const { code } = await (await stub.execute(human, 'enrollments', purpose === 'build' ? {} : { purpose })).json() as { code: string };
    const response = await stub.execute({ kind: 'enrollment' }, 'enroll', { code, protocolVersion: 2, os: 'linux', hostname, arch: 'x64', labels, agentVersion: 'hosted-abcdef123456' });
    expect(response.status).toBe(201);
    const { token, nodeId } = await response.json() as { token: string; nodeId: string };
    const credential = { kind: 'node' as const, token };
    return { ...credential, id: nodeId, hostname, beat: () => stub.execute(credential, 'heartbeat', { hostname, os: 'linux', arch: 'x64', labels, agentVersion: 'hosted-abcdef123456', hosting: { able: true, reason: '', free: 50 * 1024 * 1024 * 1024 } }) };
  }
  const switchOn = (nodeId: string, host = true) => stub.execute(human, 'node-host', { nodeId, host });
  const projects = async () => (await (await stub.execute(human, 'projects', {})).json() as { projects: Shown[] }).projects;
  const hostProject = (requestId = crypto.randomUUID(), projectId = 'senet') => stub.execute(human, 'host-project', { requestId, projectId });
  expect((await stub.execute(human, 'put-project', project)).status).toBe(201);
  async function pat(scopes = ['read', 'build'], expiresInDays: number | null = null) {
    const response = await stub.execute(human, 'token-create', { name: 'laptop', scopes, expiresInDays });
    expect(response.status).toBe(201);
    return await response.json() as { id: string; token: string; neverExpires: boolean; expiresAt: number };
  }
  return { stub, human, workspaceId, node, switchOn, projects, hostProject, pat };
}
type Fixture = Awaited<ReturnType<typeof setup>>;
type Node = Awaited<ReturnType<Fixture['node']>>;
async function claim(f: Fixture, node: Node) { return await (await f.stub.execute(node, 'claim', {})).json() as Assignment; }
async function complete(f: Fixture, node: Node, lease: Lease, status: 'success' | 'failed', extra: Record<string, unknown> = {}, message = '') {
  return f.stub.execute(node, 'complete', { ...lease, result: { status, exitCode: status === 'success' ? 0 : 1, durationMs: 1, message, ...extra } });
}
// Switches a machine on, hosts the project and completes the copy on that machine.
async function hosted(f: Fixture, node?: Node) {
  const host = node ?? await f.node();
  await host.beat(); expect((await f.switchOn(host.id)).status).toBe(200);
  const started = await f.hostProject();
  expect(started.status).toBe(201);
  const assignment = await claim(f, host);
  expect(assignment.hasJob).toBe(true);
  expect((await complete(f, host, assignment.envelope.lease, 'success', { host: { tips, defaultBranch: 'master', bytes: 12345678 } })).status).toBe(200);
  const [shown] = await f.projects();
  expect(shown.hosted?.status).toBe('ready');
  return { host, shown };
}
function basic(username: string, password: string) { return 'Basic ' + btoa(`${username}:${password}`); }
async function gitFetch(path: string, init: RequestInit & { username?: string; password?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.password !== undefined) headers.set('Authorization', basic(init.username ?? '', init.password));
  return worker.fetch(new Request(origin + path, { ...init, headers }), env);
}
// Drives the machine's side of one relay: poll, download the body if any, upload `output`, complete.
async function serve(f: Fixture, node: Node, output: Uint8Array, extra: Record<string, unknown> = {}, status = 200) {
  let poll: Poll;
  for (let i = 0; ; i++) {
    poll = await (await f.stub.execute(node, 'git-poll', {})).json() as Poll;
    if (poll.relay) break;
    if (i > 100) throw new Error('no relay arrived');
    await new Promise(r => setTimeout(r, 20));
  }
  const relay = poll.relay!;
  const nodeHeaders = { Authorization: `Bearer ${node.token}`, 'X-Smith-Lease-Token': relay.leaseToken };
  let body: Uint8Array | null = null;
  if (relay.hasBody) {
    const got = await worker.fetch(new Request(`${origin}/api/v2/workspaces/${f.workspaceId}/git/relay/${relay.id}/body`, { headers: nodeHeaders }), env);
    expect(got.status).toBe(200);
    body = new Uint8Array(await got.arrayBuffer());
    expect(body.byteLength).toBe(relay.bodySize);
  }
  if (output.byteLength) {
    const part = await worker.fetch(new Request(`${origin}/api/v2/workspaces/${f.workspaceId}/git/relay/${relay.id}/response?part=1`, { method: 'POST', headers: { ...nodeHeaders, 'Content-Type': 'application/octet-stream', 'Content-Length': String(output.byteLength) }, body: output }), env);
    expect(part.status).toBe(200);
  }
  const done = await worker.fetch(new Request(`${origin}/api/v2/workspaces/${f.workspaceId}/git/relay/${relay.id}/complete`, { method: 'POST', headers: { ...nodeHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ relayId: relay.id, leaseToken: relay.leaseToken, status, size: output.byteLength, message: '', ...extra }) }), env);
  expect(done.status).toBe(200);
  return { relay, body };
}

describe('pure helpers', () => {
  it('recognises Smith-hosted remotes and builds clone addresses', () => {
    expect(smithRemote(origin, 'senet')).toBe(origin + '/git/senet.git');
    expect(smithRemoteRepo(origin + '/git/senet.git', origin)).toBe('senet');
    for (const bad of [origin + '/git/senet', origin + '/git/Senet.git', origin + '/git/../x.git', 'https://evil.example/git/senet.git', origin + '/git/senet.git/info/refs'])
      expect(smithRemoteRepo(bad, origin)).toBeNull();
    const ws = 'ab12'.repeat(16);
    expect(cloneUsername(ws)).toBe('ab12ab12ab12');
    expect(cloneUrl(origin, ws, 'senet')).toBe(`https://ab12ab12ab12@exp.redmarmosetstudios.com/git/senet.git`);
    expect(pktErr('No machine')).toBe('0013ERR No machine\n');
    expect(hostSpecs({ id: 'p', repoUrl: 'git@github.com:a/b.git', branch: 'main', commit: '' }, 'j', 'u', 'main').linux).toMatchObject({ kind: 'host', host: { repoUuid: 'u', defaultBranch: 'main' } });
  });
  it('validates and orders tips, and refuses Smith’s own quarantine namespace', async () => {
    expect(validateTips([[other, 'refs/tags/v1'], [commit, 'refs/heads/master'], [commit, 'refs/heads/master']])).toEqual([[commit, 'refs/heads/master'], [other, 'refs/tags/v1']]);
    expect(() => validateTips([['nope', 'refs/heads/x']])).toThrow();
    expect(() => validateTips([[commit, 'refs/smith/recovered/1/x']])).toThrow();
    expect(validRef('refs/heads/feature/one')).toBe(true);
    for (const bad of ['HEAD', 'refs/heads/..', 'refs/heads/a b', 'refs/heads/x.lock', 'refs/heads/', 'refs/heads/a@{1}']) expect(validRef(bad)).toBe(false);
    expect(await tipsDigest(tips)).toMatch(/^[a-f0-9]{64}$/);
  });
  it('decides eligibility from the switch, the label, the purpose and freshness', () => {
    const now = 1_000_000; const base = { id: 'n', hostname: 'h', active: 1, purpose: 'build', labels: JSON.stringify([GIT_HOST_LABEL]), last_seen_at: now, host_repos: 1, draining: 0 };
    expect(hostEligible(base, now, 60000)).toBe(true);
    expect(hostEligible({ ...base, host_repos: 0 }, now, 60000)).toBe(false);
    expect(hostEligible({ ...base, purpose: 'personal' }, now, 60000)).toBe(false);
    expect(hostEligible({ ...base, labels: '[]' }, now, 60000)).toBe(false);
    expect(hostEligible({ ...base, last_seen_at: now - 61000 }, now, 60000)).toBe(false);
    expect(hostEligible({ ...base, draining: 1 }, now, 60000)).toBe(false);
  });
});

describe('keeping copies of a project on a machine', () => {
  it('needs a switched-on machine, then copies on it and builds from the copy', async () => {
    const f = await setup();
    const node = await f.node(); await node.beat();
    // Nothing switched on: the dashboard knows, and a copy is refused with the fix in the message.
    expect(await (await f.stub.execute(f.human, 'settings', {})).json()).toMatchObject({ hostingAvailable: false, cloneUsername: cloneUsername(f.workspaceId) });
    const refused = await f.hostProject();
    expect(refused.status).toBe(503);
    expect((await refused.json() as { error: { message: string } }).error.message).toContain('Keep copies of repositories here');
    // A personal machine cannot be switched on; a build machine can, by an admin.
    const laptop = await f.node([GIT_HOST_LABEL], 'laptop', 'personal');
    expect((await f.switchOn(laptop.id)).status).toBe(409);
    expect((await f.switchOn(node.id)).status).toBe(200);
    expect(await (await f.stub.execute(f.human, 'settings', {})).json()).toMatchObject({ hostingAvailable: true });
    const nodes = (await (await f.stub.execute(f.human, 'nodes', {})).json() as { nodes: { id: string; hostRepos: boolean; hostsOnline: boolean; hostingReason: string }[] }).nodes;
    expect(nodes.find(n => n.id === node.id)).toMatchObject({ hostRepos: true, hostsOnline: true, hostingReason: '' });
    expect(nodes.find(n => n.id === laptop.id)).toMatchObject({ hostRepos: false, hostingReason: 'Personal machines do not keep copies' });
    // Start the copy: a host job only a switched-on, labelled machine claims.
    const started = await f.hostProject('copy-1');
    expect(started.status).toBe(201);
    const { project: pending, job } = await started.json() as HostResponse;
    expect(job).toMatchObject({ kind: 'host', state: 'queued', product: 'copy-into-smith' });
    expect(pending.hosted).toMatchObject({ status: 'copying', repoId: 'senet' });
    expect(pending.repoUrl).toBe(project.repoUrl);
    expect(((await (await f.hostProject('copy-1')).json()) as HostResponse).job.id).toBe(job.id);   // replay
    expect((await f.hostProject('copy-2')).status).toBe(409);
    expect((await f.stub.execute(f.human, 'enqueue', { requestId: 'b0', projectId: 'senet', product: 'build' })).status).toBe(409);
    const unlabelled = await f.node(['smith-repo-projects'], 'old-agent'); await f.switchOn(unlabelled.id);
    expect((await claim(f, unlabelled)).hasJob).toBe(false);
    const off = await f.node([GIT_HOST_LABEL, GIT_CLIENT_LABEL], 'not-switched-on');
    expect((await claim(f, off)).hasJob).toBe(false);
    const assignment = await claim(f, node);
    expect(assignment.hasJob).toBe(true);
    expect(assignment.envelope.spec).toMatchObject({ kind: 'host', projectId: 'senet', host: { defaultBranch: 'master' } });
    expect(assignment.envelope.spec.repos[0]).toMatchObject({ url: project.repoUrl, authToken: '' });
    // The machine reports what it now holds; the project builds from Smith's copy.
    expect((await complete(f, node, assignment.envelope.lease, 'success', { host: { tips, defaultBranch: 'master', bytes: 12345678 } })).status).toBe(200);
    const [done] = await f.projects();
    expect(done.repoUrl).toBe(smithRemote(origin, 'senet'));
    expect(done.hosted).toMatchObject({ status: 'ready', state: 'hosting', primaryHost: 'desktop-sem', serving: 1, cloneUrl: cloneUrl(origin, f.workspaceId, 'senet') });
    expect(done.hosted?.copies).toMatchObject([{ host: 'desktop-sem', primary: true, state: 'current' }]);
    expect(await (await f.stub.execute(f.human, 'git-clone-info', { repo: 'senet' })).json()).toMatchObject({ cloneUrl: cloneUrl(origin, f.workspaceId, 'senet'), username: cloneUsername(f.workspaceId), defaultBranch: 'master' });
    expect((await f.hostProject()).status).toBe(409);
    // A build on the machine that holds the copy clones its own store at the recorded tip; an old agent never sees the job.
    expect((await f.stub.execute(f.human, 'enqueue', { requestId: 'b1', projectId: 'senet', product: 'build' })).status).toBe(201);
    expect((await claim(f, unlabelled)).hasJob).toBe(false);
    const build = await claim(f, node);
    expect(build.envelope.spec).toMatchObject({ kind: 'build', projectId: 'senet' });
    expect(build.envelope.spec.repos[0]).toMatchObject({ url: smithRemote(origin, 'senet'), hostedUuid: done.hosted!.uuid, tip: commit, authToken: '' });
    await complete(f, node, build.envelope.lease, 'success');
    // A build on another switched-on machine carries a ticket bound to it and to the job.
    const second = await f.node([GIT_HOST_LABEL, GIT_CLIENT_LABEL], 'mac-mini'); await second.beat(); await f.switchOn(second.id);
    expect((await f.stub.execute(f.human, 'enqueue', { requestId: 'b2', projectId: 'senet', product: 'build' })).status).toBe(201);
    const remote = await claim(f, second);
    expect(remote.envelope.spec.repos[0].authToken).toMatch(/^smith_git_[a-f0-9]{64}_/);
    expect(remote.envelope.spec.repos[0].hostedUuid).toBeUndefined();
    const ticketHash = await hash(remote.envelope.spec.repos[0].authToken);
    await runInDurableObject(f.stub, (_o, state) => {
      const row = state.storage.sql.exec<{ node_id: string; job_id: string; scope: string; revoked_at: number | null }>('SELECT node_id, job_id, scope, revoked_at FROM git_tickets WHERE hash = ?', ticketHash).one();
      expect(row).toMatchObject({ node_id: second.id, job_id: remote.envelope.lease.jobId, scope: 'read', revoked_at: null });
    });
    await complete(f, second, remote.envelope.lease, 'success');
    await runInDurableObject(f.stub, (_o, state) => {
      expect(state.storage.sql.exec<{ revoked_at: number | null }>('SELECT revoked_at FROM git_tickets WHERE hash = ?', ticketHash).one().revoked_at).not.toBeNull();
    });
  });
  it('leaves the project where it was when the copy fails, and allows another try', async () => {
    const f = await setup(); const node = await f.node(); await node.beat(); await f.switchOn(node.id);
    const { job } = await (await f.hostProject()).json() as HostResponse;
    const assignment = await claim(f, node);
    expect((await complete(f, node, assignment.envelope.lease, 'failed', {}, 'git clone failed: no space left')).status).toBe(200);
    let [shown] = await f.projects();
    expect(shown.repoUrl).toBe(project.repoUrl);
    expect(shown.hosted).toMatchObject({ status: 'failed', message: 'git clone failed: no space left', state: 'failed' });
    // A machine whose Git login cannot read the source gives the job back for another machine.
    const retry = await (await f.hostProject()).json() as HostResponse;
    expect(retry.job.id).not.toBe(job.id);
    const second = await claim(f, node);
    expect((await complete(f, node, second.envelope.lease, 'failed', { failure: 'repo_access' }, 'Permission denied (publickey)')).status).toBe(200);
    expect((await (await f.stub.execute(f.human, 'get', { jobId: retry.job.id })).json() as { state: string }).state).toBe('queued');
    [shown] = await f.projects();
    expect(shown.hosted?.status).toBe('copying');
    // Cancelling settles it.
    await f.stub.execute(f.human, 'cancel', { jobId: retry.job.id });
    [shown] = await f.projects();
    expect(shown.hosted).toMatchObject({ status: 'failed' });
    expect(shown.hosted?.message).toContain('cancelled');
  });
  it('switching the only machine off loses the repository for now and the card says so', async () => {
    const f = await setup(); const { host } = await hosted(f);
    expect((await f.switchOn(host.id, false)).status).toBe(200);
    const [shown] = await f.projects();
    expect(shown.hosted).toMatchObject({ state: 'lost', serving: 0 });
    expect(shown.hosted?.message).toContain('desktop-sem');
    expect(shown.hosted?.copies).toMatchObject([{ state: 'lost' }]);
  });
  it('mints never-expiring git credentials and still refuses anything past the role', async () => {
    const f = await setup();
    const credential = await f.pat(['read', 'build'], null);
    expect(credential).toMatchObject({ neverExpires: true, expiresAt: NEVER_EXPIRES });
    const listed = (await (await f.stub.execute(f.human, 'tokens', {})).json() as { tokens: { neverExpires: boolean }[] }).tokens;
    expect(listed[0].neverExpires).toBe(true);
    expect((await f.stub.execute(f.human, 'token-create', { name: 'x', scopes: ['read'], expiresInDays: 45 })).status).toBe(400);
  });
});

describe('git over the coordinator', () => {
  it('challenges, refuses the wrong kinds of credential, and explains itself to git', async () => {
    const f = await setup(); const { host } = await hosted(f);
    const anonymous = await gitFetch('/git/senet.git/info/refs?service=git-upload-pack');
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get('WWW-Authenticate')).toContain('Basic realm="Smith"');
    expect((await gitFetch('/git/senet.git/info/refs?service=git-upload-pack', { password: host.token })).status).toBe(401);          // a machine credential
    expect((await gitFetch('/git/senet.git/info/refs?service=git-upload-pack', { password: `smith_run_${f.workspaceId}_${'a'.repeat(40)}` })).status).toBe(403);
    expect((await gitFetch('/git/senet.git/info/refs?service=git-upload-pack', { password: 'hunter2' })).status).toBe(401);
    expect((await gitFetch('/git/senet.git/info/refs')).status).toBe(403);                      // dumb http
    expect((await gitFetch('/git/senet.git/objects/info/packs')).status).toBe(404);
    const token = (await f.pat(['read'])).token;
    expect((await gitFetch('/git/senet.git/info/refs?service=git-upload-pack', { username: 'f'.repeat(12), password: token })).status).toBe(401);   // another workspace's username
    expect((await gitFetch('/git/nowhere.git/info/refs?service=git-upload-pack', { password: token })).status).toBe(404);
    // A read-only token asking to push gets a sentence, not a bare 403.
    const readOnly = await gitFetch('/git/senet.git/info/refs?service=git-receive-pack', { username: cloneUsername(f.workspaceId), password: token });
    expect(readOnly.status).toBe(200);
    expect(readOnly.headers.get('Content-Type')).toBe('application/x-git-receive-pack-advertisement');
    expect(await readOnly.text()).toMatch(/^[0-9a-f]{4}ERR This Smith token cannot push/);
    expect((await gitFetch('/git/senet.git/git-receive-pack', { method: 'POST', headers: { 'Content-Type': 'application/x-git-receive-pack-request' }, body: 'x', password: token })).status).toBe(403);
    // Expired and revoked tokens are true 401s so helpers forget them.
    const short = await f.pat(['read'], 7);
    await f.stub.execute(f.human, 'token-revoke', { tokenId: short.id });
    expect((await gitFetch('/git/senet.git/info/refs?service=git-upload-pack', { password: short.token })).status).toBe(401);
  });
  it('relays a fetch: advertisement, then the RPC with its gzipped body inflated for the machine', async () => {
    const f = await setup(); const { host } = await hosted(f);
    const token = (await f.pat(['read'], null)).token;
    // A protocol v0 advertisement (no Git-Protocol header) is the machine's to give; v2 is answered from the record (below).
    const advertisement = new TextEncoder().encode('00a1' + commit + ' refs/heads/master\0multi_ack side-band-64k agent=git/smith\n0000');
    const request = gitFetch('/git/senet.git/info/refs?service=git-upload-pack', { username: cloneUsername(f.workspaceId), password: token });
    const served = await serve(f, host, advertisement);
    expect(served.relay).toMatchObject({ service: 'upload-pack', op: 'info-refs', writer: false, gitProtocol: '', hasBody: false, refPolicy: { allow: ['refs/heads/*', 'refs/tags/*'], protected: ['refs/heads/master'] } });
    const response = await request;
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/x-git-upload-pack-advertisement');
    expect(response.headers.get('Cache-Control')).toContain('no-cache');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(advertisement);
    // The RPC: git gzips bodies over 1 KiB; the machine receives plain bytes.
    const plain = new TextEncoder().encode('0011command=fetch0001000fno-progress' + '0032want ' + commit + '\n'.repeat(200) + '0009done\n0000');
    const gzipped = new Uint8Array(await new Response(new Blob([plain]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
    const pack = new Uint8Array(3 * 1024 * 1024 + 17).fill(7);
    const rpc = gitFetch('/git/senet.git/git-upload-pack', { method: 'POST', username: cloneUsername(f.workspaceId), password: token, headers: { 'Content-Type': 'application/x-git-upload-pack-request', 'Content-Encoding': 'gzip', 'Git-Protocol': 'version=2' }, body: gzipped });
    const rpcServed = await serve(f, host, pack);
    expect(rpcServed.relay).toMatchObject({ op: 'rpc', hasBody: true, bodySize: plain.byteLength });
    expect(rpcServed.body).toEqual(plain);
    const result = await rpc;
    expect(result.status).toBe(200);
    expect(result.headers.get('Content-Type')).toBe('application/x-git-upload-pack-result');
    expect(new Uint8Array(await result.arrayBuffer())).toEqual(pack);
    // Nothing is left behind in the mailbox once delivered (cleanup runs in waitUntil, after the response).
    await vi.waitFor(async () => expect((await env.GIT.list({ prefix: `relay/${f.workspaceId}/` })).objects).toHaveLength(0), { timeout: 5000, interval: 50 });
  });
  it('refuses a body that inflates past the cap, and a malformed gzip body', async () => {
    const f = await setup(); const { host } = await hosted(f);
    const token = (await f.pat(['read'], null)).token;
    const zeros = new Uint8Array(17 * 1024 * 1024);
    const bomb = new Uint8Array(await new Response(new Blob([zeros]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
    expect(bomb.byteLength).toBeLessThan(64 * 1024);
    const refused = await gitFetch('/git/senet.git/git-upload-pack', { method: 'POST', username: cloneUsername(f.workspaceId), password: token, headers: { 'Content-Type': 'application/x-git-upload-pack-request', 'Content-Encoding': 'gzip' }, body: bomb });
    expect(refused.status).toBe(413);
    const broken = await gitFetch('/git/senet.git/git-upload-pack', { method: 'POST', username: cloneUsername(f.workspaceId), password: token, headers: { 'Content-Type': 'application/x-git-upload-pack-request', 'Content-Encoding': 'gzip' }, body: 'not gzip at all' });
    expect(broken.status).toBe(400);
    // Neither left a relay for the machine.
    expect(((await (await f.stub.execute(host, 'git-poll', {})).json()) as Poll).relay).toBeNull();
    void host;
  });
  it('relays a push to the primary and records the new tips before the client sees the report', async () => {
    const f = await setup(); const { host } = await hosted(f);
    const token = (await f.pat(['read', 'build'], null)).token;
    const newTip = '2'.repeat(40);
    const report = new TextEncoder().encode('000eunpack ok\n0019ok refs/heads/master\n0000');
    const push = gitFetch('/git/senet.git/git-receive-pack', { method: 'POST', username: cloneUsername(f.workspaceId), password: token, headers: { 'Content-Type': 'application/x-git-receive-pack-request' }, body: new Uint8Array(2048).fill(1) });
    const served = await serve(f, host, report, { tips: [[newTip, 'refs/heads/master'], [other, 'refs/tags/v1']], bytes: 12400000 });
    expect(served.relay).toMatchObject({ service: 'receive-pack', writer: true, hasBody: true, bodySize: 2048 });
    const response = await push;
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(report);
    const [shown] = await f.projects();
    expect(shown.hosted).toMatchObject({ generation: 2, refs: 2 });
    await runInDurableObject(f.stub, (_o, state) => {
      const repo = state.storage.sql.exec<{ refs_json: string; last_push_at: number | null; bytes: number }>('SELECT refs_json, last_push_at, bytes FROM git_repos WHERE id = ?', 'senet').one();
      expect(JSON.parse(repo.refs_json)).toEqual([[newTip, 'refs/heads/master'], [other, 'refs/tags/v1']]);
      expect(repo.last_push_at).not.toBeNull(); expect(repo.bytes).toBe(12400000);
      expect(state.storage.sql.exec<{ result: string }>('SELECT result FROM git_audit ORDER BY seq DESC LIMIT 1').one().result).toBe('status 200');
    });
    // A prepared project still builds its pinned commit from the machine's own copy; the record moved on regardless.
    expect((await f.stub.execute(f.human, 'enqueue', { requestId: 'b-after-push', projectId: 'senet', product: 'build' })).status).toBe(201);
    const next = await claim(f, host);
    expect(next.envelope.spec.repos[0]).toMatchObject({ hostedUuid: shown.hosted!.uuid, tip: commit });
  });
  it('tells git when no machine is online, and fails a request nobody picks up', async () => {
    const f = await setup(); const { host } = await hosted(f);
    const token = (await f.pat(['read'], null)).token;
    // Time passes: the machine stops heartbeating.
    await runInDurableObject(f.stub, (_o, state) => { state.storage.sql.exec('UPDATE nodes SET last_seen_at = ? WHERE id = ?', Date.now() - 120000, host.id); });
    const offline = await gitFetch('/git/senet.git/info/refs?service=git-upload-pack', { username: cloneUsername(f.workspaceId), password: token });
    expect(offline.status).toBe(200);
    const text = await offline.text();
    expect(text).toMatch(/ERR No machine holding this repository is online\. desktop-sem is offline; start it/);
    expect((await gitFetch('/git/senet.git/git-upload-pack', { method: 'POST', username: cloneUsername(f.workspaceId), password: token, headers: { 'Content-Type': 'application/x-git-upload-pack-request' }, body: '0000' })).status).toBe(503);
    // Back online, but its agent never polls: the request fails after the ready timeout (1.5 s in tests).
    await host.beat();
    const started = Date.now();
    const unanswered = await gitFetch('/git/senet.git/info/refs?service=git-upload-pack', { username: cloneUsername(f.workspaceId), password: token });
    expect(Date.now() - started).toBeLessThan(4000);
    expect(await unanswered.text()).toMatch(/ERR No machine answered in time/);
  });
  it('a ticket clones only its repository, only from its machine, and never pushes without write scope', async () => {
    const f = await setup(); const { host } = await hosted(f);
    const second = await f.node([GIT_HOST_LABEL, GIT_CLIENT_LABEL], 'mac-mini'); await second.beat(); await f.switchOn(second.id);
    expect((await f.stub.execute(f.human, 'enqueue', { requestId: 'tb', projectId: 'senet', product: 'build' })).status).toBe(201);
    const build = await claim(f, second);
    const ticket = build.envelope.spec.repos[0].authToken;
    expect(ticket).toMatch(/^smith_git_/);
    const path = '/git/senet.git/info/refs?service=git-upload-pack';
    // Without the machine's own credential beside it, or with another machine's, the ticket is refused.
    expect((await gitFetch(path, { password: ticket })).status).toBe(401);
    expect((await gitFetch(path, { password: ticket, headers: { 'X-Smith-Node': host.token } })).status).toBe(401);
    // Presented by its machine it is served: the v2 advertisement from the record, a v0 one by the primary through a relay.
    expect(await (await gitFetch(path, { password: ticket, headers: { 'X-Smith-Node': second.token, 'Git-Protocol': 'version=2' } })).text()).toBe(v2Advertisement());
    const advertisement = new TextEncoder().encode('0000');
    const request = gitFetch(path, { password: ticket, headers: { 'X-Smith-Node': second.token } });
    const served = await serve(f, host, advertisement);
    expect(served.relay).toMatchObject({ service: 'upload-pack', writer: false });
    const response = await request;
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(advertisement);
    // A read ticket cannot push, and it dies with its job.
    expect((await gitFetch('/git/senet.git/git-receive-pack', { method: 'POST', headers: { 'Content-Type': 'application/x-git-receive-pack-request', 'X-Smith-Node': second.token }, body: '0000', password: ticket })).status).toBe(403);
    await complete(f, second, build.envelope.lease, 'success');
    expect((await gitFetch(path, { password: ticket, headers: { 'X-Smith-Node': second.token } })).status).toBe(401);
  });
});

type Task = { id: string; leaseToken: string; kind: string; repoId: string; repoUuid: string; defaultBranch: string; payload: Record<string, unknown> };
type TaskPoll = { relay: Poll['relay']; task: Task | null; held: { repoId: string; primary: boolean; state: string }[] };
type HostedView = Hosted & { state?: string; refs?: number; copies: { host: string; primary: boolean; state: string }[]; backups: { count: number; newestAt: number | null; restorable: boolean }; tasks: { kind: string; host: string }[]; recovered: { host: string; nodeId: string; ref: string; sha: string }[]; lastBackupAt: number | null; message?: string };
async function pollTask(f: Fixture, node: Node): Promise<Task | null> { return ((await (await f.stub.execute(node, 'git-poll', {})).json()) as TaskPoll).task; }
async function taskRequest(f: Fixture, node: Node, task: Task, step: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers); headers.set('Authorization', `Bearer ${node.token}`); headers.set('X-Smith-Lease-Token', task.leaseToken);
  return worker.fetch(new Request(`${origin}/api/v2/workspaces/${f.workspaceId}/git/task/${task.id}/${step}`, { ...init, headers }), env);
}
async function finishTask(f: Fixture, node: Node, task: Task, body: Record<string, unknown>) {
  return taskRequest(f, node, task, 'complete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ taskId: task.id, leaseToken: task.leaseToken, ...body }) });
}
async function hostedView(f: Fixture): Promise<HostedView> { return (await f.projects())[0].hosted as HostedView; }
async function alarm(f: Fixture) { await runInDurableObject(f.stub, async (object: { alarm(): Promise<void> }) => { await object.alarm(); }); }
async function wentOffline(f: Fixture, node: Node, hoursAgo = 2) { await runInDurableObject(f.stub, (_o, state) => { state.storage.sql.exec('UPDATE nodes SET last_seen_at = ? WHERE id = ?', Date.now() - hoursAgo * 3600000, node.id); }); }
const newTips: [string, string][] = [[other, 'refs/heads/master'], [commit, 'refs/heads/wip'], [other, 'refs/tags/v1']];

describe('copies, failover, backups and recovery', () => {
  it('replicates to every other switched-on machine, fetches never come back to the fetching machine, and a push makes copies stale', async () => {
    const f = await setup(); const { host } = await hosted(f);
    const second = await f.node([GIT_HOST_LABEL, GIT_CLIENT_LABEL], 'mac-mini'); await second.beat();
    expect((await f.switchOn(second.id)).status).toBe(200);
    // Switching on queued the copy: the second machine's poll carries a replicate task with a ticket bound to it.
    const task = await pollTask(f, second);
    expect(task?.kind).toBe('replicate'); expect(task!.repoUuid).toMatch(/^[a-f0-9-]{36}$/);
    expect(task!.payload.remote).toBe(smithRemote(origin, 'senet')); expect(task!.payload.recordTips).toEqual(tips); expect(task!.payload.defaultBranch).toBe('master');
    const ticket = task!.payload.ticket as string; expect(ticket).toMatch(/^smith_git_/);
    // Its fetch through the coordinator is relayed to the primary, never to itself.
    const pending = gitFetch('/git/senet.git/info/refs?service=git-upload-pack', { password: ticket, headers: { 'X-Smith-Node': second.token } });
    const { relay } = await serve(f, host, new TextEncoder().encode('0000'));
    expect(relay.service).toBe('upload-pack'); expect((await pending).status).toBe(200);
    expect(await pollTask(f, second)).toBeNull();   // one task at a time per machine
    expect((await finishTask(f, second, task!, { ok: true, tips, bytes: 12345678 })).status).toBe(200);
    let view = await hostedView(f);
    expect(view.copies.map(c => [c.host, c.primary, c.state]).sort()).toEqual([['desktop-sem', true, 'current'], ['mac-mini', false, 'current']]);
    expect(view.serving).toBe(2);
    // A read may now be served by the copy: with the primary offline the relay goes to the second machine.
    await wentOffline(f, host);
    const { token } = await f.pat(['read']);
    const read = gitFetch('/git/senet.git/info/refs?service=git-upload-pack', { username: cloneUsername(f.workspaceId), password: token });
    const served = await serve(f, second, new TextEncoder().encode('0000'));
    expect(served.relay.service).toBe('upload-pack'); expect((await read).status).toBe(200);
    await host.beat();
    // A push on the primary moves the record; the copy is stale and gets a new replicate task carrying the new record.
    const { token: pushToken } = await f.pat();
    const push = gitFetch('/git/senet.git/git-receive-pack', { method: 'POST', headers: { 'Content-Type': 'application/x-git-receive-pack-request' }, body: new Uint8Array([0x30, 0x30, 0x30, 0x30]), username: cloneUsername(f.workspaceId), password: pushToken });
    await serve(f, host, new TextEncoder().encode('000eunpack ok\n0000'), { tips: newTips, bytes: 12345679 });
    expect((await push).status).toBe(200);
    view = await hostedView(f);
    expect(view.copies.find(c => c.host === 'mac-mini')?.state).toBe('stale');
    const again = await pollTask(f, second);
    expect(again?.kind).toBe('replicate'); expect(again!.payload.recordTips).toEqual([...newTips].sort((a, b) => a[1] < b[1] ? -1 : 1));
    // Reporting the old refs leaves it stale; reporting the record makes it current again.
    expect((await finishTask(f, second, again!, { ok: true, tips, bytes: 1 })).status).toBe(200);
    expect((await hostedView(f)).copies.find(c => c.host === 'mac-mini')?.state).toBe('stale');
    await alarm(f);
    const third = await pollTask(f, second); expect(third?.kind).toBe('replicate');
    expect((await finishTask(f, second, third!, { ok: true, tips: newTips, bytes: 1 })).status).toBe(200);
    expect((await hostedView(f)).copies.find(c => c.host === 'mac-mini')?.state).toBe('current');
  });

  it('promotes a current copy when the primary is gone, and the old primary comes back as a copy', async () => {
    const f = await setup(); const { host } = await hosted(f);
    const second = await f.node([GIT_HOST_LABEL, GIT_CLIENT_LABEL], 'mac-mini'); await second.beat(); await f.switchOn(second.id);
    const task = await pollTask(f, second); expect((await finishTask(f, second, task!, { ok: true, tips, bytes: 1 })).status).toBe(200);
    await wentOffline(f, host);
    // A push arrives: the coordinator promotes the current copy at once and relays the push there.
    const { token } = await f.pat();
    const push = gitFetch('/git/senet.git/git-receive-pack', { method: 'POST', headers: { 'Content-Type': 'application/x-git-receive-pack-request' }, body: new Uint8Array([0x30, 0x30, 0x30, 0x30]), username: cloneUsername(f.workspaceId), password: token });
    const { relay } = await serve(f, second, new TextEncoder().encode('000eunpack ok\n0000'), { tips: newTips, bytes: 2 });
    expect(relay.writer).toBe(true); expect((await push).status).toBe(200);
    const view = await hostedView(f);
    expect(view.primaryHost).toBe('mac-mini'); expect(view.state).toBe('hosting');
    expect(view.copies.find(c => c.host === 'desktop-sem')?.state).toBe('stale');
    // The old primary returns: it is told to sync, and what it held beyond the record is kept aside for a person.
    await host.beat();
    const sync = await pollTask(f, host); expect(sync?.kind).toBe('replicate');
    const synced = await finishTask(f, host, sync!, { ok: true, tips: newTips, bytes: 2, recovered: [[commit, 'refs/smith/recovered/1700000000/heads/experiment']] });
    expect([synced.status, await synced.text()]).toEqual([200, expect.any(String)]);
    const after = await hostedView(f);
    expect(after.copies.find(c => c.host === 'desktop-sem')?.state).toBe('current');
    expect(after.recovered).toEqual([expect.objectContaining({ host: 'desktop-sem', ref: 'refs/smith/recovered/1700000000/heads/experiment', sha: commit })]);
    // Promote pushes it to the primary through the relay with a write ticket for that ref alone; discard drops it.
    const promote = await f.stub.execute(f.human, 'git-recovered', { repoId: 'senet', nodeId: host.id, ref: 'refs/smith/recovered/1700000000/heads/experiment', action: 'promote' });
    expect(promote.status).toBe(200);
    const pushTask = await pollTask(f, host);
    expect(pushTask?.kind).toBe('promote'); expect(pushTask!.payload).toMatchObject({ sha: commit, ref: 'refs/heads/experiment', recoveredRef: 'refs/smith/recovered/1700000000/heads/experiment' });
    const writeTicket = pushTask!.payload.ticket as string;
    const relayed = gitFetch('/git/senet.git/git-receive-pack', { method: 'POST', headers: { 'Content-Type': 'application/x-git-receive-pack-request', 'X-Smith-Node': host.token }, body: new Uint8Array([0x30, 0x30, 0x30, 0x30]), password: writeTicket });
    const servedPush = await serve(f, second, new TextEncoder().encode('000eunpack ok\n0000'), { tips: [...newTips, [commit, 'refs/heads/experiment']], bytes: 3 });
    expect(servedPush.relay.refPolicy.allow).toEqual(['refs/heads/experiment']); expect((await relayed).status).toBe(200);
    expect((await finishTask(f, host, pushTask!, { ok: true })).status).toBe(200);
    expect((await hostedView(f)).recovered).toEqual([]);
    expect((await hostedView(f)).refs).toBe(4);
  });

  it('bundles the primary into R2, keeps the manifests, and restores a lost repository from them', async () => {
    const f = await setup(); const { host } = await hosted(f);
    await alarm(f);
    // The first backup is a full bundle on the primary, uploaded in parts and recorded only when whole.
    const backup = await pollTask(f, host);
    expect(backup?.kind).toBe('backup'); expect(backup!.payload.kind).toBe('full'); expect(backup!.payload.baseTips).toBeNull();
    const bundle = new TextEncoder().encode('# v2 git bundle\n...');
    const part = await taskRequest(f, host, backup!, 'part?part=1', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(bundle.byteLength) }, body: bundle });
    expect(part.status).toBe(200);
    expect((await finishTask(f, host, backup!, { ok: true, size: bundle.byteLength + 1, sha256: '', tips, kind: 'full' })).status).toBe(400);   // the bucket holds fewer bytes than declared
    expect((await finishTask(f, host, backup!, { ok: true, size: bundle.byteLength, sha256: 'abc', tips, kind: 'full' })).status).toBe(200);
    let view = await hostedView(f);
    expect(view.backups).toMatchObject({ count: 1, restorable: true }); expect(view.lastBackupAt).not.toBeNull();
    expect(await pollTask(f, host)).toBeNull();   // nothing new to bundle
    // The primary is switched off with no other copy: the repository is lost; a fresh machine restores it from the bundle.
    expect((await f.switchOn(host.id, false)).status).toBe(200);
    view = await hostedView(f); expect(view.state).toBe('lost');
    expect(await pollTask(f, host)).toBeNull();   // the only copy is never thrown away
    const fresh = await f.node([GIT_HOST_LABEL, GIT_CLIENT_LABEL], 'linux-box'); await fresh.beat(); await f.switchOn(fresh.id);
    await alarm(f);
    const restore = await pollTask(f, fresh);
    expect(restore?.kind).toBe('restore');
    const chain = restore!.payload.backups as { id: string; kind: string; size: number }[];
    expect(chain).toHaveLength(1); expect(chain[0].kind).toBe('full'); expect(restore!.payload.newestTips).toEqual(tips);
    const body = await taskRequest(f, fresh, restore!, `body?backup=${chain[0].id}`);
    expect(body.status).toBe(200); expect(new Uint8Array(await body.arrayBuffer())).toEqual(bundle);
    expect((await finishTask(f, fresh, restore!, { ok: true, tips, bytes: 5 })).status).toBe(200);
    view = await hostedView(f);
    expect(view.state).toBe('hosting'); expect(view.primaryHost).toBe('linux-box');
    expect(view.copies).toEqual(expect.arrayContaining([expect.objectContaining({ host: 'linux-box', primary: true, state: 'current' }), expect.objectContaining({ host: 'desktop-sem', primary: false, state: 'lost' })]));
  });

  it('a restore behind the record refuses pushes until an owner accepts the loss', async () => {
    const f = await setup(); const { host } = await hosted(f);
    await alarm(f);
    const backup = await pollTask(f, host);
    const bundle = new TextEncoder().encode('bundle');
    await taskRequest(f, host, backup!, 'part?part=1', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': '6' }, body: bundle });
    expect((await finishTask(f, host, backup!, { ok: true, size: 6, sha256: '', tips: [[commit, 'refs/heads/master']], kind: 'full' })).status).toBe(200);
    // The record moves on after the backup (a push), then the primary is lost.
    const { token } = await f.pat();
    const push = gitFetch('/git/senet.git/git-receive-pack', { method: 'POST', headers: { 'Content-Type': 'application/x-git-receive-pack-request' }, body: new Uint8Array([0x30, 0x30, 0x30, 0x30]), username: cloneUsername(f.workspaceId), password: token });
    await serve(f, host, new TextEncoder().encode('000eunpack ok\n0000'), { tips: newTips, bytes: 2 });
    expect((await push).status).toBe(200);
    await f.switchOn(host.id, false);
    const fresh = await f.node([GIT_HOST_LABEL, GIT_CLIENT_LABEL], 'linux-box'); await fresh.beat(); await f.switchOn(fresh.id);
    expect((await f.stub.execute(f.human, 'git-restore', { repoId: 'senet' })).status).toBe(200);
    const restore = await pollTask(f, fresh); expect(restore?.kind).toBe('restore');
    expect((await finishTask(f, fresh, restore!, { ok: true, tips: [[commit, 'refs/heads/master']], bytes: 5 })).status).toBe(200);
    let view = await hostedView(f);
    expect(view.state).toBe('degraded'); expect(view.message).toMatch(/3 refs newer in Smith’s record may be lost/);
    // Reads are served from the restored copy; pushes are refused with the reason.
    const refused = await gitFetch('/git/senet.git/info/refs?service=git-receive-pack', { username: cloneUsername(f.workspaceId), password: token });
    expect(await refused.text()).toMatch(/restored from a backup and refuses pushes/);
    const accepted = await f.stub.execute(f.human, 'git-accept-dataloss', { repoId: 'senet' });
    expect(accepted.status).toBe(200);
    view = await hostedView(f);
    expect(view.state).toBe('hosting'); expect(view.refs).toBe(1);
    expect(view.copies).toEqual(expect.arrayContaining([expect.objectContaining({ host: 'linux-box', primary: true, state: 'current' }), expect.objectContaining({ host: 'desktop-sem', primary: false, state: 'lost' })]));
    expect((await f.stub.execute(f.human, 'git-accept-dataloss', { repoId: 'senet' })).status).toBe(409);
  });

  it('a primary switched off and on again brings the repository back by reporting what it holds; a copy with siblings is discarded', async () => {
    const f = await setup(); const { host } = await hosted(f);
    expect((await f.switchOn(host.id, false)).status).toBe(200);
    expect((await hostedView(f)).state).toBe('lost');
    expect((await f.switchOn(host.id)).status).toBe(200);
    expect((await f.stub.execute(host, 'git-tips', { repoUuid: (await hostedView(f)).uuid, tips, bytes: 5 })).status).toBe(200);
    const view = await hostedView(f);
    expect(view.state).toBe('hosting'); expect(view.copies).toEqual([expect.objectContaining({ host: 'desktop-sem', primary: true, state: 'current' })]);
    // With a second current copy, switching the primary off promotes the copy and queues a discard of the old store.
    const second = await f.node([GIT_HOST_LABEL, GIT_CLIENT_LABEL], 'mac-mini'); await second.beat(); await f.switchOn(second.id);
    const task = await pollTask(f, second); expect((await finishTask(f, second, task!, { ok: true, tips, bytes: 1 })).status).toBe(200);
    expect((await f.switchOn(host.id, false)).status).toBe(200);
    const after = await hostedView(f);
    expect(after.state).toBe('hosting'); expect(after.primaryHost).toBe('mac-mini');
    const discard = await pollTask(f, host); expect(discard?.kind).toBe('discard');
    expect((await finishTask(f, host, discard!, { ok: true })).status).toBe(200);
    expect((await hostedView(f)).copies).toEqual([expect.objectContaining({ host: 'mac-mini', primary: true, state: 'current' })]);
  });

  it('keeps two full bundles with their incrementals and drops the rest', async () => {
    const mk = (id: string, kind: 'full' | 'incremental', createdAt: number, size = 10, baseId: string | null = null, ready = 1) => ({ id, repo_id: 'r', kind, key: `k/${id}`, size, sha256: '', tips_json: '[]', base_id: baseId, ready, created_at: createdAt });
    const rows = [mk('f1', 'full', 1), mk('i1', 'incremental', 2, 10, 'f1'), mk('f2', 'full', 3), mk('i2', 'incremental', 4, 10, 'f2'), mk('i3', 'incremental', 5, 10, 'i2'), mk('f3', 'full', 6), mk('pending', 'incremental', Date.now(), 0, 'f3', 0)];
    const { keep, drop } = retainBackups(rows);
    expect(keep.map(b => b.id).sort()).toEqual(['f2', 'f3', 'i2', 'i3']);
    expect(drop.map(b => b.id).sort()).toEqual(['f1', 'i1']);
    expect(restoreChain(rows).map(b => b.id)).toEqual(['f3']);
    expect(restoreChain(rows.filter(b => b.id !== 'f3')).map(b => b.id)).toEqual(['f2', 'i2', 'i3']);
    // Over budget, the older chain goes first; the newest full always stays.
    expect(retainBackups(rows, 15).keep.map(b => b.id)).toEqual(['f3']);
  });
});

describe('editing a project in place', () => {
  it('turns a pinned project into one that follows its branch, keeping its ID and copy, and switches what it builds from', async () => {
    const f = await setup(); await hosted(f);
    type Edited = { id: string; kind?: string; name: string; branch: string; repoUrl: string; scan?: { state: string; jobId: string | null }; hosted?: Hosted };
    const edit = async (body: Record<string, unknown>) => f.stub.execute(f.human, 'edit-project', { projectId: 'senet', ...body });
    expect((await edit({ branch: 'bad..branch' })).status).toBe(400);
    expect((await edit({ buildFrom: 'elsewhere' })).status).toBe(400);
    // Pinned → follows feature/x, still building from Smith's copy; a machine reads its smith.json there.
    const followed = await edit({ branch: 'feature/x', name: 'Senet game' });
    expect(followed.status).toBe(200);
    const shown = await followed.json() as Edited;
    expect(shown).toMatchObject({ id: 'senet', kind: 'repo', name: 'Senet game', branch: 'feature/x', repoUrl: smithRemote(origin, 'senet'), hosted: { status: 'ready' }, scan: { state: 'waiting' } });
    expect(shown.scan?.jobId).toBeTruthy();
    // Builds straight from the repository it was copied from (so pushes there count); the copy stays.
    const direct = await (await edit({ buildFrom: 'repository' })).json() as Edited;
    expect(direct).toMatchObject({ repoUrl: project.repoUrl, branch: 'feature/x', hosted: { status: 'ready' } });
    // The overtaken scan was cancelled; the new one reads the new source.
    const jobs = (await (await f.stub.execute(f.human, 'list', {})).json() as { jobs: { id: string; state: string }[] }).jobs;
    expect(jobs.find(j => j.id === shown.scan!.jobId)?.state).toBe('cancelled');
    expect((await (await edit({ buildFrom: 'copy' })).json() as Edited).repoUrl).toBe(smithRemote(origin, 'senet'));
    // A name alone does not read the project again.
    const renamed = await (await edit({ name: 'Senet' })).json() as Edited;
    expect(renamed.scan?.jobId).toBe((await (await f.stub.execute(f.human, 'projects', {})).json() as { projects: Edited[] }).projects[0].scan?.jobId);
    expect(await f.projects()).toHaveLength(1);
  });
});

describe('following its branch, read without a machine', () => {
  it('reads smith.json through GitHub when Smith’s copy is at GitHub’s head, so the card is ready at once', async () => {
    const f = await setup(); await hosted(f);
    await env.DB.batch([env.DB.prepare('INSERT OR IGNORE INTO users (id, created_at) VALUES (?, ?)').bind(f.human.userId, Date.now()),
      env.DB.prepare("INSERT INTO provider_tokens (user_id, provider, access_token, refresh_token, expires_at, updated_at) VALUES (?, 'github', 'tok', NULL, NULL, ?)").bind(f.human.userId, Date.now())]);
    const smithJson = JSON.stringify({ schemaVersion: 1, project: { id: 'senet', name: 'Senet' }, buildProducts: [{ name: 'build', rules: [{ name: 'b', branches: ['*'], command: { linux: { interpreter: 'sh', script: 'Build.sh' } } }] }],
      triggers: [{ type: 'webhook', branches: ['master'], product: 'build' }] });
    fakeGitHub.reset();
    fakeGitHub.repos.set('Red-Marmoset/senet', { defaultBranch: 'master', branches: { master: { commit, smithJson, paths: ['Build.sh'], truncated: false }, ahead: { commit: other, smithJson, paths: [], truncated: false } } });
    const edited = await (await f.stub.execute(f.human, 'edit-project', { projectId: 'senet', branch: 'master' })).json() as { kind: string; scan: { state: string; via: string }; onPush: string[]; commit: string; repoUrl: string };
    expect(edited).toMatchObject({ kind: 'repo', scan: { state: 'ready', via: 'github' }, onPush: ['build'], commit, repoUrl: smithRemote(origin, 'senet') });
    // A branch the copy does not have at GitHub's head is read by a machine instead.
    const behind = await (await f.stub.execute(f.human, 'edit-project', { projectId: 'senet', branch: 'ahead' })).json() as { scan: { state: string } };
    expect(behind.scan.state).toBe('waiting');
    fakeGitHub.reset();
  });
});

describe('a new repository in Smith, with no GitHub at all', () => {
  it('is created empty on a machine that keeps copies, read on its first push, and builds on push with no webhook', async () => {
    const f = await setup();
    // A machine on an older Smith (without smith-git-new) cannot create one: the refusal says so.
    const old = await f.node([GIT_HOST_LABEL, GIT_CLIENT_LABEL, 'smith-repo-projects'], 'old-pc'); await old.beat(); expect((await f.switchOn(old.id)).status).toBe(200);
    expect(await (await f.stub.execute(f.human, 'add-repo-project', { source: 'new', name: 'My Game' })).json()).toMatchObject({ error: { code: 'agent_outdated' } });
    const host = await f.node([GIT_HOST_LABEL, GIT_CLIENT_LABEL, 'smith-repo-projects', 'smith-git-new'], 'new-pc'); await host.beat(); expect((await f.switchOn(host.id)).status).toBe(200);
    expect((await f.stub.execute(f.human, 'add-repo-project', { source: 'new', name: ' ' })).status).toBe(400);
    const created = await f.stub.execute(f.human, 'add-repo-project', { source: 'new', name: 'My Game' });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ id: 'my-game', kind: 'repo', branch: 'main', repoUrl: smithRemote(origin, 'my-game'), hosted: { status: 'copying' }, scan: { state: 'waiting' } });
    // Only the machine that can start one takes the job; it creates the store empty.
    expect((await claim(f, old)).hasJob).toBe(false);
    const job = await claim(f, host);
    expect(job.envelope.spec).toMatchObject({ kind: 'host', projectId: 'my-game', host: { defaultBranch: 'main' } });
    expect(job.envelope.spec.repos[0]).toMatchObject({ url: smithRemote(origin, 'my-game'), authToken: '' });
    expect((await complete(f, host, job.envelope.lease, 'success', { host: { tips: [], defaultBranch: 'main', bytes: 0 } })).status).toBe(200);
    const shown = async () => (await f.projects()).find(p => p.id === 'my-game')! as Shown & { scan: { state: string; jobId: string | null }; commit: string | null; push?: { via: string } };
    expect((await shown()).hosted?.status).toBe('ready');
    // The first push is read straight away, Build on push or not.
    const { token } = await f.pat();
    const pushed = gitFetch('/git/my-game.git/git-receive-pack', { method: 'POST', headers: { 'Content-Type': 'application/x-git-receive-pack-request' }, body: new Uint8Array([0x30, 0x30, 0x30, 0x30]), username: cloneUsername(f.workspaceId), password: token });
    await serve(f, host, new TextEncoder().encode('000eunpack ok\n0000'), { tips: [[commit, 'refs/heads/main']], bytes: 2048 });
    expect((await pushed).status).toBe(200);
    expect((await shown()).scan.jobId).toBeTruthy();
    const scan = await claim(f, host); expect(scan.envelope.spec).toMatchObject({ kind: 'scan', projectId: 'my-game' });
    const smithJson = JSON.stringify({ schemaVersion: 1, project: { id: 'my-game', name: 'My Game' }, buildProducts: [{ name: 'build', rules: [{ name: 'b', branches: ['*'], command: { linux: { interpreter: 'sh', script: 'Build.sh' } } }] }] });
    expect((await complete(f, host, scan.envelope.lease, 'success', { commit, scan: { commit, branch: 'main', smithJson, paths: ['Build.sh'], truncated: false } })).status).toBe(200);
    expect(await shown()).toMatchObject({ commit, scan: { state: 'ready' } });
    // Build on push needs no webhook: nothing is linked, so a push to the copy is the trigger.
    expect(await (await f.stub.execute(f.human, 'push-builds', { projectId: 'my-game', enabled: true })).json()).toMatchObject({ project: { push: { enabled: true, via: 'smith' } } });
  });
});

describe('a git request whose wait goes wrong', () => {
  it('ends with the reason instead of spinning until a bare 500', async () => {
    const f = await setup(); await hosted(f);
    const { token } = await f.pat();
    const pending = gitFetch('/git/senet.git/info/refs?service=git-receive-pack', { username: cloneUsername(f.workspaceId), password: token });
    // The relay vanishes under the waiting client (the object's answer is then an error, not a state).
    for (let i = 0; i < 100; i++) {
      const gone = await runInDurableObject(f.stub, (_o, state) => state.storage.sql.exec('DELETE FROM git_relays').rowsWritten);
      if (gone) break;
      await new Promise(r => setTimeout(r, 20));
    }
    const started = Date.now();
    const response = await pending;
    // A ref listing carries the refusal as git's own ERR line, so git shows the reason to the person.
    expect(await response.text()).toContain('Smith could not follow this request');
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe('a job waiting for a machine', () => {
  it('says, machine by machine, why none has taken it', async () => {
    const f = await setup(); const { host } = await hosted(f);
    const old = await f.node([], 'old-laptop'); await old.beat();
    const busy = await f.node([GIT_CLIENT_LABEL, 'smith-repo-projects'], 'build-box'); await busy.beat();
    expect((await f.stub.execute(f.human, 'enqueue', { requestId: crypto.randomUUID(), projectId: 'senet', product: 'build' })).status).toBe(201);
    expect((await claim(f, busy)).hasJob).toBe(true);
    // Following the branch reads smith.json from Smith's copy, which needs an agent that can clone it.
    const edited = await (await f.stub.execute(f.human, 'edit-project', { projectId: 'senet', branch: 'master' })).json() as { scan: { state: string; message: string } };
    expect(edited.scan.state).toBe('waiting');
    expect(edited.scan.message).toContain('old-laptop runs an older Smith (no smith-repo-projects, smith-git-client)');
    expect(edited.scan.message).toContain('build-box is busy (build)');
    expect(edited.scan.message).toContain(`${host.hostname} should take it on its next check`);
    const jobs = (await (await f.stub.execute(f.human, 'list', {})).json() as { jobs: { kind: string; waiting?: string }[] }).jobs;
    expect(jobs.find(j => j.kind === 'scan')?.waiting).toContain('old-laptop runs an older Smith');
  });
});

describe('removing a project', () => {
  it('cancels its queued builds, waits for a running one, and has the machines throw their copies away', async () => {
    const f = await setup(); const { host } = await hosted(f);
    const enqueue = async () => (await (await f.stub.execute(f.human, 'enqueue', { requestId: crypto.randomUUID(), projectId: 'senet', product: 'build' })).json() as { id: string }).id;
    const first = await enqueue(), second = await enqueue();
    // A build on a machine blocks the removal, with the reason.
    const builder = await f.node([GIT_CLIENT_LABEL, 'smith-repo-projects'], 'builder'); await builder.beat();
    const running = await claim(f, builder); expect(running.envelope.lease.jobId).toBe(first);
    const refused = await f.stub.execute(f.human, 'remove-project', { projectId: 'senet' });
    expect(refused.status).toBe(409); expect(await refused.json()).toMatchObject({ error: { code: 'build_running' } });
    expect((await complete(f, builder, running.envelope.lease, 'success')).status).toBe(200);
    // A member below admin cannot remove it.
    const operator = { kind: 'human' as const, userId: crypto.randomUUID() };
    await runInDurableObject(f.stub, (_o, state) => { state.storage.sql.exec("INSERT INTO members (user_id, role) VALUES (?, 'operator')", operator.userId); });
    expect((await f.stub.execute(operator, 'remove-project', { projectId: 'senet' })).status).toBe(403);
    expect((await f.stub.execute(f.human, 'remove-project', { projectId: 'senet' })).status).toBe(200);
    expect(await f.projects()).toEqual([]);
    const jobs = (await (await f.stub.execute(f.human, 'list', {})).json() as { jobs: { id: string; state: string }[] }).jobs;
    expect(jobs.find(j => j.id === first)?.state).toBe('success'); expect(jobs.find(j => j.id === second)?.state).toBe('cancelled');
    // The repository answers no clone any more, and its machine is told to throw the copy away.
    const { token } = await f.pat(['read']);
    expect((await gitFetch('/git/senet.git/info/refs?service=git-upload-pack', { username: cloneUsername(f.workspaceId), password: token })).status).toBe(404);
    const discard = await pollTask(f, host);
    expect(discard?.kind).toBe('discard');
    expect((await finishTask(f, host, discard!, { ok: true })).status).toBe(200);
    expect(((await (await f.stub.execute(host, 'git-poll', {})).json()) as TaskPoll).held).toEqual([]);
    // Adding and copying it again starts afresh.
    expect((await f.stub.execute(f.human, 'put-project', project)).status).toBe(201);
    expect((await f.hostProject()).status).toBe(201);
    expect((await f.stub.execute(f.human, 'remove-project', { projectId: 'nothing-here' })).status).toBe(404);
  });
});

describe('Pull, Push and Detach on a Smith-hosted copy', () => {
  type SyncView = Hosted & { refs?: number; sync?: { direction: string; status: string; jobId: string; commit?: string; message?: string }; sourceRepoUrl: string; detachedFrom?: string };
  const syncer = (f: Fixture) => f.node([GIT_HOST_LABEL, GIT_CLIENT_LABEL, 'smith-repo-projects', 'smith-repo-sync'], 'sync-runner');
  async function repoProject(f: Fixture) {
    // A Git-URL project (the kind that can be linked), copied into Smith on a switched-on machine.
    expect((await f.stub.execute(f.human, 'add-repo-project', { source: 'git', url: 'https://github.com/Red-Marmoset/soccer-boy.git', branch: 'main' })).status).toBe(201);
    const host = await syncer(f); await host.beat(); expect((await f.switchOn(host.id)).status).toBe(200);
    // The machine reads smith.json first (the scan queued by Add project), then copies the repository in.
    const scan = await claim(f, host); expect(scan.envelope.spec.kind).toBe('scan');
    expect((await complete(f, host, scan.envelope.lease, 'success', { commit, scan: { commit, branch: 'main', smithJson: null, paths: [], truncated: false } })).status).toBe(200);
    expect((await f.hostProject(crypto.randomUUID(), 'soccer-boy')).status).toBe(201);
    const copy = await claim(f, host); expect(copy.envelope.spec.kind).toBe('host');
    expect((await complete(f, host, copy.envelope.lease, 'success', { host: { tips: [[commit, 'refs/heads/main']], defaultBranch: 'main', bytes: 100 } })).status).toBe(200);
    const view = async () => (await f.projects()).find(p => p.id === 'soccer-boy')! as Shown & { hosted?: SyncView; commit?: string | null };
    expect((await view()).hosted?.status).toBe('ready');
    return { host, view, sync: (direction: string, requestId = crypto.randomUUID()) => f.stub.execute(f.human, 'sync-project', { requestId, projectId: 'soccer-boy', direction }), link: (url: string) => f.stub.execute(f.human, 'link-project', { projectId: 'soccer-boy', url }) };
  }
  it('pulls the linked branch into Smith’s copy with a job-bound write ticket and confirms it from the record', async () => {
    const f = await setup(); const { host, view, sync } = await repoProject(f);
    const started = await sync('pull', 'pull-1'); expect(started.status).toBe(201);
    const { job } = await started.json() as HostResponse;
    expect(job).toMatchObject({ kind: 'mirror', product: 'pull-from-linked-repo' });
    expect((await view()).hosted?.sync).toMatchObject({ direction: 'pull', status: 'running', jobId: job.id });
    expect((await sync('push')).status).toBe(409);
    const assignment = await claim(f, host);
    expect(assignment.hasJob).toBe(true);
    const spec = assignment.envelope.spec as Assignment['envelope']['spec'] & { mirror: { remote: string; authToken: string; branch: string } };
    expect(spec.repos[0]).toMatchObject({ url: 'https://github.com/Red-Marmoset/soccer-boy.git', authToken: '', commit: '' });
    expect(spec.mirror).toMatchObject({ remote: smithRemote(origin, 'soccer-boy'), branch: 'main' }); expect(spec.mirror.authToken).toMatch(/^smith_git_/);
    // The ticket pushes main (and tags) through the relay, nothing else; the relay's completion moves the record.
    const pushed = gitFetch('/git/soccer-boy.git/git-receive-pack', { method: 'POST', headers: { 'Content-Type': 'application/x-git-receive-pack-request', 'X-Smith-Node': host.token }, body: new Uint8Array([0x30, 0x30, 0x30, 0x30]), password: spec.mirror.authToken });
    // While it waits, the card says which machine was handed the push.
    type Requests = { open: { host: string; what: string; who: string; state: string }[]; recent: { state: string }[] };
    let waiting: Requests | undefined;
    for (let i = 0; i < 100 && !waiting?.open.length; i++) { waiting = ((await view()).hosted as unknown as { requests: Requests }).requests; if (!waiting.open.length) await new Promise(r => setTimeout(r, 20)); }
    expect(waiting!.open).toEqual([expect.objectContaining({ host: 'sync-runner', what: 'push', who: 'pull' })]);
    const served = await serve(f, host, new TextEncoder().encode('000eunpack ok\n0000'), { tips: [[other, 'refs/heads/main']], bytes: 101 });
    expect(served.relay.refPolicy).toEqual({ allow: ['refs/heads/main', 'refs/tags/*'], protected: [], denyDelete: true }); expect((await pushed).status).toBe(200);
    expect((await complete(f, host, assignment.envelope.lease, 'success', { commit: other }, 'Pushed')).status).toBe(200);
    const after = await view();
    expect(after.hosted?.sync).toMatchObject({ direction: 'pull', status: 'done', commit: other });
    expect(after.hosted?.refs).toBe(1);
    // A pull whose commit never reached the copy fails, and the ticket is gone with the job.
    expect((await gitFetch('/git/soccer-boy.git/info/refs?service=git-upload-pack', { password: spec.mirror.authToken, headers: { 'X-Smith-Node': host.token } })).status).toBe(401);
    // The pull brought a new commit, so Smith re-reads smith.json from its copy before anything else.
    const rescan = await claim(f, host); expect(rescan.envelope.spec.kind).toBe('scan'); expect(rescan.envelope.spec.repos[0]).toMatchObject({ url: smithRemote(origin, 'soccer-boy'), hostedUuid: expect.any(String) });
    expect((await complete(f, host, rescan.envelope.lease, 'success', { commit: other, scan: { commit: other, branch: 'main', smithJson: null, paths: [], truncated: false } })).status).toBe(200);
    const again = await sync('pull'); expect(again.status).toBe(201);
    const second = await claim(f, host); expect(second.envelope.spec.kind).toBe('mirror');
    expect((await complete(f, host, second.envelope.lease, 'success', { commit: '2'.repeat(40) }, 'Pushed')).status).toBe(200);
    expect((await view()).hosted?.sync).toMatchObject({ status: 'failed', message: expect.stringContaining('not the pulled commit') });
  });
  // Build on push for a project that builds from Smith's copy. smith.json names `build` for pushes to main.
  const pushJson = JSON.stringify({ schemaVersion: 1, project: { id: 'soccer-boy', name: 'Soccer Boy' },
    buildProducts: [{ name: 'build', rules: [{ name: 'b', branches: ['*'], command: { linux: { interpreter: 'sh', script: 'Build.sh' } } }] }],
    triggers: [{ type: 'webhook', branches: ['main'], product: 'build' }] });
  type PushView = { push?: { enabled: boolean; via: string; pending: string | null; lastDelivery: { outcome: string; commit: string; jobIds: string[] } | null } };
  async function readSmithJson(f: Fixture, host: Node, at: string) {
    const scan = await claim(f, host); expect(scan.envelope.spec.kind).toBe('scan');
    expect((await complete(f, host, scan.envelope.lease, 'success', { commit: at, scan: { commit: at, branch: 'main', smithJson: pushJson, paths: ['Build.sh'], truncated: false } })).status).toBe(200);
  }
  const buildJobs = async (f: Fixture) => (await (await f.stub.execute(f.human, 'list', {})).json() as { jobs: { id: string; kind: string; product: string; state: string }[] }).jobs.filter(j => j.product === 'build');
  it('builds on a push to the linked repository by pulling it into the copy, reading smith.json there, then building', async () => {
    const f = await setup(); const { host, view } = await repoProject(f);
    const on = await (await f.stub.execute(f.human, 'push-builds', { projectId: 'soccer-boy', enabled: true })).json() as { secret?: string };
    const payload = JSON.stringify({ ref: 'refs/heads/main', before: commit, after: other, deleted: false, forced: false });
    const { signPayload } = await import('../src/push-builds');
    const delivered = await f.stub.execute({ kind: 'hook' }, 'push-delivery', { projectId: 'soccer-boy', event: 'push', deliveryId: 'd-1', signature: await signPayload(on.secret!, payload), payload });
    expect(delivered.status).toBe(202);
    expect(((await view()) as PushView).push).toMatchObject({ pending: 'pull', lastDelivery: { outcome: expect.stringContaining('pulling'), commit: other } });
    // The Pull runs and lands the pushed commit in the copy.
    const pull = await claim(f, host); expect(pull.envelope.spec.kind).toBe('mirror');
    const spec = pull.envelope.spec as Assignment['envelope']['spec'] & { mirror: { authToken: string } };
    const pushed = gitFetch('/git/soccer-boy.git/git-receive-pack', { method: 'POST', headers: { 'Content-Type': 'application/x-git-receive-pack-request', 'X-Smith-Node': host.token }, body: new Uint8Array([0x30, 0x30, 0x30, 0x30]), password: spec.mirror.authToken });
    await serve(f, host, new TextEncoder().encode('000eunpack ok\n0000'), { tips: [[other, 'refs/heads/main']], bytes: 101 });
    expect((await pushed).status).toBe(200);
    expect((await complete(f, host, pull.envelope.lease, 'success', { commit: other }, 'Pushed')).status).toBe(200);
    // Nobody linked GitHub here, so a machine reads smith.json at the pushed commit; the build follows.
    expect(((await view()) as PushView).push?.pending).toBe('scan');
    expect(await buildJobs(f)).toEqual([]);
    await readSmithJson(f, host, other);
    const builds = await buildJobs(f);
    expect(builds).toHaveLength(1);
    expect(((await view()) as PushView).push).toMatchObject({ pending: null, lastDelivery: { outcome: 'queued 1 build (build)', commit: other, jobIds: [builds[0].id] } });
  });
  it('builds on a push straight into Smith’s copy, with no webhook when nothing is linked', async () => {
    const f = await setup(); const { host, view, link } = await repoProject(f);
    expect((await link('')).status).toBe(200);   // detached: the copy is the only repository
    expect(await (await f.stub.execute(f.human, 'push-builds', { projectId: 'soccer-boy', enabled: true })).json()).toMatchObject({ project: { push: { enabled: true, via: 'smith' } } });
    expect(((await f.stub.execute(f.human, 'push-builds', { projectId: 'soccer-boy', enabled: true })).json() as Promise<{ secret?: string }>).then(r => r.secret)).resolves.toBeUndefined();
    const { token } = await f.pat();
    const pushed = gitFetch('/git/soccer-boy.git/git-receive-pack', { method: 'POST', headers: { 'Content-Type': 'application/x-git-receive-pack-request' }, body: new Uint8Array([0x30, 0x30, 0x30, 0x30]), username: cloneUsername(f.workspaceId), password: token });
    await serve(f, host, new TextEncoder().encode('000eunpack ok\n0000'), { tips: [[other, 'refs/heads/main']], bytes: 101 });
    expect((await pushed).status).toBe(200);
    expect(((await view()) as PushView).push).toMatchObject({ pending: 'scan', lastDelivery: { outcome: expect.stringContaining('pushed to Smith’s copy'), commit: other } });
    await readSmithJson(f, host, other);
    expect(await buildJobs(f)).toHaveLength(1);
    expect(((await view()) as PushView).push).toMatchObject({ pending: null, lastDelivery: { outcome: 'queued 1 build (build)' } });
  });
  it('pushes Smith’s copy to the linked repository from the machine’s own copy, and detaches', async () => {
    const f = await setup(); const { host, view, sync, link } = await repoProject(f);
    expect((await sync('push', 'push-1')).status).toBe(201);
    const assignment = await claim(f, host);
    const spec = assignment.envelope.spec as Assignment['envelope']['spec'] & { mirror: { remote: string; authToken: string } };
    expect(spec.repos[0]).toMatchObject({ url: smithRemote(origin, 'soccer-boy'), hostedUuid: expect.any(String), tip: commit });   // the machine holds the copy: no ticket needed
    expect(spec.mirror).toEqual({ remote: 'https://github.com/Red-Marmoset/soccer-boy.git', authToken: '', branch: 'main', pushTags: true });
    expect((await link('')).status).toBe(409);   // not while a push runs
    expect((await complete(f, host, assignment.envelope.lease, 'success', { commit }, 'Pushed')).status).toBe(200);
    expect((await view()).hosted?.sync).toMatchObject({ direction: 'push', status: 'done', commit });
    expect((await link('')).status).toBe(200);
    let shown = await view();
    expect(shown.hosted?.detachedFrom).toBe('https://github.com/Red-Marmoset/soccer-boy.git'); expect(shown.hosted?.sourceRepoUrl).toBe(smithRemote(origin, 'soccer-boy')); expect(shown.hosted?.sync).toBeUndefined();
    expect((await sync('pull')).status).toBe(409);   // not linked
    expect((await link(smithRemote(origin, 'soccer-boy'))).status).toBe(400);   // never Smith's own copy
    expect((await link('https://gitlab.com/a/b.git')).status).toBe(200);
    shown = await view(); expect(shown.hosted?.sourceRepoUrl).toBe('https://gitlab.com/a/b.git'); expect(shown.hosted?.detachedFrom).toBeUndefined();
  });
});

describe('a clone’s first requests are answered from the record', () => {
  const pkt = (...lines: string[]) => lines.map(l => l === '0000' || l === '0001' ? l : pktLine(l + '\n')).join('');
  const lsRefs = pkt('command=ls-refs', 'agent=git/2.43.0', 'object-format=sha1', '0001', 'peel', 'symrefs', 'ref-prefix HEAD', 'ref-prefix refs/heads/', 'ref-prefix refs/tags/', '0000');
  it('parses ls-refs requests and nothing else, and lists refs with HEAD, symrefs and peeled tags', () => {
    expect(parseLsRefs(new TextEncoder().encode(lsRefs))).toEqual({ peel: true, symrefs: true, unborn: false, prefixes: ['HEAD', 'refs/heads/', 'refs/tags/'] });
    expect(parseLsRefs(new TextEncoder().encode(pkt('command=ls-refs', '0001', '0000')))).toEqual({ peel: false, symrefs: false, unborn: false, prefixes: [] });
    expect(parseLsRefs(new TextEncoder().encode(pkt('command=fetch', 'agent=git/2.43.0', '0001', 'want ' + commit, '0000')))).toBeNull();
    expect(parseLsRefs(new TextEncoder().encode(pkt('command=ls-refs', '0001', '0000', 'command=ls-refs', '0001', '0000')))).toBeNull();   // two commands
    expect(parseLsRefs(new TextEncoder().encode(pkt('command=ls-refs', 'object-format=sha256', '0001', '0000')))).toBeNull();
    expect(parseLsRefs(new TextEncoder().encode(pkt('command=ls-refs', '0001', 'ref-prefix refs/he ads/', '0000')))).toBeNull();
    expect(parseLsRefs(new TextEncoder().encode('junk'))).toBeNull();
    const repo = { refs_json: JSON.stringify([[commit, 'refs/heads/master'], [other, 'refs/heads/wip'], ['3'.repeat(40), 'refs/tags/v1']]), peeled_json: JSON.stringify({ 'refs/tags/v1': '4'.repeat(40) }), default_branch: 'master' } as Parameters<typeof lsRefsLines>[0];
    expect(lsRefsLines(repo, { peel: true, symrefs: true, unborn: false, prefixes: ['HEAD', 'refs/heads/', 'refs/tags/'] })).toEqual([`${commit} HEAD symref-target:refs/heads/master`, `${commit} refs/heads/master`, `${other} refs/heads/wip`, `${'3'.repeat(40)} refs/tags/v1 peeled:${'4'.repeat(40)}`]);
    expect(lsRefsLines(repo, { peel: false, symrefs: false, unborn: false, prefixes: ['refs/tags/'] })).toEqual([`${'3'.repeat(40)} refs/tags/v1`]);
    expect(lsRefsLines({ ...repo, peeled_json: '{}' }, { peel: true, symrefs: false, unborn: false, prefixes: [] })).toBeNull();            // an older agent never reported peeled values
    expect(lsRefsLines({ ...repo, peeled_json: '{}' }, { peel: true, symrefs: false, unborn: false, prefixes: ['refs/heads/'] })).toHaveLength(2);   // no tags asked for
    expect(lsRefsLines({ ...repo, refs_json: '[]' }, { peel: false, symrefs: true, unborn: true, prefixes: [] })).toEqual(['unborn HEAD symref-target:refs/heads/master']);
    expect(v2Advertisement()).toMatch(/^000eversion 2\n/); expect(v2Advertisement()).toContain('ls-refs=unborn'); expect(v2Advertisement()).toMatch(/0000$/);
  });
  it('answers the v2 advertisement and ls-refs without a machine, and relays everything else', async () => {
    const f = await setup(); const { host } = await hosted(f);
    const { token } = await f.pat(['read']);
    const auth = { username: cloneUsername(f.workspaceId), password: token };
    // The advertisement: no poll ever sees a relay.
    const adv = await gitFetch('/git/senet.git/info/refs?service=git-upload-pack', { ...auth, headers: { 'Git-Protocol': 'version=2' } });
    expect(adv.status).toBe(200); expect(await adv.text()).toBe(v2Advertisement());
    expect(((await (await f.stub.execute(host, 'git-poll', {})).json()) as Poll).relay).toBeNull();
    // ls-refs with peel: the host job never reported peeled values, so it is relayed; after a push that does, it is answered here.
    const relayed = gitFetch('/git/senet.git/git-upload-pack', { ...auth, method: 'POST', headers: { 'Content-Type': 'application/x-git-upload-pack-request', 'Git-Protocol': 'version=2' }, body: lsRefs });
    const served = await serve(f, host, new TextEncoder().encode('0000'));
    expect(served.relay.op).toBe('rpc'); expect(new TextDecoder().decode(served.body!)).toBe(lsRefs); const relayedResponse = await relayed; expect([relayedResponse.status, await relayedResponse.clone().text()]).toEqual([200, expect.any(String)]);
    const { token: pushToken } = await f.pat();
    const push = gitFetch('/git/senet.git/git-receive-pack', { method: 'POST', headers: { 'Content-Type': 'application/x-git-receive-pack-request' }, body: new Uint8Array([0x30, 0x30, 0x30, 0x30]), username: cloneUsername(f.workspaceId), password: pushToken });
    await serve(f, host, new TextEncoder().encode('000eunpack ok\n0000'), { tips: newTips, peeled: { 'refs/tags/v1': '5'.repeat(40) }, bytes: 2 });
    expect((await push).status).toBe(200);
    const answered = await gitFetch('/git/senet.git/git-upload-pack', { ...auth, method: 'POST', headers: { 'Content-Type': 'application/x-git-upload-pack-request', 'Git-Protocol': 'version=2' }, body: lsRefs });
    expect([answered.status, answered.status === 200 ? '' : await answered.clone().text()]).toEqual([200, '']); expect(answered.headers.get('Content-Type')).toBe('application/x-git-upload-pack-result');
    expect(await answered.text()).toBe(pkt(`${other} HEAD symref-target:refs/heads/master`, `${other} refs/heads/master`, `${commit} refs/heads/wip`, `${other} refs/tags/v1 peeled:${'5'.repeat(40)}`, '0000'));
    expect(((await (await f.stub.execute(host, 'git-poll', {})).json()) as Poll).relay).toBeNull();
    // A fetch command, a v0 advertisement and a stranger's token still go the usual way.
    const fetch = gitFetch('/git/senet.git/git-upload-pack', { ...auth, method: 'POST', headers: { 'Content-Type': 'application/x-git-upload-pack-request', 'Git-Protocol': 'version=2' }, body: pkt('command=fetch', '0001', 'want ' + other, 'done', '0000') });
    const fetched = await serve(f, host, new TextEncoder().encode('0008NAK\n'));
    expect(new TextDecoder().decode(fetched.body!)).toContain('command=fetch'); const fetchResponse = await fetch; expect([fetchResponse.status, await fetchResponse.clone().text()]).toEqual([200, expect.any(String)]);
    const v0 = gitFetch('/git/senet.git/info/refs?service=git-upload-pack', auth);
    const advertised = await serve(f, host, new TextEncoder().encode('0000'));
    expect(advertised.relay.op).toBe('info-refs'); expect((await v0).status).toBe(200);
    expect((await gitFetch('/git/senet.git/info/refs?service=git-upload-pack', { username: cloneUsername(f.workspaceId), password: 'smith_pat_' + f.workspaceId + '_nope', headers: { 'Git-Protocol': 'version=2' } })).status).toBe(401);
  });
});

describe('an Artifacts home in the record', () => {
  it('records an Artifacts home: importing, then ready with tips, and never hands a writer a server', async () => {
    const f = await setup();
    await runInDurableObject(f.stub, async (_instance, state) => {
      const { HostedGit } = await import('../src/git-host');
      const git = new HostedGit(state.storage.sql, f.workspaceId, origin);
      const started = git.startArtifactsHome('senet', 'u-1', 'https://x.artifacts.cloudflare.net/git/default/ws-senet.git', '', 1000);
      expect([started.state, started.primary_node_id, started.generation]).toEqual(['importing', null, 0]);
      const digest = await tipsDigest(tips);
      const ready = git.artifactsReady('senet', tips, digest, {}, 'master', 123, 2000);
      expect([ready.state, ready.generation, ready.default_branch, ready.bytes, JSON.parse(ready.refs_json)]).toEqual(['artifacts', 1, 'master', 123, tips]);
      expect(git.servers(ready, [], 2000, 60000, true)).toEqual([]);
      const moved: [string, string][] = [[other, 'refs/heads/master'], [other, 'refs/tags/v1']];
      const adopted = git.adoptArtifactsTips(ready, moved, await tipsDigest(moved), {}, 3000);
      expect(adopted.changed).toBe(true);
      expect(git.repo('senet')!.generation).toBe(2);
      expect(git.adoptArtifactsTips(git.repo('senet')!, moved, await tipsDigest(moved), {}, 4000).changed).toBe(false);
    });
  });
});
