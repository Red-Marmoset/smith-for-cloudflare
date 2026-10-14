import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitHubReadError, githubRepo, readGitHub } from '../src/github-reader';

afterEach(() => vi.restoreAllMocks());
const sha = 'b'.repeat(40);
function fakeApi(routes: Record<string, () => Response>) {
  const seen: Request[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);   // reject what real fetch rejects (e.g. redirect: 'error')
    seen.push(request);
    const route = routes[new URL(request.url).pathname + new URL(request.url).search];
    return route ? route() : new Response('{"message":"Not Found"}', { status: 404 });
  });
  return seen;
}

describe('GitHub fast path', () => {
  it('recognises GitHub HTTPS, scp and ssh URLs only', () => {
    expect(githubRepo('https://github.com/Red-Marmoset/senet.git')).toEqual({ owner: 'Red-Marmoset', repo: 'senet' });
    expect(githubRepo('git@github.com:Red-Marmoset/senet.git')).toEqual({ owner: 'Red-Marmoset', repo: 'senet' });
    expect(githubRepo('ssh://git@github.com/Red-Marmoset/smith')).toEqual({ owner: 'Red-Marmoset', repo: 'smith' });
    expect(githubRepo('https://gitlab.com/a/b.git')).toBeNull();
  });
  it('reads the default branch, its tip, the file list and smith.json', async () => {
    const seen = fakeApi({
      '/repos/o/r': () => Response.json({ default_branch: 'master' }),
      '/repos/o/r/commits/master': () => new Response(sha),
      [`/repos/o/r/git/trees/${sha}?recursive=1`]: () => Response.json({ truncated: false, tree: [{ path: 'smith.json', type: 'blob' }, { path: 'src', type: 'tree' }, { path: 'src/a.ts', type: 'blob' }] }),
      [`/repos/o/r/contents/smith.json?ref=${sha}`]: () => new Response('{"project":{"id":"r"}}'),
    });
    expect(await readGitHub('git@github.com:o/r.git', '', 'tok')).toEqual({ commit: sha, branch: 'master', smithJson: '{"project":{"id":"r"}}', paths: ['smith.json', 'src/a.ts'], truncated: false });
    expect(seen.every(request => request.redirect === 'manual' && request.headers.get('Authorization') === 'Bearer tok')).toBe(true);
  });
  it('keeps slashes in branch names and reports a missing smith.json as null', async () => {
    fakeApi({
      '/repos/o/r/commits/feature/x': () => new Response(sha),
      [`/repos/o/r/git/trees/${sha}?recursive=1`]: () => Response.json({ truncated: true, tree: [{ path: 'README.md', type: 'blob' }] }),
    });
    expect(await readGitHub('https://github.com/o/r', 'feature/x', 'tok')).toEqual({ commit: sha, branch: 'feature/x', smithJson: null, paths: ['README.md'], truncated: true });
  });
  it('reads smith.json even when GitHub cuts the file list short before reaching it', async () => {
    fakeApi({
      '/repos/o/big/commits/main': () => new Response(sha),
      [`/repos/o/big/git/trees/${sha}?recursive=1`]: () => Response.json({ truncated: true, tree: [{ path: 'Assets/a.asset', type: 'blob' }] }),
      [`/repos/o/big/contents/smith.json?ref=${sha}`]: () => new Response('{"project":{"id":"big"}}'),
    });
    expect(await readGitHub('https://github.com/o/big', 'main', 'tok')).toMatchObject({ smithJson: '{"project":{"id":"big"}}', truncated: true });
  });
  it('fails with the GitHub status so the caller can fall back to a machine', async () => {
    fakeApi({});
    await expect(readGitHub('https://github.com/o/r', 'main', 'tok')).rejects.toThrow(new GitHubReadError('GitHub answered 404 for branch main'));
  });
});
