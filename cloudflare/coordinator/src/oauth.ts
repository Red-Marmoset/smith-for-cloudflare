import { fail, fields, hash, json, readBody, randomToken } from './http';

// "Sign in with Google / GitHub" using the OAuth authorization-code flow with PKCE, a one-use state
// bound to this browser, and (for Google) an OIDC nonce. Smith stays invite-only: an external account
// signs in only after its owner linked it while signed in to Smith. Email is shown, never used to
// match accounts, so a provider account can never take over another person's Smith user. The one
// exception is GOOGLE_ALLOWED_DOMAIN: an unlinked account of that Google Workspace (proved by the
// `hd` claim, which Google sets only for accounts the domain manages) gets a new Smith user of its own.
export const PROVIDERS = ['google', 'github'] as const;
export type Provider = typeof PROVIDERS[number];
const STATE_COOKIE = '__Host-smith-oauth';
const STATE_SECONDS = 600;
type Settings = { authorize: string; token: string; scope: string; clientId?: string; secret?: string };
// `tokens` is what GitHub handed us for this person (kept for repository access); Google's is not kept.
type Tokens = { accessToken: string; refreshToken: string | null; expiresAt: number | null } | null;
type Profile = { subject: string; email: string | null; login: string | null; tokens: Tokens; domain?: string | null; name?: string | null };

function settings(env: Env, provider: Provider): Settings {
  return provider === 'google'
    ? { authorize: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token', scope: 'openid email profile', clientId: env.GOOGLE_CLIENT_ID, secret: env.GOOGLE_CLIENT_SECRET }
    : { authorize: 'https://github.com/login/oauth/authorize', token: 'https://github.com/login/oauth/access_token', scope: 'read:user user:email repo', clientId: env.GITHUB_CLIENT_ID, secret: env.GITHUB_CLIENT_SECRET };
}
export function configuredProviders(env: Env): Provider[] { return PROVIDERS.filter(p => settings(env, p).clientId && settings(env, p).secret); }
function provider(env: Env, name: string): Provider {
  if (!(PROVIDERS as readonly string[]).includes(name) || !configuredProviders(env).includes(name as Provider)) fail(404, 'not_found', 'That sign-in provider is not set up');
  return name as Provider;
}
function base64url(bytes: ArrayBuffer): string { return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function redirectUri(env: Env, p: Provider): string { return `${env.ORIGIN}/auth/callback/${p}`; }
function redirect(location: string, cookies: string[] = []): Response {
  const response = new Response(null, { status: 302, headers: { Location: location, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
  for (const cookie of cookies) response.headers.append('Set-Cookie', cookie);
  return response;
}
const clearState = `${STATE_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

// Creates a one-use attempt and returns the provider URL plus the cookie that binds it to this browser.
// The state cookie is SameSite=Lax because the provider's redirect back is a cross-site navigation.
async function begin(env: Env, p: Provider, linkUserId: string | null): Promise<{ url: string; cookie: string }> {
  const config = settings(env, p);
  // RFC 7636 allows a 43-128 character verifier; GitHub rejects a longer one with invalid_grant
  // (Google does not), so use 32 random bytes as base64url: exactly 43 characters.
  const state = randomToken(), verifier = base64url(crypto.getRandomValues(new Uint8Array(32)).buffer), nonce = randomToken();
  const challenge = base64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM oauth_states WHERE expires_at <= ?').bind(now),
    env.DB.prepare('INSERT INTO oauth_states (state_hash, provider, verifier, nonce, link_user_id, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(await hash(state), p, verifier, nonce, linkUserId, now + STATE_SECONDS * 1000),
  ]);
  const url = new URL(config.authorize);
  url.search = new URLSearchParams({ client_id: config.clientId!, redirect_uri: redirectUri(env, p), response_type: 'code', scope: config.scope, state,
    code_challenge: challenge, code_challenge_method: 'S256', ...(p === 'google' ? { nonce, prompt: 'select_account' } : { allow_signup: 'false' }) }).toString();
  return { url: url.toString(), cookie: `${STATE_COOKIE}=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${STATE_SECONDS}` };
}

// `code` picks the message the dashboard shows; `detail` is a short machine-readable reason
// (a provider error code or the check that failed) shown with it, so a failure explains itself.
class SignInError extends Error {
  constructor(code: string, readonly detail: string, readonly log = '') { super(code); }
}
// Details travel in the redirect URL and appear in the dashboard, so they are restricted to codes.
function safeDetail(value: string): string { return value.toLowerCase().replace(/[^a-z0-9_.:-]+/g, '_').slice(0, 80); }
async function providerError(step: string, response: Response, body: { error?: unknown; error_description?: unknown; message?: unknown }): Promise<SignInError> {
  const code = typeof body.error === 'string' ? body.error : `http_${response.status}`;
  const description = [body.error_description, body.message].filter(v => typeof v === 'string').join(' ');
  return new SignInError('provider_error', safeDetail(`${step}:${code}`), description.slice(0, 500));
}
// Provider calls never follow redirects. The Workers runtime throws on redirect: 'error', so use
// 'manual': a 3xx then arrives as a response that is not ok, and is refused like any other failure.
async function profile(env: Env, p: Provider, code: string, verifier: string, nonce: string): Promise<Profile> {
  const config = settings(env, p);
  const tokenResponse = await fetch(config.token, { method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri(env, p), client_id: config.clientId!, client_secret: config.secret!, code_verifier: verifier }) });
  const tokens = await tokenResponse.json().catch(() => ({})) as { id_token?: string; access_token?: string; error?: string; error_description?: string };
  if (!tokenResponse.ok || tokens.error) throw await providerError('token', tokenResponse, tokens);
  if (p === 'google') {
    // The ID token came straight from Google's token endpoint over TLS, so its claims are trusted
    // after checking it was minted for this app, is current, carries our nonce and a verified email.
    const part = tokens.id_token?.split('.')[1];
    if (!part) throw new SignInError('provider_error', 'id_token:missing');
    let claims: { iss?: string; aud?: string; sub?: string; exp?: number; nonce?: string; email?: string; email_verified?: boolean | string; hd?: string; name?: string };
    try { claims = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/'))); } catch { throw new SignInError('provider_error', 'id_token:unreadable'); }
    if (!['accounts.google.com', 'https://accounts.google.com'].includes(claims.iss ?? '')) throw new SignInError('provider_error', 'id_token:issuer');
    if (claims.aud !== config.clientId) throw new SignInError('provider_error', 'id_token:audience', `aud ${claims.aud} is not the configured GOOGLE_CLIENT_ID`);
    if (!claims.sub) throw new SignInError('provider_error', 'id_token:subject');
    if (!claims.exp || claims.exp * 1000 < Date.now() - 60000) throw new SignInError('provider_error', 'id_token:expired');
    if (claims.nonce !== nonce) throw new SignInError('provider_error', 'id_token:nonce');
    if (claims.email_verified !== true && claims.email_verified !== 'true') throw new SignInError('unverified_email', 'id_token:email_unverified');
    return { subject: claims.sub, email: claims.email ?? null, login: null, tokens: null, domain: claims.hd ?? null, name: claims.name ?? null };
  }
  if (!tokens.access_token) throw new SignInError('provider_error', 'token:no_access_token');
  const headers = { Authorization: `Bearer ${tokens.access_token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'smith-coordinator', 'X-GitHub-Api-Version': '2022-11-28' };
  const userResponse = await fetch('https://api.github.com/user', { headers, redirect: 'manual' });
  const user = await userResponse.json().catch(() => ({})) as { id?: number; login?: string; message?: string };
  if (!userResponse.ok) throw await providerError('github_user', userResponse, user);
  if (!Number.isSafeInteger(user.id)) throw new SignInError('provider_error', 'github_user:no_id');
  const emailsResponse = await fetch('https://api.github.com/user/emails', { headers, redirect: 'manual' });
  const emails = emailsResponse.ok ? await emailsResponse.json().catch(() => []) as { email: string; primary: boolean; verified: boolean }[] : [];
  const primary = Array.isArray(emails) ? emails.find(e => e.primary && e.verified) : undefined;
  return { subject: String(user.id), email: primary?.email ?? null, login: typeof user.login === 'string' ? user.login : null, tokens: parseTokens(tokens) };
}
function parseTokens(tokens: { access_token?: string; refresh_token?: string; expires_in?: number }): Tokens {
  if (!tokens.access_token) return null;
  return { accessToken: tokens.access_token, refreshToken: typeof tokens.refresh_token === 'string' ? tokens.refresh_token : null,
    expiresAt: Number.isFinite(tokens.expires_in) ? Date.now() + Number(tokens.expires_in) * 1000 : null };
}
// Keep (or drop) the person's provider token. A coordinator whose migration has not run yet keeps signing people in.
async function storeTokens(env: Env, userId: string, p: Provider, tokens: Tokens): Promise<void> {
  try {
    if (!tokens) { await env.DB.prepare('DELETE FROM provider_tokens WHERE user_id = ? AND provider = ?').bind(userId, p).run(); return; }
    await env.DB.prepare(`INSERT INTO provider_tokens (user_id, provider, access_token, refresh_token, expires_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, provider) DO UPDATE SET access_token = excluded.access_token, refresh_token = excluded.refresh_token, expires_at = excluded.expires_at, updated_at = excluded.updated_at`)
      .bind(userId, p, tokens.accessToken, tokens.refreshToken, tokens.expiresAt, Date.now()).run();
  } catch (error) { if (!String(error).includes('no such table')) throw error; console.warn('provider_tokens table missing; run the D1 migrations'); }
}
// A live GitHub token for this person, refreshed when the GitHub App's expiring token is about to
// lapse. Null when they never linked GitHub (or the token can no longer be refreshed).
export async function githubTokenFor(env: Env, userId: string): Promise<string | null> {
  let row: { access_token: string; refresh_token: string | null; expires_at: number | null } | null;
  try { row = await env.DB.prepare('SELECT access_token, refresh_token, expires_at FROM provider_tokens WHERE user_id = ? AND provider = ?').bind(userId, 'github').first(); }
  catch (error) { if (String(error).includes('no such table')) return null; throw error; }
  if (!row) return null;
  if (!row.expires_at || row.expires_at > Date.now() + 5 * 60 * 1000) return row.access_token;
  if (!row.refresh_token) return null;
  const config = settings(env, 'github');
  const response = await fetch(config.token, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ client_id: config.clientId ?? '', client_secret: config.secret ?? '', grant_type: 'refresh_token', refresh_token: row.refresh_token }) });
  const refreshed = await response.json().catch(() => ({})) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string };
  const tokens = response.ok && !refreshed.error ? parseTokens(refreshed) : null;
  await storeTokens(env, userId, 'github', tokens);
  return tokens?.accessToken ?? null;
}
// Every member's live GitHub token, for reads nobody is signed in for (rescans from the alarm).
export async function githubTokensFor(env: Env, userIds: string[]): Promise<{ userId: string; token: string }[]> {
  const out: { userId: string; token: string }[] = [];
  for (const userId of userIds) { const token = await githubTokenFor(env, userId); if (token) out.push({ userId, token }); }
  return out;
}

// `startSession` creates a Smith session for a user and returns its cookie (see auth.ts).
export async function handleOAuth(request: Request, env: Env, path: string, signedIn: () => Promise<{ userId: string }>,
  startSession: (userId: string) => Promise<string>): Promise<Response | null> {
  if (path === '/auth/providers' && request.method === 'GET') return json({ providers: configuredProviders(env) });

  const login = /^\/auth\/login\/([a-z]+)$/.exec(path);
  if (login && request.method === 'GET') {
    const started = await begin(env, provider(env, login[1]), null);
    return redirect(started.url, [started.cookie]);
  }
  // Linking needs a current Smith session and its CSRF token, so another site cannot link its own
  // account to yours. The browser then navigates to the returned provider URL.
  const link = /^\/auth\/link\/([a-z]+)$/.exec(path);
  if (link && request.method === 'POST') {
    const p = provider(env, link[1]);
    const { userId } = await signedIn(); fields(await readBody(request), []);
    const started = await begin(env, p, userId);
    const response = json({ url: started.url });
    response.headers.set('Set-Cookie', started.cookie);
    return response;
  }
  const unlink = /^\/auth\/unlink\/([a-z]+)$/.exec(path);
  if (unlink && request.method === 'POST') {
    if (!(PROVIDERS as readonly string[]).includes(unlink[1])) fail(404, 'not_found', 'Unknown provider');
    const { userId } = await signedIn(); fields(await readBody(request), []);
    await env.DB.prepare('DELETE FROM identities WHERE user_id = ? AND provider = ?').bind(userId, unlink[1]).run();
    await storeTokens(env, userId, unlink[1] as Provider, null);
    return json({ unlinked: true });
  }

  const callback = /^\/auth\/callback\/([a-z]+)$/.exec(path);
  if (!callback || request.method !== 'GET') return null;
  const name = callback[1];
  // Every failure says which provider and why (`detail`), and lands in the Worker logs (wrangler tail),
  // so a sign-in or link that does not work never fails silently.
  const done = (outcome: string, cookies: string[] = []) => redirect(`${env.ORIGIN}/?${outcome}`, [clearState, ...cookies]);
  const failed = (code: string, detail: string, log = '') => {
    console.warn(`${name} sign-in refused: ${code} (${detail})${log ? ': ' + log : ''}`);
    // safeDetail leaves only [a-z0-9_.:-], which needs no escaping in a query string.
    return done(`signin_error=${code}&provider=${safeDetail(name)}&detail=${safeDetail(detail)}`);
  };
  try {
    return await finishCallback(request, env, name, startSession, done, failed);
  } catch (error) {
    // Anything else is a Smith bug: log it, and still send the browser back with a reason.
    console.error(`${name} sign-in failed unexpectedly`, error);
    return failed('provider_error', `internal:${error instanceof Error ? error.name : 'error'}`);
  }
}

async function finishCallback(request: Request, env: Env, name: string, startSession: (userId: string) => Promise<string>,
  done: (outcome: string, cookies?: string[]) => Response, failed: (code: string, detail: string, log?: string) => Response): Promise<Response> {
  if (!(PROVIDERS as readonly string[]).includes(name) || !configuredProviders(env).includes(name as Provider)) return failed('provider_error', 'not_configured');
  const p = name as Provider;
  const url = new URL(request.url);
  const state = url.searchParams.get('state') ?? '';
  const cookieState = (request.headers.get('Cookie') ?? '').split(';').map(c => c.trim()).find(c => c.startsWith(STATE_COOKIE + '='))?.slice(STATE_COOKIE.length + 1) ?? '';
  // The state must match this browser's cookie and an unexpired, unused attempt for this provider.
  if (!state || state.length > 256) return failed('state', 'state:missing');
  if (state !== cookieState) return failed('state', cookieState ? 'state:other_browser' : 'state:no_cookie');
  const attempt = await env.DB.prepare('DELETE FROM oauth_states WHERE state_hash = ? AND provider = ? RETURNING verifier, nonce, link_user_id, expires_at')
    .bind(await hash(state), p).first<{ verifier: string; nonce: string; link_user_id: string | null; expires_at: number }>();
  if (!attempt) return failed('state', 'state:unknown_or_used');
  if (attempt.expires_at <= Date.now()) return failed('state', 'state:expired');
  // The provider's own error code, e.g. access_denied when you cancel, or admin_policy_enforced.
  if (url.searchParams.has('error')) return failed('cancelled', `provider:${url.searchParams.get('error')}`, url.searchParams.get('error_description') ?? '');
  const code = url.searchParams.get('code') ?? '';
  if (!code || code.length > 2048) return failed('provider_error', 'callback:no_code');
  let account: Profile;
  try { account = await profile(env, p, code, attempt.verifier, attempt.nonce); }
  catch (error) {
    if (error instanceof SignInError) return failed(error.message, error.detail, error.log);
    throw error;
  }

  const existing = await env.DB.prepare('SELECT user_id FROM identities WHERE provider = ? AND subject = ?').bind(p, account.subject).first<{ user_id: string }>();
  if (attempt.link_user_id) {
    if (existing && existing.user_id !== attempt.link_user_id) return failed('already_linked', 'link:other_user');
    // One account per provider per Smith user: linking a different one replaces the old link.
    const results = await env.DB.batch([
      env.DB.prepare('DELETE FROM identities WHERE user_id = ? AND provider = ? AND subject <> ?').bind(attempt.link_user_id, p, account.subject),
      env.DB.prepare(`INSERT INTO identities (provider, subject, user_id, email, login, created_at) SELECT ?, ?, id, ?, ?, ? FROM users WHERE id = ?
        ON CONFLICT(provider, subject) DO UPDATE SET email = excluded.email, login = excluded.login`).bind(p, account.subject, account.email, account.login, Date.now(), attempt.link_user_id),
    ]);
    // The insert selects from users, so a user that no longer exists links nothing: say so rather than "linked".
    if (results[1].meta.changes !== 1) return failed('provider_error', 'link:no_smith_user');
    await storeTokens(env, attempt.link_user_id, p, account.tokens);
    if (p === 'google') await recordStudioDomain(env, attempt.link_user_id, studioDomain(env, account));
    return done(`linked=${p}`);
  }
  if (!existing) {
    const userId = await provisionDomainUser(env, p, account);
    if (!userId) return failed('not_linked', 'signin:not_linked');
    return done(`signed_in=${p}`, [await startSession(userId)]);
  }
  await env.DB.prepare('UPDATE identities SET email = ?, login = ? WHERE provider = ? AND subject = ?').bind(account.email, account.login, p, account.subject).run();
  await storeTokens(env, existing.user_id, p, account.tokens);
  if (p === 'google') await recordStudioDomain(env, existing.user_id, studioDomain(env, account));
  return done(`signed_in=${p}`, [await startSession(existing.user_id)]);
}

// A first Google sign-in from the allowed Workspace domain creates that person's Smith user and links
// the account to it, so studio staff need no invitation. Anyone else (including a personal Google
// account that merely uses a domain address) still needs an invitation and a link. Returns null when
// the account does not qualify.
// The allowed Workspace domain when this Google account proves it (its `hd` claim, which Google sets only for
// accounts the domain manages, plus an email on it), else null.
function studioDomain(env: Env, account: Profile): string | null {
  const domain = (env.GOOGLE_ALLOWED_DOMAIN ?? '').trim().toLowerCase();
  return domain && account.domain?.toLowerCase() === domain && (account.email ?? '').toLowerCase().endsWith('@' + domain) ? domain : null;
}
// Refreshed at every Google sign-in and link, so Studio access (members.ts) follows who is on the domain now.
async function recordStudioDomain(env: Env, userId: string, domain: string | null): Promise<void> {
  try { await env.DB.prepare('UPDATE users SET google_domain = ? WHERE id = ?').bind(domain, userId).run(); }
  catch (error) { if (!String(error).includes('no such column')) throw error; console.warn('users.google_domain missing; run the D1 migrations'); }
}
async function provisionDomainUser(env: Env, p: Provider, account: Profile): Promise<string | null> {
  const domain = p === 'google' ? studioDomain(env, account) : null;
  if (!domain) return null;
  const email = (account.email ?? '').toLowerCase();
  const userId = `user-${crypto.randomUUID()}`, now = Date.now();
  // The identity insert loses to a concurrent first sign-in of the same account (ON CONFLICT DO NOTHING);
  // then whoever won owns it, and this attempt's spare user is removed.
  const results = await env.DB.batch([
    env.DB.prepare('INSERT INTO users (id, created_at, display_name, email) VALUES (?, ?, ?, ?)').bind(userId, now, (account.name ?? '').slice(0, 64), email),
    env.DB.prepare('INSERT INTO identities (provider, subject, user_id, email, login, created_at) VALUES (?, ?, ?, ?, NULL, ?) ON CONFLICT(provider, subject) DO NOTHING')
      .bind(p, account.subject, userId, account.email, now),
  ]);
  if (results[1].meta.changes === 1) {
    console.log(`google sign-in created a Smith user for a ${domain} account`);
    await recordStudioDomain(env, userId, domain);
    return userId;
  }
  await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(userId).run();
  const winner = (await env.DB.prepare('SELECT user_id FROM identities WHERE provider = ? AND subject = ?').bind(p, account.subject).first<{ user_id: string }>())?.user_id ?? null;
  if (winner) await recordStudioDomain(env, winner, domain);
  return winner;
}

// Linked accounts for the dashboard. A coordinator deployed before its identities migration ran must
// still let people sign in with invitations, so a missing table reads as "nothing linked".
export async function identitiesFor(env: Env, userId: string): Promise<{ provider: string; email: string | null; login: string | null }[]> {
  try {
    return (await env.DB.prepare('SELECT provider, email, login FROM identities WHERE user_id = ? ORDER BY provider').bind(userId).all<{ provider: string; email: string | null; login: string | null }>()).results;
  } catch (error) {
    if (String(error).includes('no such table')) return [];
    throw error;
  }
}
