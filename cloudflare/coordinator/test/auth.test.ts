import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { authenticateHuman, handleAuth } from '../src/auth';
import { errorResponse, hash } from '../src/http';
import schema from '../migrations/0001_identity.sql?raw';
import browserSchema from '../migrations/0002_browser_auth.sql?raw';
import profileSchema from '../migrations/0005_account_profile.sql?raw';

const origin = 'https://exp.redmarmosetstudios.com';
beforeAll(async () => { await env.DB.exec(schema); await env.DB.exec(browserSchema); await env.DB.exec(profileSchema); });

function request(path: string, body?: unknown, headers: Record<string, string> = {}) {
  return new Request(origin + path, { method: body === undefined ? 'GET' : 'POST',
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json', Origin: origin }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body) });
}
async function call(input: Request) {
  try { return (await handleAuth(input, env))!; } catch (error) { return errorResponse(error); }
}
async function invite(expiresAt = Date.now() + 60000) {
  const userId = crypto.randomUUID(); const code = crypto.randomUUID() + crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO users (id, created_at) VALUES (?, ?)').bind(userId, Date.now()),
    env.DB.prepare('INSERT INTO invites (token_hash, user_id, expires_at) VALUES (?, ?, ?)').bind(await hash(code), userId, expiresAt),
  ]);
  return { userId, code };
}
async function signIn() {
  const person = await invite(); const response = await call(request('/auth/invite', { code: person.code }));
  expect(response.status).toBe(200);
  const cookie = response.headers.get('Set-Cookie')!.split(';')[0];
  const body = await response.json() as { csrfToken: string };
  return { ...person, cookie, csrfToken: body.csrfToken };
}

describe('browser invitation and sessions', () => {
  it('exchanges an invitation only once under concurrent requests and stores only credential hashes', async () => {
    const person = await invite();
    const responses = await Promise.all([call(request('/auth/invite', { code: person.code })), call(request('/auth/invite', { code: person.code }))]);
    expect(responses.map(response => response.status).sort()).toEqual([200, 401]);
    const cookie = responses.find(response => response.status === 200)!.headers.get('Set-Cookie')!;
    expect(cookie).toMatch(/^__Host-smith-session=/);
    for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/', 'Max-Age=604800']) expect(cookie).toContain(flag);
    const stored = await env.DB.prepare('SELECT token_hash, expires_at FROM sessions WHERE user_id = ?').bind(person.userId).all();
    expect(stored.results).toHaveLength(1);
    expect(JSON.stringify(stored.results)).not.toContain(cookie.split(';')[0].split('=')[1]);
    expect(await env.DB.prepare('SELECT * FROM invites WHERE token_hash = ?').bind(await hash(person.code)).first()).toBeNull();
    expect((await call(request('/auth/invite', { code: person.code }))).status).toBe(401);
  });
  it('rejects expired and unknown invitations without creating sessions', async () => {
    const person = await invite(Date.now() - 1);
    expect((await call(request('/auth/invite', { code: person.code }))).status).toBe(401);
    expect((await call(request('/auth/invite', { code: crypto.randomUUID() }))).status).toBe(401);
    expect((await env.DB.prepare('SELECT * FROM sessions WHERE user_id = ?').bind(person.userId).all()).results).toHaveLength(0);
  });
  it('requires origin on invitation exchange and bounds and validates JSON', async () => {
    const person = await invite();
    expect((await call(request('/auth/invite', { code: person.code }, { Origin: 'https://other.example' }))).status).toBe(403);
    const missing = request('/auth/invite', { code: person.code }); missing.headers.delete('Origin');
    expect((await call(missing)).status).toBe(403);
    expect((await call(request('/auth/invite', { code: person.code, userId: 'fake' }))).status).toBe(400);
    expect((await call(request('/auth/invite', { code: 'x'.repeat(70000) }))).status).toBe(413);
  });
  it('requires cookie mutation CSRF and exact origin, never falls back from invalid bearer', async () => {
    const person = await signIn(); const headers = { Cookie: person.cookie, 'X-Smith-CSRF': person.csrfToken };
    expect(await authenticateHuman(request('/api/v2/workspaces', {}, headers), env)).toEqual({ kind: 'human', userId: person.userId });
    await expect(authenticateHuman(request('/api/v2/workspaces', {}, { Cookie: person.cookie }), env)).rejects.toMatchObject({ status: 403 });
    await expect(authenticateHuman(request('/api/v2/workspaces', {}, { ...headers, 'X-Smith-CSRF': 'wrong' }), env)).rejects.toMatchObject({ status: 403 });
    await expect(authenticateHuman(request('/api/v2/workspaces', {}, { ...headers, Origin: 'https://other.example' }), env)).rejects.toMatchObject({ status: 403 });
    const missing = request('/api/v2/workspaces', {}, headers); missing.headers.delete('Origin');
    await expect(authenticateHuman(missing, env)).rejects.toMatchObject({ status: 403 });
    for (const Authorization of ['', 'Basic abc', 'Bearer wrong']) {
      await expect(authenticateHuman(request('/api/v2/workspaces', undefined, { ...headers, Authorization }), env)).rejects.toMatchObject({ status: 401 });
    }
    const me = await call(request('/auth/me', undefined, { Cookie: person.cookie }));
    expect(await me.json()).toMatchObject({ user: { label: 'Experiment workspace', displayName: '', email: '' }, csrfToken: person.csrfToken, identities: [] });
  });
  it('revokes the session immediately on sign-out and rejects expired sessions', async () => {
    const person = await signIn();
    const response = await call(request('/auth/logout', {}, { Cookie: person.cookie, 'X-Smith-CSRF': person.csrfToken }));
    expect(response.status).toBe(200); expect(response.headers.get('Set-Cookie')).toContain('Max-Age=0');
    expect((await call(request('/auth/me', undefined, { Cookie: person.cookie }))).status).toBe(401);
    const expired = await signIn();
    await env.DB.prepare('UPDATE sessions SET expires_at = ? WHERE user_id = ?').bind(Date.now() - 1, expired.userId).run();
    expect((await call(request('/auth/me', undefined, { Cookie: expired.cookie }))).status).toBe(401);
  });
  it('keeps seeded bearer sessions usable and lazily initializes stable browser CSRF', async () => {
    const person = await invite(); const token = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').bind(await hash(token), person.userId, Date.now() + 60000).run();
    const bearer = request('/api/v2/workspaces', {}, { Authorization: `Bearer ${token}` }); bearer.headers.delete('Origin');
    expect(await authenticateHuman(bearer, env)).toEqual({ kind: 'human', userId: person.userId });
    const headers = { Cookie: `__Host-smith-session=${token}` };
    const a = await (await call(request('/auth/me', undefined, headers))).json() as { csrfToken: string };
    const b = await (await call(request('/auth/me', undefined, headers))).json() as { csrfToken: string };
    expect(a.csrfToken.length).toBeGreaterThan(32); expect(a.csrfToken).toBe(b.csrfToken);
  });
});
