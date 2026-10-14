import { env } from 'cloudflare:workers';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { hash } from '../src/http';
import identity from '../migrations/0001_identity.sql?raw';
import browser from '../migrations/0002_browser_auth.sql?raw';
import directory from '../migrations/0003_workspace_directory.sql?raw';
import external from '../migrations/0004_external_identities.sql?raw';
import profile from '../migrations/0005_account_profile.sql?raw';
import providerTokens from '../migrations/0006_provider_tokens.sql?raw';
import studio from '../migrations/0007_studio_access.sql?raw';
import { githubTokenFor } from '../src/oauth';

const origin = 'https://exp.redmarmosetstudios.com';
const configured = { ...env, GOOGLE_CLIENT_ID: 'google-client', GOOGLE_CLIENT_SECRET: 'google-secret', GITHUB_CLIENT_ID: 'github-client', GITHUB_CLIENT_SECRET: 'github-secret' } as Env;
// D1's exec runs one statement per line and rejects comment-only lines (wrangler's migration runner does not).
beforeAll(async () => { for (const schema of [identity, browser, directory, external, profile, providerTokens, studio]) await env.DB.exec(schema.split('\n').filter(line => line.trim() && !line.trim().startsWith('--')).join('\n')); });
afterEach(() => vi.restoreAllMocks());

const b64 = (value: unknown) => btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
type Provider = 'google' | 'github';
// What the fake provider will say about the person who signs in next.
let googleClaims: (nonce: string) => Record<string, unknown>;
let githubUser = { id: 4242, login: 'sem' };
let tokenRequests: URLSearchParams[] = [];
function fakeProviders(options: { tokenStatus?: number; tokenError?: string; expiring?: boolean } = {}) {
  tokenRequests = [];
  let lastNonce = '';
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    // Build a real Request first so the fake rejects the same options real fetch does: the Workers
    // runtime throws on redirect: 'error', which once broke every live sign-in while these tests passed.
    new Request(input, init);
    const url = String(input instanceof Request ? input.url : input);
    if (url === 'https://oauth2.googleapis.com/token' || url === 'https://github.com/login/oauth/access_token') {
      const body = new URLSearchParams(String(init?.body)); tokenRequests.push(body);
      if (options.tokenStatus) return Response.json(options.tokenError === '' ? {} : { error: options.tokenError ?? 'invalid_grant' }, { status: options.tokenStatus });
      if (url.includes('google')) return Response.json({ id_token: `${b64({ alg: 'RS256' })}.${b64(googleClaims(lastNonce))}.sig`, access_token: 'g' });
      if (body.get('grant_type') === 'refresh_token') return Response.json(body.get('refresh_token') === 'gh-refresh' ? { access_token: 'gh-token-2', refresh_token: 'gh-refresh-2', expires_in: 28800 } : { error: 'bad_refresh_token' }, { status: body.get('refresh_token') === 'gh-refresh' ? 200 : 400 });
      return Response.json(options.expiring ? { access_token: 'gh-token', refresh_token: 'gh-refresh', expires_in: 28800 } : { access_token: 'gh-token' });
    }
    if (url === 'https://api.github.com/user') return Response.json(githubUser);
    if (url === 'https://api.github.com/user/emails') return Response.json([{ email: 'sem@example.com', primary: true, verified: true }]);
    if (url.startsWith('nonce:')) { lastNonce = url.slice(6); return new Response(); }
    throw new Error(`Unexpected fetch ${url}`);
  });
  return { rememberNonce: (nonce: string) => { lastNonce = nonce; } };
}
const call = (path: string, init: RequestInit = {}, environment = configured) => worker.fetch(new Request(origin + path, { redirect: 'manual', ...init }), environment);
const cookieOf = (response: Response, name: string) => response.headers.getSetCookie().find(c => c.startsWith(name + '='))?.split(';')[0] ?? '';

async function invitedSession() {
  const userId = crypto.randomUUID(); const code = crypto.randomUUID() + crypto.randomUUID();
  await env.DB.batch([env.DB.prepare('INSERT INTO users (id, created_at) VALUES (?, ?)').bind(userId, Date.now()), env.DB.prepare('INSERT INTO invites VALUES (?, ?, ?)').bind(await hash(code), userId, Date.now() + 60000)]);
  const response = await call('/auth/invite', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ code }) });
  return { userId, cookie: cookieOf(response, '__Host-smith-session'), csrf: (await response.json() as { csrfToken: string }).csrfToken };
}
// Runs the provider round trip: Smith -> provider -> Smith callback. `start` is the provider URL.
async function finish(provider: Provider, start: string, stateCookie: string, fake: { rememberNonce(n: string): void }, query: Record<string, string> = {}) {
  const authorize = new URL(start);
  fake.rememberNonce(authorize.searchParams.get('nonce') ?? '');
  const params = new URLSearchParams({ code: 'provider-code', state: authorize.searchParams.get('state')!, ...query });
  const response = await call(`/auth/callback/${provider}?${params}`, { headers: { Cookie: stateCookie } });
  expect(response.status).toBe(302);
  return { location: new URL(response.headers.get('Location')!), session: cookieOf(response, '__Host-smith-session'), authorize };
}
async function signIn(provider: Provider, fake: { rememberNonce(n: string): void }, query: Record<string, string> = {}) {
  const start = await call(`/auth/login/${provider}`);
  expect(start.status).toBe(302);
  return finish(provider, start.headers.get('Location')!, cookieOf(start, '__Host-smith-oauth'), fake, query);
}
async function link(provider: Provider, who: { cookie: string; csrf: string }, fake: { rememberNonce(n: string): void }) {
  const response = await call(`/auth/link/${provider}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: who.cookie, 'X-Smith-CSRF': who.csrf }, body: '{}' });
  expect(response.status).toBe(200);
  const { url } = await response.json() as { url: string };
  return finish(provider, url, cookieOf(response, '__Host-smith-oauth'), fake);
}
const me = async (cookie: string) => (await call('/auth/me', { headers: { Cookie: cookie } })).json() as Promise<{ identities: { provider: string; email: string | null; login: string | null }[] }>;
const google = (sub: string, overrides: Record<string, unknown> = {}) => (nonce: string) => ({ iss: 'https://accounts.google.com', aud: 'google-client', sub, exp: Math.floor(Date.now() / 1000) + 300, nonce, email: `${sub}@example.com`, email_verified: true, ...overrides });

describe('sign in with Google or GitHub', () => {
  it('offers only providers whose client ID and secret are both set', async () => {
    expect(await (await call('/auth/providers', {}, env)).json()).toEqual({ providers: [] });
    expect(await (await call('/auth/providers')).json()).toEqual({ providers: ['google', 'github'] });
    expect((await call('/auth/login/google', {}, env)).status).toBe(404);
  });

  it('starts Google sign-in with PKCE, a nonce and a state bound to this browser', async () => {
    const start = await call('/auth/login/google');
    const url = new URL(start.headers.get('Location')!);
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ client_id: 'google-client', redirect_uri: `${origin}/auth/callback/google`, response_type: 'code', scope: 'openid email profile', code_challenge_method: 'S256' });
    expect(url.searchParams.get('nonce')).toBeTruthy();
    expect(start.headers.getSetCookie().find(c => c.startsWith('__Host-smith-oauth='))).toMatch(/HttpOnly; Secure; SameSite=Lax/);
  });

  it('refuses a Google account nobody linked, then signs in as the person who linked it', async () => {
    const fake = fakeProviders(); googleClaims = google('google-sem');
    const refused = await signIn('google', fake);
    expect(refused.location.search).toBe('?signin_error=not_linked&provider=google&detail=signin:not_linked');
    expect(refused.session).toBe('');
    const sem = await invitedSession();
    const linked = await link('google', sem, fake);
    expect(linked.location.search).toBe('?linked=google');
    // The token exchange proved PKCE: the verifier sent matches the challenge in the authorize URL.
    const verifier = tokenRequests.at(-1)!.get('code_verifier')!;
    // RFC 7636: 43-128 characters from the unreserved set. GitHub refuses a longer one with invalid_grant.
    expect(verifier).toMatch(/^[A-Za-z0-9._~-]{43,128}$/);
    const digest = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(digest).toBe(linked.authorize.searchParams.get('code_challenge'));
    expect(tokenRequests.at(-1)!.get('client_secret')).toBe('google-secret');
    expect((await me(sem.cookie)).identities).toEqual([{ provider: 'google', email: 'google-sem@example.com', login: null }]);
    const signedIn = await signIn('google', fake);
    expect(signedIn.location.search).toBe('?signed_in=google');
    expect(signedIn.session).toMatch(/^__Host-smith-session=/);
    expect((await me(signedIn.session)).identities).toEqual([{ provider: 'google', email: 'google-sem@example.com', login: null }]);
  });

  it('lets a Google Workspace account of the allowed domain in without an invitation, once per account', async () => {
    const fake = fakeProviders();
    googleClaims = google('studio-1', { email: 'Alex@RedMarmosetStudios.com', hd: 'redmarmosetstudios.com', name: 'Alex' });
    const first = await signIn('google', fake);
    expect(first.location.search).toBe('?signed_in=google');
    expect(first.session).toMatch(/^__Host-smith-session=/);
    const account = await (await call('/auth/me', { headers: { Cookie: first.session } })).json() as { user: { displayName: string; email: string }; identities: unknown[] };
    expect(account.user).toMatchObject({ displayName: 'Alex', email: 'alex@redmarmosetstudios.com' });
    expect(account.identities).toEqual([{ provider: 'google', email: 'Alex@RedMarmosetStudios.com', login: null }]);
    // Signing in again reuses the same Smith user instead of creating another.
    const users = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM identities WHERE subject = 'studio-1'").first<{ n: number }>())!.n;
    expect((await signIn('google', fake)).location.search).toBe('?signed_in=google');
    expect(await users()).toBe(1);
    // Studio access (members.ts) admits whoever's last Google sign-in proved the domain.
    const domainOf = async () => (await env.DB.prepare("SELECT google_domain FROM users WHERE id = (SELECT user_id FROM identities WHERE subject = 'studio-1')").first<{ google_domain: string | null }>())!.google_domain;
    expect(await domainOf()).toBe('redmarmosetstudios.com');
    googleClaims = google('studio-1', { email: 'alex@redmarmosetstudios.com' });   // the account left the Workspace
    expect((await signIn('google', fake)).location.search).toBe('?signed_in=google');
    expect(await domainOf()).toBeNull();
  });

  it('still needs an invitation for other domains, personal accounts using a domain address, or when no domain is allowed', async () => {
    const fake = fakeProviders();
    const refused = '?signin_error=not_linked&provider=google&detail=signin:not_linked';
    googleClaims = google('outsider', { email: 'someone@gmail.com' });
    expect((await signIn('google', fake)).location.search).toBe(refused);
    // A consumer Google account can carry a verified studio address but has no `hd` claim.
    googleClaims = google('personal', { email: 'someone@redmarmosetstudios.com' });
    expect((await signIn('google', fake)).location.search).toBe(refused);
    googleClaims = google('other-workspace', { email: 'someone@redmarmosetstudios.com', hd: 'example.com' });
    expect((await signIn('google', fake)).location.search).toBe(refused);
    googleClaims = google('mismatch', { email: 'someone@example.com', hd: 'redmarmosetstudios.com' });
    expect((await signIn('google', fake)).location.search).toBe(refused);
    googleClaims = google('no-domain', { email: 'someone@redmarmosetstudios.com', hd: 'redmarmosetstudios.com' });
    const inviteOnly = { ...configured, GOOGLE_ALLOWED_DOMAIN: '' } as unknown as Env;
    const start = await call('/auth/login/google', {}, inviteOnly);
    const authorize = new URL(start.headers.get('Location')!);
    fake.rememberNonce(authorize.searchParams.get('nonce')!);
    const back = await call(`/auth/callback/google?${new URLSearchParams({ code: 'provider-code', state: authorize.searchParams.get('state')! })}`,
      { headers: { Cookie: cookieOf(start, '__Host-smith-oauth') } }, inviteOnly);
    expect(new URL(back.headers.get('Location')!).search).toBe(refused);
  });

  it('links and signs in with GitHub by its stable account ID', async () => {
    const fake = fakeProviders(); githubUser = { id: 777, login: 'sem-gh' };
    const sem = await invitedSession();
    expect((await link('github', sem, fake)).location.search).toBe('?linked=github');
    expect((await me(sem.cookie)).identities).toEqual([{ provider: 'github', email: 'sem@example.com', login: 'sem-gh' }]);
    githubUser = { id: 777, login: 'renamed' };
    const signedIn = await signIn('github', fake);
    expect(signedIn.location.search).toBe('?signed_in=github');
    expect((await me(signedIn.session)).identities[0].login).toBe('renamed');
    githubUser = { id: 778, login: 'sem-gh' }; // same login, different account
    expect((await signIn('github', fake)).location.search).toBe('?signin_error=not_linked&provider=github&detail=signin:not_linked');
  });

  it('keeps the GitHub token from a link for repository access, refreshes it, and drops it on unlink', async () => {
    const fake = fakeProviders({ expiring: true }); githubUser = { id: 9001, login: 'keeper' };
    const sem = await invitedSession();
    await link('github', sem, fake);
    const stored = await env.DB.prepare('SELECT access_token, refresh_token, expires_at FROM provider_tokens WHERE user_id = ? AND provider = ?').bind(sem.userId, 'github').first<{ access_token: string; refresh_token: string; expires_at: number }>();
    expect(stored).toMatchObject({ access_token: 'gh-token', refresh_token: 'gh-refresh' });
    expect(stored!.expires_at).toBeGreaterThan(Date.now() + 7 * 3600 * 1000);
    expect(await githubTokenFor(configured, sem.userId)).toBe('gh-token');             // still fresh: no refresh call
    await env.DB.prepare('UPDATE provider_tokens SET expires_at = ? WHERE user_id = ?').bind(Date.now() + 60000, sem.userId).run();
    expect(await githubTokenFor(configured, sem.userId)).toBe('gh-token-2');           // about to lapse: refreshed and stored
    expect((await env.DB.prepare('SELECT refresh_token FROM provider_tokens WHERE user_id = ?').bind(sem.userId).first<{ refresh_token: string }>())!.refresh_token).toBe('gh-refresh-2');
    await env.DB.prepare('UPDATE provider_tokens SET expires_at = ?, refresh_token = ? WHERE user_id = ?').bind(Date.now() + 60000, 'stale', sem.userId).run();
    expect(await githubTokenFor(configured, sem.userId)).toBeNull();                   // GitHub refused the refresh: the token is gone
    expect(await env.DB.prepare('SELECT 1 FROM provider_tokens WHERE user_id = ?').bind(sem.userId).first()).toBeNull();
    // Signing in again stores a fresh token; unlinking removes it.
    const signedIn = await signIn('github', fake);
    expect(signedIn.location.search).toBe('?signed_in=github');
    expect(await githubTokenFor(configured, sem.userId)).toBe('gh-token');
    const unlink = await call('/auth/unlink/github', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: sem.cookie, 'X-Smith-CSRF': sem.csrf }, body: '{}' });
    expect(unlink.status).toBe(200);
    expect(await githubTokenFor(configured, sem.userId)).toBeNull();
    expect(await githubTokenFor(configured, 'nobody')).toBeNull();
  });
  it('never lets one provider account belong to two Smith users', async () => {
    const fake = fakeProviders(); googleClaims = google('shared-google');
    const first = await invitedSession(); const second = await invitedSession();
    expect((await link('google', first, fake)).location.search).toBe('?linked=google');
    expect((await link('google', second, fake)).location.search).toBe('?signin_error=already_linked&provider=google&detail=link:other_user');
    expect((await me(second.cookie)).identities).toEqual([]);
  });

  it('needs a signed-in session and its CSRF token to link', async () => {
    const sem = await invitedSession();
    expect((await call('/auth/link/google', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: '{}' })).status).toBe(401);
    expect((await call('/auth/link/google', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: sem.cookie }, body: '{}' })).status).toBe(403);
    expect((await call('/auth/link/google', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example', Cookie: sem.cookie, 'X-Smith-CSRF': sem.csrf }, body: '{}' })).status).toBe(403);
  });

  it('rejects a state from another browser, a replayed or expired state, and a cancelled sign-in', async () => {
    const fake = fakeProviders(); googleClaims = google('state-test');
    const start = await call('/auth/login/google');
    const url = start.headers.get('Location')!;
    expect((await finish('google', url, '__Host-smith-oauth=someone-elses', fake)).location.search).toBe('?signin_error=state&provider=google&detail=state:other_browser');
    expect((await finish('google', url, '', fake)).location.search).toBe('?signin_error=state&provider=google&detail=state:no_cookie');
    const cookie = cookieOf(start, '__Host-smith-oauth');
    expect((await finish('google', url, cookie, fake)).location.search).toBe('?signin_error=not_linked&provider=google&detail=signin:not_linked');
    expect((await finish('google', url, cookie, fake)).location.search).toBe('?signin_error=state&provider=google&detail=state:unknown_or_used');
    const late = await call('/auth/login/google');
    await env.DB.prepare('UPDATE oauth_states SET expires_at = 1').run();
    expect((await finish('google', late.headers.get('Location')!, cookieOf(late, '__Host-smith-oauth'), fake)).location.search).toBe('?signin_error=state&provider=google&detail=state:expired');
    expect((await signIn('google', fake, { error: 'access_denied' })).location.search).toBe('?signin_error=cancelled&provider=google&detail=provider:access_denied');
  });

  it('rejects Google tokens for another app, with the wrong nonce, expired, or without a verified email', async () => {
    const sem = await invitedSession(); const fake = fakeProviders();
    // Each refusal names the check that failed, so a broken sign-in explains itself in the dashboard.
    for (const [overrides, outcome, detail] of [[{ aud: 'other-app' }, 'provider_error', 'id_token:audience'], [{ nonce: 'replayed' }, 'provider_error', 'id_token:nonce'],
      [{ exp: 1000 }, 'provider_error', 'id_token:expired'], [{ iss: 'https://evil.example' }, 'provider_error', 'id_token:issuer'],
      [{ email_verified: false }, 'unverified_email', 'id_token:email_unverified']] as const) {
      googleClaims = (nonce: string) => ({ ...google('checked')(nonce), ...overrides });
      expect((await link('google', sem, fake)).location.search).toBe(`?signin_error=${outcome}&provider=google&detail=${detail}`);
    }
    expect((await me(sem.cookie)).identities).toEqual([]);
    // The provider's own error code (e.g. a wrong client secret is invalid_client) is passed through.
    vi.restoreAllMocks(); fakeProviders({ tokenStatus: 400 });
    expect((await signIn('google', { rememberNonce() {} })).location.search).toBe('?signin_error=provider_error&provider=google&detail=token:invalid_grant');
    vi.restoreAllMocks(); fakeProviders({ tokenStatus: 401, tokenError: '' });
    expect((await signIn('github', { rememberNonce() {} })).location.search).toBe('?signin_error=provider_error&provider=github&detail=token:http_401');
  });

  it('reports a link whose Smith user no longer exists instead of claiming success', async () => {
    const fake = fakeProviders(); googleClaims = google('orphan');
    const sem = await invitedSession();
    const response = await call('/auth/link/google', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: sem.cookie, 'X-Smith-CSRF': sem.csrf }, body: '{}' });
    const { url } = await response.json() as { url: string };
    await env.DB.prepare('UPDATE oauth_states SET link_user_id = ? WHERE link_user_id = ?').bind('missing-user', sem.userId).run();
    expect((await finish('google', url, cookieOf(response, '__Host-smith-oauth'), fake)).location.search).toBe('?signin_error=provider_error&provider=google&detail=link:no_smith_user');
  });

  it('sends the browser back with a reason when something unexpected breaks', async () => {
    fakeProviders(); vi.spyOn(console, 'error').mockImplementation(() => {});
    const start = await call('/auth/login/google');
    const broken = { ...configured, DB: { prepare() { throw new TypeError('database unavailable'); } } } as unknown as Env;
    const params = new URLSearchParams({ code: 'c', state: new URL(start.headers.get('Location')!).searchParams.get('state')! });
    const response = await call(`/auth/callback/google?${params}`, { headers: { Cookie: cookieOf(start, '__Host-smith-oauth') } }, broken);
    expect(response.status).toBe(302);
    expect(new URL(response.headers.get('Location')!).search).toBe('?signin_error=provider_error&provider=google&detail=internal:typeerror');
  });

  it('unlinks an account so it can no longer sign in', async () => {
    const fake = fakeProviders(); googleClaims = google('to-unlink');
    const sem = await invitedSession();
    await link('google', sem, fake);
    const unlinked = await call('/auth/unlink/google', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: sem.cookie, 'X-Smith-CSRF': sem.csrf }, body: '{}' });
    expect(unlinked.status).toBe(200);
    expect((await signIn('google', fake)).location.search).toBe('?signin_error=not_linked&provider=google&detail=signin:not_linked');
  });
});
