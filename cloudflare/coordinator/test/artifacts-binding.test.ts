import { describe, it, expect, vi, afterEach } from 'vitest';
import { createArtifacts, resolveArtifactsCredentials, type ArtifactsBinding } from '../src/artifacts-repos';

const ACCOUNT = 'b'.repeat(32);
const SHA = 'd45d5d166ff384710a2f63cfa24271395b689c41';
const remote = (name: string) => `https://${ACCOUNT}.artifacts.cloudflare.net/git/default/${name}.git`;

// A stand-in for the Worker's Artifacts binding, shaped like the documented API: get() throws for a missing
// or importing repository, log() answers [] for a ref it cannot resolve, and create() returns an initial token.
function binding() {
  const repos = new Map<string, { heads: Record<string, string>; importing?: boolean }>();
  const tokens = new Map<string, { repo: string; scope: string; revoked: boolean }>();
  let disposed = 0; let listError: Error | null = null;
  const handle = (name: string) => ({
    info: async () => ({ name, remote: remote(name), defaultBranch: 'main' }),
    createToken: async (scope: 'read' | 'write' = 'write', ttl = 86400) => {
      const id = crypto.randomUUID().replace(/-/g, '').slice(0, 16); tokens.set(id, { repo: name, scope, revoked: false });
      return { id, plaintext: `art_v1_${'0'.repeat(40)}?expires=${Math.floor(Date.now() / 1000) + ttl}`, scope, expiresAt: new Date(Date.now() + ttl * 1000).toISOString() };
    },
    revokeToken: async (tokenOrId: string) => { for (const [id, t] of tokens) if (id === tokenOrId || tokenOrId === 'initial-' + t.repo) t.revoked = true; return true; },
    log: async ({ ref }: { ref?: string } = {}) => { const sha = repos.get(name)!.heads[ref ?? 'main']; return sha ? [{ hash: sha }] : []; },
    [Symbol.dispose]: () => { disposed++; },
  });
  const artifacts: ArtifactsBinding = {
    async create(name, opts) {
      if (repos.has(name)) throw new Error('ALREADY_EXISTS: repository exists');
      repos.set(name, { heads: {} }); tokens.set('initial-' + name, { repo: name, scope: 'write', revoked: false });
      return { name, remote: remote(name), defaultBranch: opts?.setDefaultBranch ?? 'main', token: 'initial-' + name };
    },
    async get(name) {
      const repo = repos.get(name);
      if (!repo) throw new Error('NOT_FOUND: repository not found');
      if (repo.importing) throw new Error('IMPORT_IN_PROGRESS: repository is not ready');
      return handle(name);
    },
    async list() { if (listError) throw listError; return { repos: [], total: 0 }; },
  };
  return { artifacts, repos, tokens, disposed: () => disposed, failList: (e: Error) => { listError = e; } };
}
const backendEnv = (b: ReturnType<typeof binding>) => ({ SMITH_ARTIFACTS_ACCOUNT_ID: ACCOUNT, ARTIFACTS_NAMESPACE: 'default', ARTIFACTS: b.artifacts });

describe('Smith backend account through the Artifacts binding', () => {
  it('is configured by the binding alone, with no API token secret', () => {
    const b = binding();
    expect(resolveArtifactsCredentials(backendEnv(b), { accountId: '', apiToken: '' })).toMatchObject({ accountId: ACCOUNT, source: 'smith', binding: true });
    expect(resolveArtifactsCredentials({ SMITH_ARTIFACTS_ACCOUNT_ID: ACCOUNT }, { accountId: '', apiToken: '' })).toMatchObject({ source: 'none' });
  });
  it('creates, looks up, mints and revokes, releasing every handle', async () => {
    const b = binding(); const env = backendEnv(b);
    const client = createArtifacts(env, resolveArtifactsCredentials(env, { accountId: '', apiToken: '' }));
    expect(client.configured).toBe(true);
    expect(await client.getRepo('ws-smith')).toBeNull();
    expect(await client.createRepo('ws-smith', 'feature/x', 'Smith project')).toEqual({ name: 'ws-smith', remote: remote('ws-smith'), defaultBranch: 'feature/x' });
    expect(b.tokens.get('initial-ws-smith')?.revoked).toBe(true);   // create()'s unused write token does not stay live
    expect(await client.createRepo('ws-smith', 'main', 'again')).toMatchObject({ remote: remote('ws-smith') });   // a concurrent create is reused
    expect(await client.getRepo('ws-smith')).toMatchObject({ remote: remote('ws-smith') });
    expect(await client.branchHead('ws-smith', 'feature/x')).toBeNull();
    b.repos.get('ws-smith')!.heads['feature/x'] = SHA;
    expect(await client.branchHead('ws-smith', 'feature/x')).toBe(SHA);
    const token = await client.issueToken('ws-smith', 'read', 3600);
    expect(token.plaintext).toMatch(/^art_v1_[0-9a-f]{40}\?expires=\d+$/);
    expect(token.expiresAt).toBeGreaterThan(Date.now());
    expect(b.tokens.get(token.id)).toMatchObject({ repo: 'ws-smith', scope: 'read', revoked: false });
    await client.revokeToken('ws-smith', token.id);
    expect(b.tokens.get(token.id)?.revoked).toBe(true);
    await client.revokeToken('gone-repo', 'x');   // a deleted repository has nothing left to revoke
    expect(b.disposed()).toBeGreaterThanOrEqual(6);
  });
  it('answers busy while a repository is importing and fails a token for a missing one', async () => {
    const b = binding(); const env = backendEnv(b);
    const client = createArtifacts(env, resolveArtifactsCredentials(env, { accountId: '', apiToken: '' }));
    b.repos.set('ws-importing', { heads: {}, importing: true });
    await expect(client.getRepo('ws-importing')).rejects.toMatchObject({ status: 409, code: 'artifacts_busy' });
    await expect(client.issueToken('ws-missing', 'read', 3600)).rejects.toMatchObject({ status: 502 });
  });
  it('probes by listing: yes, no on a permission error, unknown on anything else', async () => {
    const b = binding(); const env = backendEnv(b);
    const client = createArtifacts(env, resolveArtifactsCredentials(env, { accountId: '', apiToken: '' }));
    expect(await client.probe()).toBe(true);
    b.failList(new Error('Unauthorized: Artifacts is not enabled for this account')); expect(await client.probe()).toBe(false);
    b.failList(new Error('network connection lost')); expect(await client.probe()).toBeNull();
  });
  it('keeps a workspace’s own account on the REST API', () => {
    const b = binding(); const env = backendEnv(b);
    const credentials = resolveArtifactsCredentials(env, { accountId: 'c'.repeat(32), apiToken: 'cf_test' });
    expect(credentials).toMatchObject({ source: 'workspace' });
    expect(credentials.binding).toBeUndefined();
  });
});

describe('REST client branch head', () => {
  afterEach(() => vi.restoreAllMocks());
  const client = () => createArtifacts({}, { accountId: ACCOUNT, apiToken: 'cf_test', source: 'workspace' });
  const envelope = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  it('reads the newest commit hash', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(envelope(200, { success: true, result: [{ hash: SHA }], errors: [] }));
    expect(await client().branchHead('ws-smith', 'main')).toBe(SHA);
  });
  it('treats not-found as no branch', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(envelope(404, { success: false, result: null, errors: [{ code: 10200, message: 'not found' }] }));
    expect(await client().branchHead('ws-smith', 'main')).toBeNull();
  });
  it('throws on a server error instead of reporting a missing branch', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(envelope(503, { success: false, result: null, errors: [{ code: 10400, message: 'internal' }] }));
    await expect(client().branchHead('ws-smith', 'main')).rejects.toMatchObject({ status: 502, code: 'artifacts_failed' });
  });
});
