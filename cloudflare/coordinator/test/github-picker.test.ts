import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fakeGitHub } from '../src/github-reader';
import identity from '../migrations/0001_identity.sql?raw';
import providerTokens from '../migrations/0006_provider_tokens.sql?raw';

const ghToken = 'github_pat_' + 'Z9'.repeat(15);
const sql = (schema: string) => env.DB.exec(schema.split('\n').filter(line => line.trim() && !line.trim().startsWith('--')).join('\n'));
beforeAll(async () => { await sql(identity); await sql(providerTokens); });
beforeEach(() => fakeGitHub.reset());
// A person who linked GitHub: their user row plus the token the link produced.
async function linkGitHub(userId: string, token: string) {
  await env.DB.batch([env.DB.prepare('INSERT OR IGNORE INTO users (id, created_at) VALUES (?, ?)').bind(userId, Date.now()),
    env.DB.prepare('INSERT INTO provider_tokens (user_id, provider, access_token, refresh_token, expires_at, updated_at) VALUES (?, ?, ?, NULL, NULL, ?)').bind(userId, 'github', token, Date.now())]);
}
async function setup() {
  const id = crypto.randomUUID(); const userId = crypto.randomUUID();
  const stub = env.WORKSPACES.getByName(id);
  await stub.initialize(id, userId);
  return { stub, human: { kind: 'human' as const, userId } };
}
describe('add-project repository picker', () => {
  it('lists what the person can see through their own GitHub link, without any token in Settings', async () => {
    const f = await setup();
    expect(await (await f.stub.execute(f.human, 'github-repos', {})).json()).toMatchObject({ configured: false, reason: 'link', repos: [] });
    await linkGitHub(f.human.userId, 'sem-link-token');
    fakeGitHub.installedFor.add('sem-link-token');
    fakeGitHub.repos.set('cranium-software/engine', { defaultBranch: 'main', visibleTo: ['sem-link-token'], branches: { main: { commit: 'a'.repeat(40), smithJson: null, paths: [], truncated: false } } });
    fakeGitHub.repos.set('semiessessi/dotfiles', { defaultBranch: 'main', private: false, visibleTo: ['sem-link-token'], branches: { main: { commit: 'b'.repeat(40), smithJson: null, paths: [], truncated: false } } });
    fakeGitHub.repos.set('someone-else/private', { defaultBranch: 'main', visibleTo: ['other-token'], branches: { main: { commit: 'c'.repeat(40), smithJson: null, paths: [], truncated: false } } });
    const mine = await (await f.stub.execute(f.human, 'github-repos', {})).json() as { configured: boolean; via: string; installed: boolean; repos: { fullName: string }[] };
    expect(mine).toMatchObject({ configured: true, via: 'link', installed: true });
    expect(mine.repos.map(r => r.fullName).sort()).toEqual(['cranium-software/engine', 'semiessessi/dotfiles']);
    // Another member sees their own repositories, not Sem's.
    const other = { kind: 'human' as const, userId: crypto.randomUUID() };
    await runInDurableObject(f.stub, (_object, state) => { state.storage.sql.exec('INSERT INTO members (user_id, role) VALUES (?, ?)', other.userId, 'admin'); });
    await linkGitHub(other.userId, 'other-token');
    const theirs = await (await f.stub.execute(other, 'github-repos', {})).json() as { installed: boolean; repos: { fullName: string }[] };
    expect(theirs.repos.map(r => r.fullName)).toEqual(['someone-else/private']);
    expect(theirs.installed).toBe(false);
  });
  it('falls back to the workspace Settings token for people who have not linked GitHub', async () => {
    const f = await setup();
    await f.stub.execute(f.human, 'put-settings', { githubToken: ghToken });
    fakeGitHub.repos.set('Red-Marmoset/senet', { defaultBranch: 'master', branches: { master: { commit: 'd'.repeat(40), smithJson: null, paths: [], truncated: false }, dev: { commit: 'e'.repeat(40), smithJson: null, paths: [], truncated: false } } });
    fakeGitHub.repos.set('Red-Marmoset/public-demo', { defaultBranch: 'main', private: false, branches: { main: { commit: 'f'.repeat(40), smithJson: null, paths: [], truncated: false } } });
    const repos = await (await f.stub.execute(f.human, 'github-repos', {})).json() as { configured: boolean; via: string; repos: { fullName: string; url: string; defaultBranch: string; private: boolean }[] };
    expect(repos).toMatchObject({ configured: true, via: 'settings' });
    expect(repos.repos).toEqual(expect.arrayContaining([
      { fullName: 'Red-Marmoset/senet', url: 'git@github.com:Red-Marmoset/senet.git', defaultBranch: 'master', private: true, pushedAt: '', description: '', archived: false, sizeKb: 0 },
      { fullName: 'Red-Marmoset/public-demo', url: 'https://github.com/Red-Marmoset/public-demo.git', defaultBranch: 'main', private: false, pushedAt: '', description: '', archived: false, sizeKb: 0 },
    ]));
    const branches = await (await f.stub.execute(f.human, 'github-branches', { repo: 'Red-Marmoset/senet' })).json() as { branches: string[] };
    expect(branches.branches.sort()).toEqual(['dev', 'master']);
    expect((await f.stub.execute(f.human, 'github-branches', { repo: 'not a repo' })).status).toBe(400);
    expect((await f.stub.execute(f.human, 'github-branches', { repo: 'Red-Marmoset/missing' })).status).toBe(502);
    fakeGitHub.failNext = 'GitHub answered 401 when listing repositories';
    expect((await f.stub.execute(f.human, 'github-repos', {})).status).toBe(502);
  });
  it('is limited to people who may add projects', async () => {
    const f = await setup();
    await runInDurableObject(f.stub, (_object, state) => { state.storage.sql.exec('UPDATE members SET role = ?', 'operator'); });
    expect((await f.stub.execute(f.human, 'github-repos', {})).status).toBe(403);
    expect((await f.stub.execute(f.human, 'github-branches', { repo: 'a/b' })).status).toBe(403);
  });
});
