import { fail, fields, hash, json, randomToken, readBody, string } from './http';
import { handleOAuth, identitiesFor } from './oauth';
import { parsePreferences, validateProfile, type AccountProfile } from './settings';

const COOKIE = '__Host-smith-session';
const LIFETIME_SECONDS = 7 * 24 * 60 * 60;
type Session = { user_id: string; csrf_token: string | null };

function sameOrigin(request: Request, env: Env): void {
  if (request.headers.get('Origin') !== env.ORIGIN) fail(403, 'origin', 'Origin not permitted');
}

function credential(request: Request): { token: string; browser: boolean } {
  // An explicit invalid Authorization header must never fall back to a cookie.
  if (request.headers.has('Authorization')) {
    const header = request.headers.get('Authorization')!;
    const token = /^Bearer ([^\s]{1,256})$/.exec(header)?.[1];
    if (!token) fail(401, 'unauthenticated', 'A current user session is required');
    return { token, browser: false };
  }
  const values = (request.headers.get('Cookie') ?? '').split(';')
    .map(value => value.trim()).filter(value => value.startsWith(COOKIE + '='));
  if (values.length !== 1) fail(401, 'unauthenticated', 'Sign in to continue');
  const token = values[0].slice(COOKIE.length + 1);
  if (!/^[a-zA-Z0-9-]{1,256}$/.test(token)) fail(401, 'unauthenticated', 'Sign in to continue');
  return { token, browser: true };
}

async function currentSession(request: Request, env: Env) {
  const { token, browser } = credential(request);
  const tokenHash = await hash(token);
  const session = await env.DB.prepare('SELECT sessions.user_id, sessions.csrf_token FROM sessions JOIN users ON users.id = sessions.user_id WHERE token_hash = ? AND expires_at > ?')
    .bind(tokenHash, Date.now()).first<Session>();
  if (!session) fail(401, 'unauthenticated', 'Your session has expired. Sign in with a new invitation code.');
  if (browser && !['GET', 'HEAD'].includes(request.method)) {
    sameOrigin(request, env);
    const supplied = request.headers.get('X-Smith-CSRF');
    if (!session.csrf_token || !supplied || supplied.length > 256) fail(403, 'csrf', 'Refresh this page before trying again');
    const expectedBytes = new TextEncoder().encode(await hash(session.csrf_token));
    const suppliedBytes = new TextEncoder().encode(await hash(supplied));
    if (!crypto.subtle.timingSafeEqual(expectedBytes, suppliedBytes)) fail(403, 'csrf', 'Refresh this page before trying again');
  }
  return { ...session, tokenHash, browser };
}

export async function authenticateHuman(request: Request, env: Env): Promise<{ kind: 'human'; userId: string }> {
  const session = await currentSession(request, env);
  return { kind: 'human', userId: session.user_id };
}

type ProfileRow = { display_name: string; email: string; preferences: string };
async function profile(env: Env, userId: string): Promise<AccountProfile> {
  let row: ProfileRow | null = null;
  try { row = await env.DB.prepare('SELECT display_name, email, preferences FROM users WHERE id = ?').bind(userId).first<ProfileRow>(); }
  catch (error) { if (!String(error).includes('no such column')) throw error; }   // migration 0005 not applied yet: defaults
  return { displayName: row?.display_name ?? '', email: row?.email ?? '', preferences: parsePreferences(row?.preferences) };
}
function identity(csrfToken: string | null, account: AccountProfile, identities: { provider: string; email: string | null; login: string | null }[] = []) {
  return { user: { label: account.displayName || 'Experiment workspace', ...account }, csrfToken, identities };
}
function sessionCookie(token: string): string { return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${LIFETIME_SECONDS}`; }
// A new browser session for a user who just proved who they are (used by external sign-in).
async function startSession(env: Env, userId: string): Promise<string> {
  const token = randomToken();
  await env.DB.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, csrf_token) VALUES (?, ?, ?, ?)')
    .bind(await hash(token), userId, Date.now() + LIFETIME_SECONDS * 1000, randomToken()).run();
  return sessionCookie(token);
}

export async function handleAuth(request: Request, env: Env): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (!path.startsWith('/auth/')) return null;
  if (request.headers.has('Origin')) sameOrigin(request, env);

  if (path === '/auth/invite' && request.method === 'POST') {
    sameOrigin(request, env);
    const body = await readBody(request); fields(body, ['code']);
    const code = string(body, 'code', 256);
    if (!/^[a-zA-Z0-9_-]{32,256}$/.test(code)) fail(401, 'invalid_invite', 'Invitation code is invalid, expired, or already used');
    const inviteHash = await hash(code);
    const token = randomToken(); const tokenHash = await hash(token);
    const csrfToken = randomToken(); const now = Date.now();
    // D1 batches are transactions: insertion and consumption cannot interleave with a second exchange.
    const result = await env.DB.batch([
      env.DB.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, csrf_token) SELECT ?, user_id, ?, ? FROM invites WHERE token_hash = ? AND expires_at > ?')
        .bind(tokenHash, now + LIFETIME_SECONDS * 1000, csrfToken, inviteHash, now),
      env.DB.prepare('DELETE FROM invites WHERE token_hash = ?').bind(inviteHash),
    ]);
    if (result[0].meta.changes !== 1) fail(401, 'invalid_invite', 'Invitation code is invalid, expired, or already used');
    const owner = await env.DB.prepare('SELECT user_id FROM sessions WHERE token_hash = ?').bind(tokenHash).first<{ user_id: string }>();
    const response = json(identity(csrfToken, await profile(env, owner!.user_id), await identitiesFor(env, owner!.user_id)));
    response.headers.set('Set-Cookie', sessionCookie(token));
    return response;
  }
  if (path === '/auth/me' && request.method === 'GET') {
    const session = await currentSession(request, env);
    if (session.browser && !session.csrf_token) {
      await env.DB.prepare('UPDATE sessions SET csrf_token = ? WHERE token_hash = ? AND csrf_token IS NULL')
        .bind(randomToken(), session.tokenHash).run();
      const refreshed = await env.DB.prepare('SELECT csrf_token FROM sessions WHERE token_hash = ? AND expires_at > ?')
        .bind(session.tokenHash, Date.now()).first<{ csrf_token: string }>();
      if (!refreshed) fail(401, 'unauthenticated', 'Sign in to continue');
      session.csrf_token = refreshed.csrf_token;
    }
    return json(identity(session.csrf_token, await profile(env, session.user_id), await identitiesFor(env, session.user_id)));
  }
  if (path === '/auth/profile' && request.method === 'POST') {
    // Account settings: display name, e-mail and display preferences. Per user, not per workspace.
    const session = await currentSession(request, env);
    const next = validateProfile(await readBody(request), await profile(env, session.user_id));
    await env.DB.prepare('UPDATE users SET display_name = ?, email = ?, preferences = ? WHERE id = ?')
      .bind(next.displayName, next.email, JSON.stringify(next.preferences), session.user_id).run();
    return json(identity(session.csrf_token, next, await identitiesFor(env, session.user_id)));
  }
  if (path === '/auth/logout' && request.method === 'POST') {
    const session = await currentSession(request, env);
    fields(await readBody(request), []);
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(session.tokenHash).run();
    const response = json({ signedOut: true });
    response.headers.set('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
    return response;
  }
  const oauth = await handleOAuth(request, env, path, async () => ({ userId: (await currentSession(request, env)).user_id }), userId => startSession(env, userId));
  if (oauth) return oauth;
  fail(404, 'not_found', 'Route not found');
}
