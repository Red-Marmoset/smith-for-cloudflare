// Cloudflare Artifacts (git hosting) adapter: repository lookup/creation, branch heads and
// repo-scoped git tokens, through the account REST API for a workspace's own Cloudflare account
// (account ID and API token in Settings), or the Worker's Artifacts binding for Smith's backend account. The Worker never runs git; a native agent does the push
// (see mirrorSpecs). Tests run the in-memory fake (ARTIFACTS_MODE=fake binding).
import { fail, HttpError } from './http';

export interface ArtifactsRepo { name: string; remote: string; defaultBranch: string }
export interface ArtifactsToken { id: string; plaintext: string; expiresAt: number }
export interface ArtifactsClient {
  readonly configured: boolean;
  readonly namespace: string;
  getRepo(name: string): Promise<ArtifactsRepo | null>;
  createRepo(name: string, defaultBranch: string, description: string): Promise<ArtifactsRepo>;
  branchHead(name: string, branch: string): Promise<string | null>;
  issueToken(name: string, scope: 'read' | 'write', ttlSeconds: number): Promise<ArtifactsToken>;
  revokeToken(repo: string, id: string): Promise<void>;
  // Removes a repository (a project whose first push failed leaves nothing behind); a missing one is fine.
  deleteRepo(name: string): Promise<void>;
  // What a git push to a repository's remote goes through: the network, or the test fake's receive-pack.
  readonly gitFetch: typeof fetch;
  // Whether the account behind the credentials can use Artifacts at all: true or false when the
  // API said so, null when it could not be asked (network, 5xx), so a caller keeps its last answer.
  probe(): Promise<boolean | null>;
}
type ArtifactsEnv = { ARTIFACTS_NAMESPACE?: string; ARTIFACTS_MODE?: string; SMITH_ARTIFACTS_ACCOUNT_ID?: string; SMITH_ARTIFACTS_TOKEN?: string; ARTIFACTS?: ArtifactsBinding };
// Where a copy lives: the workspace's own Cloudflare account (when Settings hold an account ID +
// API token) or Smith's backend account (the Worker's SMITH_ARTIFACTS_* secret), else nowhere.
export type ArtifactsSource = 'workspace' | 'smith' | 'none';
// `binding`: Smith's backend account reached through the Worker's own Artifacts binding (wrangler.jsonc), which
// needs no API token; SMITH_ARTIFACTS_TOKEN is only the fallback for a deployment without the binding.
export interface ArtifactsCredentials { accountId: string; apiToken: string; source: ArtifactsSource; binding?: boolean }
export function artifactsConfigured(credentials: { accountId: string; apiToken: string; binding?: boolean }): boolean { return Boolean(credentials.accountId && (credentials.apiToken || credentials.binding)); }
// Pick the credentials for a copy. A workspace token wins over Smith's backend; `accountId`
// pins the choice to the account an existing copy already lives in, so adding or removing a
// workspace token later never redirects that project's builds to a different account.
export function resolveArtifactsCredentials(env: unknown, workspace: { accountId: string; apiToken: string }, accountId?: string): ArtifactsCredentials {
  const e = env as ArtifactsEnv;
  const backend = e.ARTIFACTS_MODE === 'fake' ? fakeArtifacts.backend : { accountId: e.SMITH_ARTIFACTS_ACCOUNT_ID ?? '', apiToken: e.SMITH_ARTIFACTS_TOKEN ?? '', binding: Boolean(e.ARTIFACTS) };
  const candidates: ArtifactsCredentials[] = [{ ...workspace, source: 'workspace' as const }, { ...(backend ?? { accountId: '', apiToken: '' }), source: 'smith' as const }].filter(artifactsConfigured);
  const chosen = accountId ? candidates.find(c => c.accountId === accountId) : candidates[0];
  return chosen ?? { accountId: accountId ?? '', apiToken: '', source: 'none' };
}

const REMOTE = /^https:\/\/[a-f0-9]{32}\.artifacts\.cloudflare\.net\/git\/[A-Za-z0-9][A-Za-z0-9._-]{1,62}\/[A-Za-z0-9][A-Za-z0-9._-]{1,62}\.git$/;
export function isArtifactsRemote(url: string): boolean { return url.length < 512 && REMOTE.test(url); }
// One Artifacts repo per (workspace, project); the workspace prefix keeps projects of different
// workspaces apart inside the account's shared namespace. Fits the 2–63 char naming rule.
export function repoNameFor(workspaceId: string, projectId: string): string { return `${workspaceId.slice(0, 12)}-${projectId}`.slice(0, 63); }
export function tokenExpiry(plaintext: string): number { const match = /\?expires=(\d+)$/.exec(plaintext); return match ? Number(match[1]) * 1000 : 0; }
export const WRITE_TOKEN_TTL = 7200;        // long enough for a push, short enough to limit exposure
export const READ_TOKEN_TTL = 7 * 86400;    // a queued build may wait for a machine for days

interface Envelope<T> { success: boolean; result: T; errors?: { code: number; message: string }[] }
class RestClient implements ArtifactsClient {
  readonly configured = true;
  constructor(private readonly account: string, readonly namespace: string, private readonly token: string) {}
  // redirect: 'manual' because the Workers runtime rejects 'error'; a 3xx then simply fails the call.
  private async call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; envelope: Envelope<T> | null }> {
    const url = `https://api.cloudflare.com/client/v4/accounts/${this.account}/artifacts/namespaces/${encodeURIComponent(this.namespace)}${path}`;
    let response: Response;
    try {
      response = await fetch(url, { method, redirect: 'manual', signal: AbortSignal.timeout(10000),
        headers: { Authorization: `Bearer ${this.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch { fail(502, 'artifacts_unavailable', 'Smith’s copy of this project could not be reached; try again shortly'); }
    if (response.status === 409) fail(409, 'artifacts_busy', 'Smith’s copy of this project is still being prepared; try again shortly');
    const envelope = await response.json().catch(() => null) as Envelope<T> | null;
    if (response.status === 401 || response.status === 403) fail(502, 'artifacts_unauthorized', 'Smith could not reach its copy of this project: the Cloudflare API token was rejected. Check its permissions in workspace Settings');
    return { status: response.status, envelope };
  }
  private okOrFail<T>(status: number, envelope: Envelope<T> | null, what: string): T {
    if (status < 500 && envelope?.success) return envelope.result;
    console.error(JSON.stringify({ event: 'artifacts_failed', what, status, code: envelope?.errors?.[0]?.code }));
    fail(502, 'artifacts_failed', `Smith’s copy of this project failed (${what})${envelope?.errors?.[0]?.message ? ': ' + envelope.errors[0].message : ''}`);
  }
  private repo(result: { name: string; remote: string; default_branch?: string | null }): ArtifactsRepo { return { name: result.name, remote: result.remote, defaultBranch: result.default_branch || 'main' }; }
  async getRepo(name: string): Promise<ArtifactsRepo | null> {
    const { status, envelope } = await this.call<{ name: string; remote: string; default_branch?: string | null }>('GET', `/repos/${encodeURIComponent(name)}`);
    if (status === 404 || envelope?.errors?.some(e => e.code === 10200)) return null;
    return this.repo(this.okOrFail(status, envelope, 'repository lookup'));
  }
  async createRepo(name: string, defaultBranch: string, description: string): Promise<ArtifactsRepo> {
    const { status, envelope } = await this.call<{ name: string; remote: string; default_branch?: string | null }>('POST', '/repos', { name, description, default_branch: defaultBranch, read_only: false });
    // Made by a concurrent request since our lookup: use that one.
    if (envelope?.errors?.some(e => e.code === 10201)) { const existing = await this.getRepo(name); if (existing) return existing; }
    return this.repo(this.okOrFail(status, envelope, 'repository creation'));
  }
  async branchHead(name: string, branch: string): Promise<string | null> {
    const { status, envelope } = await this.call<{ hash?: string; commit?: string; id?: string }[] | { commits?: { hash?: string; commit?: string; id?: string }[] }>('GET', `/repos/${encodeURIComponent(name)}/log?ref=${encodeURIComponent(branch)}&limit=1`);
    // An empty repository or a missing branch. Any other failure (a 5xx included) throws, so a caller verifying
    // a push retries later instead of recording a good copy as failed.
    if (status === 404 || envelope?.errors?.some(e => e.code === 10200)) return null;
    const result = this.okOrFail(status, envelope, 'branch lookup');
    const entries = Array.isArray(result) ? result : result.commits ?? [];
    const first = entries[0]; const sha = first ? (first.hash ?? first.commit ?? first.id ?? '') : '';
    return /^[a-f0-9]{40}$/.test(sha) ? sha : null;
  }
  async issueToken(name: string, scope: 'read' | 'write', ttlSeconds: number): Promise<ArtifactsToken> {
    const { status, envelope } = await this.call<{ id: string; plaintext: string; expires_at?: string | number }>('POST', '/tokens', { repo: name, scope, ttl: ttlSeconds });
    const result = this.okOrFail(status, envelope, 'token issue');
    return { id: result.id, plaintext: result.plaintext, expiresAt: tokenExpiry(result.plaintext) || Date.now() + ttlSeconds * 1000 };
  }
  async revokeToken(_repo: string, id: string): Promise<void> {
    const { status, envelope } = await this.call('DELETE', `/tokens/${encodeURIComponent(id)}`);
    if (status !== 404) this.okOrFail(status, envelope, 'token revocation');
  }
  async deleteRepo(name: string): Promise<void> {
    const { status, envelope } = await this.call('DELETE', `/repos/${encodeURIComponent(name)}`);
    if (status !== 404 && !envelope?.errors?.some(e => e.code === 10200)) this.okOrFail(status, envelope, 'repository removal');
  }
  readonly gitFetch: typeof fetch = (input, init) => fetch(input, init);
  // Looks up a repository that never exists. An account with Artifacts answers "repository not found"
  // (code 10200); one without it, or a token without Artifacts permission, answers anything else.
  async probe(): Promise<boolean | null> {
    const url = `https://api.cloudflare.com/client/v4/accounts/${this.account}/artifacts/namespaces/${encodeURIComponent(this.namespace)}/repos/smith-capability-check`;
    let response: Response;
    try { response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5000), headers: { Authorization: `Bearer ${this.token}` } }); }
    catch { return null; }
    if (response.status >= 500 || response.status === 429) return null;
    const envelope = await response.json().catch(() => null) as Envelope<unknown> | null;
    return Boolean(envelope?.success) || Boolean(envelope?.errors?.some(e => e.code === 10200));
  }
}

// Smith's backend account through the Worker's Artifacts binding: no API token, and the account is the Worker's own.
// Binding errors carry the API's error names (NOT_FOUND, IMPORT_IN_PROGRESS, ...) in their message.
interface ArtifactsBindingRepo {
  info(): Promise<{ name: string; remote: string; defaultBranch: string }>;
  createToken(scope?: 'read' | 'write', ttl?: number): Promise<{ id: string; plaintext: string; expiresAt: string }>;
  revokeToken(tokenOrId: string): Promise<boolean>;
  log(opts?: { ref?: string; limit?: number }): Promise<{ hash: string }[]>;
  [Symbol.dispose]?(): void;
}
export interface ArtifactsBinding {
  create(name: string, opts?: { readOnly?: boolean; description?: string; setDefaultBranch?: string }): Promise<{ name: string; remote: string; defaultBranch: string; token: string }>;
  get(name: string): Promise<ArtifactsBindingRepo>;
  list(opts?: { limit?: number }): Promise<unknown>;
  delete?(name: string): Promise<unknown>;
}
const errorText = (error: unknown) => error instanceof Error ? `${(error as { code?: unknown }).code ?? ''} ${error.message}` : String(error);
const NOT_FOUND = /NOT_FOUND|10200|not found|does not exist/i;
const BUSY = /IMPORT_IN_PROGRESS|FORK_IN_PROGRESS|1030[23]|not ready/i;
class BindingClient implements ArtifactsClient {
  readonly configured = true;
  constructor(private readonly artifacts: ArtifactsBinding, readonly namespace: string) {}
  private failed(error: unknown, what: string): never {
    if (error instanceof HttpError) throw error;
    const text = errorText(error);
    if (BUSY.test(text)) fail(409, 'artifacts_busy', 'Smith’s copy of this project is still being prepared; try again shortly');
    console.error(JSON.stringify({ event: 'artifacts_failed', what, via: 'binding', message: text.slice(0, 200) }));
    fail(502, 'artifacts_failed', `Smith’s copy of this project failed (${what})`);
  }
  // The repository handle, or null when it does not exist; released after `use`.
  private async withRepo<T>(name: string, what: string, use: (repo: ArtifactsBindingRepo) => Promise<T>): Promise<T | null> {
    let repo: ArtifactsBindingRepo;
    try { repo = await this.artifacts.get(name); }
    catch (error) { if (NOT_FOUND.test(errorText(error)) && !BUSY.test(errorText(error))) return null; return this.failed(error, what); }
    try { return await use(repo); }
    catch (error) { return this.failed(error, what); }
    finally { try { repo[Symbol.dispose]?.(); } catch { /* already released */ } }
  }
  async getRepo(name: string): Promise<ArtifactsRepo | null> {
    return this.withRepo(name, 'repository lookup', async repo => { const info = await repo.info(); return { name: info.name, remote: info.remote, defaultBranch: info.defaultBranch || 'main' }; });
  }
  async createRepo(name: string, defaultBranch: string, description: string): Promise<ArtifactsRepo> {
    let created: { name: string; remote: string; defaultBranch: string; token: string };
    try { created = await this.artifacts.create(name, { description, readOnly: false, setDefaultBranch: defaultBranch }); }
    catch (error) {
      if (/ALREADY_EXISTS|10201/i.test(errorText(error))) { const existing = await this.getRepo(name); if (existing) return existing; }
      this.failed(error, 'repository creation');
    }
    // create() hands back a write token Smith never uses; revoke it rather than leave it live.
    if (created.token) await this.withRepo(name, 'token revocation', repo => repo.revokeToken(created.token)).catch(() => console.error(JSON.stringify({ event: 'artifacts_initial_token_revoke_failed' })));
    return { name: created.name, remote: created.remote, defaultBranch: created.defaultBranch || defaultBranch };
  }
  async branchHead(name: string, branch: string): Promise<string | null> {
    // log() answers [] for a ref it cannot resolve (an empty repository or a missing branch).
    const entries = await this.withRepo(name, 'branch lookup', repo => repo.log({ ref: branch, limit: 1 }));
    const sha = entries?.[0]?.hash ?? '';
    return /^[a-f0-9]{40}$/.test(sha) ? sha : null;
  }
  async issueToken(name: string, scope: 'read' | 'write', ttlSeconds: number): Promise<ArtifactsToken> {
    const token = await this.withRepo(name, 'token issue', repo => repo.createToken(scope, ttlSeconds));
    if (!token) fail(502, 'artifacts_failed', 'Smith’s copy of this project failed (token issue): the repository does not exist');
    return { id: token.id, plaintext: token.plaintext, expiresAt: tokenExpiry(token.plaintext) || Date.parse(token.expiresAt) || Date.now() + ttlSeconds * 1000 };
  }
  async revokeToken(repo: string, id: string): Promise<void> { await this.withRepo(repo, 'token revocation', handle => handle.revokeToken(id)); }   // a gone repository has no live tokens
  async deleteRepo(name: string): Promise<void> {
    try { await this.artifacts.delete?.(name); }
    catch (error) { if (!NOT_FOUND.test(errorText(error))) this.failed(error, 'repository removal'); }
  }
  readonly gitFetch: typeof fetch = (input, init) => fetch(input, init);
  async probe(): Promise<boolean | null> {
    try { await this.artifacts.list({ limit: 1 }); return true; }
    catch (error) { return /unauthori|forbidden|permission|not enabled|entitle|10000|10001/i.test(errorText(error)) ? false : null; }
  }
}

class Unconfigured implements ArtifactsClient {
  readonly configured = false; readonly namespace = '';
  private off(): never { fail(503, 'artifacts_unconfigured', 'Smith cannot keep its own copy of projects on this service; build straight from GitHub instead'); }
  getRepo(): Promise<ArtifactsRepo | null> { return this.off(); }
  createRepo(): Promise<ArtifactsRepo> { return this.off(); }
  branchHead(): Promise<string | null> { return this.off(); }
  issueToken(): Promise<ArtifactsToken> { return this.off(); }
  revokeToken(): Promise<void> { return this.off(); }
  deleteRepo(): Promise<void> { return this.off(); }
  readonly gitFetch: typeof fetch = () => this.off();
  async probe(): Promise<boolean | null> { return false; }
}

// In-memory fake for the Workers test runtime. Shared across the isolate so a test can seed a
// branch head or inspect issued tokens through `fakeArtifacts`.
interface FakeRepo extends ArtifactsRepo { heads: Record<string, string> }
// Repositories are keyed by account so a test can tell a copy in Smith's backend account from
// one in the workspace's own account.
const FAKE_ACCOUNT = 'bab833826312fe2b0c81bd7608a6dbf7';
export const fakeArtifacts = {
  account: FAKE_ACCOUNT, namespace: 'default', repos: new Map<string, FakeRepo>(), tokens: new Map<string, { account: string; repo: string; scope: string; revoked: boolean }>(),
  failNext: null as null | { status: number; code: string },
  entitled: true as boolean | null,   // what probe() answers: the account has Artifacts, has not, or could not be asked
  backend: { accountId: FAKE_ACCOUNT, apiToken: 'smith-backend-token' } as null | { accountId: string; apiToken: string },   // Smith's own account; null = operator set no secret
  reset(): void { this.repos.clear(); this.tokens.clear(); this.packs.clear(); this.pushRefusal = null; this.failNext = null; this.entitled = true; this.backend = { accountId: FAKE_ACCOUNT, apiToken: 'smith-backend-token' }; },
  remoteBase: '' as string,   // the drill (tools/import-e2e.mjs) points repositories at a local git server: ARTIFACTS_FAKE_REMOTE
  remote(name: string, account = FAKE_ACCOUNT): string { return this.remoteBase ? `${this.remoteBase}/${name}.git` : `https://${account}.artifacts.cloudflare.net/git/${this.namespace}/${name}.git`; },
  seed(name: string, branch: string, sha: string, account = FAKE_ACCOUNT): void { const key = account + '/' + name; const repo = this.repos.get(key) ?? { name, remote: this.remote(name, account), defaultBranch: branch, heads: {} }; repo.heads[branch] = sha; this.repos.set(key, repo); },
  // A push landing in a repository that already exists, in whichever account holds it.
  setHead(name: string, branch: string, sha: string): void { for (const repo of this.repos.values()) if (repo.name === name) repo.heads[branch] = sha; },
  // The packs pushed to each repository (remote URL -> bytes), for a test to check what arrived.
  packs: new Map<string, Uint8Array>(),
  pushRefusal: null as null | string,   // the next push is answered with this `ng` reason
};
class Fake implements ArtifactsClient {
  readonly configured = true; readonly namespace = fakeArtifacts.namespace;
  constructor(private readonly account: string) {}
  private key(name: string): string { return this.account + '/' + name; }
  private gate(): void { const next = fakeArtifacts.failNext; if (next) { fakeArtifacts.failNext = null; fail(next.status, next.code, 'fake artifacts failure'); } }
  async getRepo(name: string): Promise<ArtifactsRepo | null> { this.gate(); const repo = fakeArtifacts.repos.get(this.key(name)); return repo ? { name, remote: repo.remote, defaultBranch: repo.defaultBranch } : null; }
  async createRepo(name: string, defaultBranch: string): Promise<ArtifactsRepo> {
    this.gate(); if (fakeArtifacts.repos.has(this.key(name))) fail(502, 'artifacts_failed', 'ALREADY_EXISTS');
    const repo = { name, remote: fakeArtifacts.remote(name, this.account), defaultBranch, heads: {} }; fakeArtifacts.repos.set(this.key(name), repo); return { name, remote: repo.remote, defaultBranch };
  }
  async branchHead(name: string, branch: string): Promise<string | null> { this.gate(); return fakeArtifacts.repos.get(this.key(name))?.heads[branch] ?? null; }
  async issueToken(name: string, scope: 'read' | 'write', ttlSeconds: number): Promise<ArtifactsToken> {
    this.gate(); if (!fakeArtifacts.repos.has(this.key(name))) fail(502, 'artifacts_failed', 'NOT_FOUND');
    const id = 'tok_' + crypto.randomUUID(); const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
    fakeArtifacts.tokens.set(id, { account: this.account, repo: name, scope, revoked: false });
    return { id, plaintext: `art_v1_${'0'.repeat(28)}${scope === 'write' ? 'w' : 'r'}${id.slice(4, 15)}?expires=${expires}`, expiresAt: expires * 1000 };
  }
  async revokeToken(_repo: string, id: string): Promise<void> { this.gate(); const token = fakeArtifacts.tokens.get(id); if (token) token.revoked = true; }
  async deleteRepo(name: string): Promise<void> { this.gate(); fakeArtifacts.repos.delete(this.key(name)); }
  async probe(): Promise<boolean | null> { return fakeArtifacts.entitled; }
  // Smart HTTP the way a git server answers it: an empty advertisement (or the branches it has), and a receive-pack
  // that takes one new branch with a pack, records it as the head and keeps the pack.
  readonly gitFetch: typeof fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    const repo = [...fakeArtifacts.repos.values()].find(r => url.startsWith(r.remote));
    const pkt = (line: string) => (line.length + 4).toString(16).padStart(4, '0') + line;
    if (!repo) return new Response('not found', { status: 404 });
    if (!new Headers(init?.headers).get('Authorization')?.startsWith('Basic ')) return new Response('unauthorized', { status: 401 });
    if (url.endsWith('/info/refs?service=git-receive-pack')) {
      const heads = Object.entries(repo.heads).map(([branch, sha]) => pkt(`${sha} refs/heads/${branch}\n`)).join('');
      return new Response(pkt('# service=git-receive-pack\n') + '0000' + (heads || pkt(`${'0'.repeat(40)} capabilities^{}\0report-status\n`)) + '0000');
    }
    const body = new Uint8Array(await new Response(init?.body as BodyInit).arrayBuffer());
    const length = parseInt(new TextDecoder().decode(body.subarray(0, 4)), 16);
    const [, newSha, ref] = new TextDecoder().decode(body.subarray(4, length)).split('\0')[0].split(' ');
    const pack = body.subarray(length + 4);
    const refused = fakeArtifacts.pushRefusal; fakeArtifacts.pushRefusal = null;
    if (refused || new TextDecoder().decode(pack.subarray(0, 4)) !== 'PACK') return new Response(pkt('unpack ok\n') + pkt(`ng ${ref} ${refused ?? 'bad pack'}\n`) + '0000');
    repo.heads[ref.replace('refs/heads/', '')] = newSha; fakeArtifacts.packs.set(repo.remote, pack);
    return new Response(pkt('unpack ok\n') + pkt(`ok ${ref}\n`) + '0000');
  };
}

export function createArtifacts(env: unknown, credentials: ArtifactsCredentials): ArtifactsClient {
  const e = env as ArtifactsEnv;
  if (!artifactsConfigured(credentials)) return new Unconfigured();
  if (e.ARTIFACTS_MODE === 'fake') { fakeArtifacts.remoteBase = (e as { ARTIFACTS_FAKE_REMOTE?: string }).ARTIFACTS_FAKE_REMOTE ?? fakeArtifacts.remoteBase; return new Fake(credentials.accountId); }
  // Smith's backend account prefers the Worker's own binding (no secret to keep); a workspace's own account is REST only.
  if (credentials.source === 'smith' && credentials.binding && e.ARTIFACTS) return new BindingClient(e.ARTIFACTS, e.ARTIFACTS_NAMESPACE || 'default');
  return new RestClient(credentials.accountId, e.ARTIFACTS_NAMESPACE || 'default', credentials.apiToken);
}
