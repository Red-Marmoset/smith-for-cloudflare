// The Artifacts REST client against the documented API shapes
// (developers.cloudflare.com/artifacts/api/rest-api), run in the real Workers runtime so a fetch
// option the runtime rejects fails here rather than only in production.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createArtifacts } from '../src/artifacts-repos';

afterEach(() => vi.restoreAllMocks());
const ACCOUNT = 'a'.repeat(32);
const BASE = `/client/v4/accounts/${ACCOUNT}/artifacts/namespaces/default`;
const sha = 'e'.repeat(40);
const ok = (result: unknown, status = 200) => Response.json({ result, success: true, errors: [], messages: [] }, { status });
const err = (status: number, code: number, message: string) => Response.json({ result: null, success: false, errors: [{ code, message }], messages: [] }, { status });
function fakeApi(routes: Record<string, (request: Request) => Response>) {
  const seen: Request[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);   // reject what real fetch rejects (e.g. redirect: 'error')
    seen.push(request);
    const url = new URL(request.url);
    const route = routes[`${request.method} ${url.pathname}${url.search}`];
    return route ? route(request) : err(404, 10200, 'Not found');
  });
  return seen;
}
const client = () => createArtifacts({ ARTIFACTS_NAMESPACE: 'default' }, { accountId: ACCOUNT, apiToken: 'cf_token', source: 'smith' });
const repo = { id: 'repo_1', name: 'ws-smith', description: null, default_branch: 'main', created_at: '', updated_at: '', last_push_at: null, source: null, read_only: false,
  remote: `https://${ACCOUNT}.artifacts.cloudflare.net/git/default/ws-smith.git` };

describe('Artifacts REST client', () => {
  it('probes: "repository not found" means the account has Artifacts, a rejected token means it has not', async () => {
    const seen = fakeApi({});
    expect(await client().probe()).toBe(true);
    expect(seen[0].headers.get('Authorization')).toBe('Bearer cf_token');
    vi.restoreAllMocks();
    fakeApi({ [`GET ${BASE}/repos/smith-capability-check`]: () => err(403, 10000, 'Authentication error') });
    expect(await client().probe()).toBe(false);
  });
  it('looks up, creates and reads the head of a repository', async () => {
    const seen = fakeApi({
      [`GET ${BASE}/repos/ws-smith`]: () => ok(repo),
      [`POST ${BASE}/repos`]: () => ok({ ...repo, token: 'art_v1_x?expires=1760000000' }),
      [`GET ${BASE}/repos/ws-smith/log?ref=main&limit=1`]: () => ok([{ hash: sha, treeHash: 'f'.repeat(40), message: 'm', parents: [] }]),
      [`GET ${BASE}/repos/ws-smith/log?ref=gone&limit=1`]: () => ok([]),
    });
    expect(await client().getRepo('missing')).toBeNull();
    expect(await client().getRepo('ws-smith')).toEqual({ name: 'ws-smith', remote: repo.remote, defaultBranch: 'main' });
    expect((await client().createRepo('ws-smith', 'main', 'Smith')).remote).toBe(repo.remote);
    expect(await seen.at(-1)!.json()).toEqual({ name: 'ws-smith', description: 'Smith', default_branch: 'main', read_only: false });
    expect(await client().branchHead('ws-smith', 'main')).toBe(sha);
    expect(await client().branchHead('ws-smith', 'gone')).toBeNull();
  });
  it('issues and revokes repo-scoped tokens', async () => {
    fakeApi({
      [`POST ${BASE}/tokens`]: () => ok({ id: 'tok1', plaintext: 'art_v1_abc?expires=1760000000', scope: 'read', expires_at: '2025-10-09T09:06:40Z' }),
      [`DELETE ${BASE}/tokens/tok1`]: () => ok({ id: 'tok1' }),
    });
    expect(await client().issueToken('ws-smith', 'read', 3600)).toEqual({ id: 'tok1', plaintext: 'art_v1_abc?expires=1760000000', expiresAt: 1760000000000 });
    await client().revokeToken('ws-smith', 'tok1');
    await client().revokeToken('ws-smith', 'gone');
  });
  it('reports a repository still being imported as busy', async () => {
    fakeApi({ [`GET ${BASE}/repos/ws-smith`]: () => err(409, 10302, 'Import in progress') });
    await expect(client().getRepo('ws-smith')).rejects.toMatchObject({ status: 409 });
  });
});
