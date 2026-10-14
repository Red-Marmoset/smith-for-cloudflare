import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { beforeAll, describe, it, expect } from 'vitest';
import worker from '../src/index';
import { hash } from '../src/http';
import identity from '../migrations/0001_identity.sql?raw';
import browser from '../migrations/0002_browser_auth.sql?raw';
import directory from '../migrations/0003_workspace_directory.sql?raw';
import profile from '../migrations/0005_account_profile.sql?raw';

describe('hosted coordinator boundary', () => {
  it('reports the deployed runtime without revealing credentials', async () => {
    const response = await worker.fetch(new Request('https://exp.redmarmosetstudios.com/health'), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ service: 'smith', runtime: 'cloudflare-workers', protocolVersion: 2, version: 'development', sourceCommit: 'development' });
  });
  it('serves pages with a strict CSP and forbids edge script injection', async () => {
    const response = await worker.fetch(new Request('https://exp.redmarmosetstudios.com/?signin_error=provider_error'), env);
    const csp = response.headers.get('Content-Security-Policy') ?? '';
    expect(csp).toContain("script-src 'self';");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain('report-to csp');
    expect(response.headers.get('Reporting-Endpoints')).toBe('csp="https://exp.redmarmosetstudios.com/csp-report"');
    expect(response.headers.get('Cache-Control')).toContain('no-transform');
  });
  it('sends the baseline security headers on API and error responses too', async () => {
    for (const path of ['/health', '/api/v2/workspaces/a/jobs', '/auth/me']) {
      const response = await worker.fetch(new Request('https://exp.redmarmosetstudios.com' + path), env);
      expect(response.headers.get('Strict-Transport-Security')).toBe('max-age=31536000; includeSubDomains');
      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(response.headers.get('Cross-Origin-Opener-Policy')).toBe('same-origin');
      expect(response.headers.get('Cross-Origin-Resource-Policy')).toBe('same-origin');
      expect(response.headers.get('Permissions-Policy')).toContain('camera=()');
      expect(response.headers.has('Content-Security-Policy')).toBe(false);
    }
  });
  it('accepts CSP violation reports without echoing them', async () => {
    const report = [{ type: 'csp-violation', body: { effectiveDirective: 'script-src-elem', blockedURL: 'https://static.cloudflareinsights.com/beacon.min.js', documentURL: 'https://exp.redmarmosetstudios.com/?x=1' } }];
    const response = await worker.fetch(new Request('https://exp.redmarmosetstudios.com/csp-report', { method: 'POST', headers: { 'Content-Type': 'application/reports+json' }, body: JSON.stringify(report) }), env);
    expect(response.status).toBe(204);
    const junk = await worker.fetch(new Request('https://exp.redmarmosetstudios.com/csp-report', { method: 'POST', body: 'x'.repeat(20000) }), env);
    expect(junk.status).toBe(204);
    expect((await worker.fetch(new Request('https://exp.redmarmosetstudios.com/csp-report'), env)).status).toBe(405);
  });
  it('rejects anonymous workspace access', async () => {
    const response = await worker.fetch(new Request('https://exp.redmarmosetstudios.com/api/v2/workspaces/a/jobs'), env);
    expect(response.status).toBe(401);
  });
});

const origin = 'https://exp.redmarmosetstudios.com';
beforeAll(async () => { for (const schema of [identity, browser, directory, profile]) await env.DB.exec(schema); });

// A person signed in through an invitation: the cookie and CSRF token the dashboard would hold.
async function signIn(who: { displayName?: string; email?: string } = {}) {
  const userId = crypto.randomUUID(); const code = crypto.randomUUID() + crypto.randomUUID();
  await env.DB.batch([env.DB.prepare('INSERT INTO users (id, created_at, display_name, email) VALUES (?, ?, ?, ?)').bind(userId, Date.now(), who.displayName ?? '', who.email ?? ''),
    env.DB.prepare('INSERT INTO invites VALUES (?, ?, ?)').bind(await hash(code), userId, Date.now() + 60000)]);
  const login = await worker.fetch(new Request(origin + '/auth/invite', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ code }) }), env);
  const { csrfToken } = await login.json() as { csrfToken: string };
  const cookie = login.headers.get('Set-Cookie')!.split(';')[0];
  const get = (path: string) => worker.fetch(new Request(origin + path, { headers: { Cookie: cookie } }), env);
  const post = (path: string, body: unknown = {}) => worker.fetch(new Request(origin + path, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookie, 'X-Smith-CSRF': csrfToken }, body: JSON.stringify(body) }), env);
  return { userId, get, post };
}
type Person = Awaited<ReturnType<typeof signIn>>;
async function workspaceOf(person: Person) {
  const created = await person.post('/api/v2/workspaces', { requestId: crypto.randomUUID() });
  expect(created.status).toBe(201);
  return `/api/v2/workspaces/${(await created.json() as { workspaceId: string }).workspaceId}`;
}

describe('workspace creation', () => {
  it('returns the new workspace ID to the dashboard', async () => {
    const created = await (await signIn()).post('/api/v2/workspaces', { requestId: 'first' });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ workspaceId: expect.stringMatching(/^[a-f0-9]{64}$/) });
  });
});

describe('machine list order', () => {
  it('lists machines by name, so a heartbeat never moves one under the mouse', async () => {
    const owner = await signIn(); const base = await workspaceOf(owner);
    const stub = env.WORKSPACES.getByName(base.split('/').pop()!);
    const human = { kind: 'human' as const, userId: owner.userId };
    for (const hostname of ['zeta', 'Alpha', 'mid']) {
      const { code } = await (await stub.execute(human, 'enrollments', { purpose: 'build' })).json() as { code: string };
      expect((await stub.execute({ kind: 'enrollment' }, 'enroll', { code, protocolVersion: 2, os: 'linux', hostname, labels: [] })).status).toBe(201);
    }
    const names = async () => ((await (await owner.get(base + '/nodes')).json()) as { nodes: { hostname: string }[] }).nodes.map(n => n.hostname);
    expect(await names()).toEqual(['Alpha', 'mid', 'zeta']);
    await runInDurableObject(stub, (_o, state) => { state.storage.sql.exec("UPDATE nodes SET last_seen_at = ? WHERE hostname = 'zeta'", Date.now() + 60000); });
    expect(await names()).toEqual(['Alpha', 'mid', 'zeta']);
  });
});

describe('guest chat names', () => {
  it('names the guests chatting on your machine from the identity database', async () => {
    const owner = await signIn(); const guest = await signIn({ displayName: 'Gail', email: 'gail@example.com' });
    const base = await workspaceOf(owner);
    const stub = env.WORKSPACES.getByName(base.split('/').pop()!);
    const human = (userId: string) => ({ kind: 'human' as const, userId });
    await runInDurableObject(stub, (_o, state) => { state.storage.sql.exec('INSERT INTO members (user_id, role) VALUES (?, ?)', guest.userId, 'operator'); });
    expect((await owner.post(base + '/projects', { id: 'smith', name: 'Smith', repoUrl: 'https://github.com/Red-Marmoset/smith.git', branch: 'main', commit: 'd45d5d166ff384710a2f63cfa24271395b689c41',
      products: [{ name: 'build', description: 'Build', labels: [], timeoutSeconds: 1800, commands: { windows: { interpreter: 'ps1', script: 'Build.ps1', args: [] } } }] })).status).toBe(201);
    const { code } = await (await stub.execute(human(owner.userId), 'enrollments', { purpose: 'personal' })).json() as { code: string };
    const ai = { tools: [{ id: 'claude-code', version: '2.1.4' }], ollama: { up: true, models: [{ name: 'qwen3.5:9b', sizeBytes: 1, remote: false }] }, features: ['ask', 'push', 'ollama'] };
    const enrolled = await stub.execute({ kind: 'enrollment' }, 'enroll', { code, protocolVersion: 2, os: 'windows', hostname: 'pc', labels: [], ai });
    const { nodeId } = await enrolled.json() as { nodeId: string };
    expect((await stub.execute(human(owner.userId), 'ai-share', { nodeId, share: true })).status).toBe(200);
    expect((await stub.execute(human(guest.userId), 'ai-session-create', { requestId: crypto.randomUUID(), nodeId, projectId: 'smith', tool: 'claude-code', brain: 'ollama', model: 'qwen3.5:9b', permissionMode: 'plan', prompt: 'Hello' })).status).toBe(201);
    const nodes = await (await owner.get(base + '/nodes')).json() as { nodes: { guestChats?: { userId: string; by: string }[] }[] };
    expect(nodes.nodes.flatMap(n => n.guestChats ?? [])).toMatchObject([{ userId: guest.userId, by: 'Gail' }]);
    await env.DB.prepare('UPDATE users SET display_name = ?, email = ? WHERE id = ?').bind('', '', guest.userId).run();
    expect((await (await owner.get(base + '/nodes')).json() as typeof nodes).nodes.flatMap(n => n.guestChats ?? [])).toMatchObject([{ by: 'A workspace member' }]);
  });
});

describe('crew routes', () => {
  const smith = { id: 'smith', name: 'Smith', repoUrl: 'https://github.com/Red-Marmoset/smith.git', branch: 'main', commit: 'd45d5d166ff384710a2f63cfa24271395b689c41',
    products: [{ name: 'build', description: 'Build', labels: [], timeoutSeconds: 1800, commands: { windows: { interpreter: 'ps1', script: 'Build.ps1', args: [] } } }] };
  const member = { name: 'Standards', enabled: false, charter: 'Enforce CLAUDE.md on recent commits', projectIds: ['smith'], brain: 'api-key', permissionMode: 'acceptEdits', trigger: { kind: 'manual' } };
  async function crewOf(who: Person) {
    const base = await workspaceOf(who);
    expect((await who.post(base + '/projects', smith)).status).toBe(201);
    const created = await who.post(base + '/crew', member);
    expect(created.status, await created.clone().text()).toBe(201);
    return { base, crewId: (await created.json() as { id: string }).id };
  }

  it('lists an empty crew, with the names of nobody', async () => {
    const owner = await signIn();
    const response = await owner.get(await workspaceOf(owner) + '/crew');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ members: [], names: {} });
  });
  it('answers 404 for a member ID that is not a UUID, and refuses anonymous callers', async () => {
    const owner = await signIn();
    const base = await workspaceOf(owner);
    expect((await owner.post(base + '/crew/not-a-uuid/run', { requestId: 'r' })).status).toBe(404);
    expect((await owner.get(base + '/crew/not-a-uuid/runs')).status).toBe(404);
    expect((await worker.fetch(new Request(origin + base + '/crew'), env)).status).toBe(401);
  });
  it('names the people a crew answer mentions: display name, else email, else a generic member', async () => {
    const owner = await signIn({ displayName: 'Sem', email: 'sem@example.com' });
    const { base, crewId } = await crewOf(owner);
    const names = async (path: string) => (await (await owner.get(base + path)).json() as { names: Record<string, string> }).names;
    expect(await names('/crew')).toEqual({ [owner.userId]: 'Sem' });
    expect(await names(`/crew/${crewId}/runs`)).toEqual({});
    await env.DB.prepare('UPDATE users SET display_name = ? WHERE id = ?').bind('', owner.userId).run();
    expect(await names('/crew')).toEqual({ [owner.userId]: 'sem@example.com' });
    await env.DB.prepare('UPDATE users SET email = ? WHERE id = ?').bind('', owner.userId).run();
    expect(await names('/crew')).toEqual({ [owner.userId]: 'A workspace member' });
  });
  it('names the person who wrote a crew message on the message itself, and deletes one through its route', async () => {
    const owner = await signIn({ displayName: 'Sem' });
    const { base, crewId } = await crewOf(owner);
    const sent = await owner.post(base + '/crew/messages', { to: crewId, body: 'Look at Agent.cpp' });
    expect(sent.status).toBe(201);
    const { seq } = await sent.json() as { seq: number };
    expect(await (await owner.get(base + '/crew/messages')).json()).toEqual({ messages: [{ seq, from: { userId: owner.userId, name: 'Sem' }, to: crewId, body: 'Look at Agent.cpp', sessionId: null,
      createdAt: expect.any(Number) }], names: { [owner.userId]: 'Sem' } });
    expect((await (await owner.get(base + `/crew/messages?after=${seq}`)).json() as { messages: unknown[] }).messages).toEqual([]);
    expect((await owner.post(base + `/crew/messages/${seq}/delete`, { seq })).status).toBe(400);
    expect(await (await owner.post(base + `/crew/messages/${seq}/delete`)).json()).toEqual({ deleted: true });
    expect(await (await owner.get(base + '/crew/messages')).json()).toEqual({ messages: [], names: {} });
  });
  it('reaches every crew action the Durable Object answers', async () => {
    const owner = await signIn();
    const { base, crewId } = await crewOf(owner);
    const read = async (path: string) => { const r = await owner.get(base + path); expect(r.status, path).toBe(200); return await r.json() as Record<string, unknown>; };
    expect((await read('/crew')).members).toMatchObject([{ id: crewId, name: 'Standards', enabled: false }]);
    expect(await read(`/crew/${crewId}/runs`)).toEqual({ runs: [], names: {} });
    expect(await read(`/crew/${crewId}/prompt`)).toMatchObject({ system: expect.stringContaining('Enforce CLAUDE.md') });
    expect(await read('/crew/review')).toEqual({ proposals: [], names: {} });
    expect(await read('/crew/messages')).toEqual({ messages: [], names: {} });
    const edited = await owner.post(base + '/crew', { ...member, id: crewId, name: 'Standards Two' });
    expect(edited.status).toBe(200);
    expect(await edited.json()).toMatchObject({ id: crewId, name: 'Standards Two' });
    // The body reaches the Durable Object, and the member in the path is the one acted on, whatever the body says.
    expect(await (await owner.post(base + `/crew/${crewId}/enable`, { enabled: true })).json()).toMatchObject({ id: crewId, enabled: true });
    const enabled = await owner.post(base + `/crew/${crewId}/enable`, { enabled: false, crewId: crypto.randomUUID() });
    expect(enabled.status).toBe(200);
    expect(await enabled.json()).toMatchObject({ id: crewId, enabled: false });
    expect((await owner.post(base + `/crew/${crewId}/delete`, { crewId })).status).toBe(400);   // a delete carries no fields
    expect(await (await owner.post(base + `/crew/${crewId}/delete`)).json()).toEqual({ deleted: true });
    expect((await read('/crew')).members).toEqual([]);
    // A run answers through its session: an unknown one is that session's 404, not the route's.
    const sessionId = crypto.randomUUID();
    for (const response of [await owner.get(base + `/crew/runs/${sessionId}`), await owner.get(base + `/crew/runs/${sessionId}/events?after=3`), await owner.post(base + `/crew/runs/${sessionId}/stop`)]) {
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: { code: 'not_found', message: 'Session not found' } });
    }
  });
});
