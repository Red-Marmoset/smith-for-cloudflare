import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import worker from '../src/index';
import { fakeGitHub } from '../src/github-reader';
import { setup, origin } from './lfs-fixture';
import schema from '../migrations/0001_identity.sql?raw';
import browserSchema from '../migrations/0002_browser_auth.sql?raw';
import directorySchema from '../migrations/0003_workspace_directory.sql?raw';

beforeAll(async () => { await env.DB.exec(schema); await env.DB.exec(browserSchema); await env.DB.exec(directorySchema); });
beforeEach(() => fakeGitHub.reset());
const MiB = 1048576;
function seedOrg() {
  fakeGitHub.orgs.set('Red-Marmoset', { repos: ['Red-Marmoset/senet', 'Red-Marmoset/soccer-boy', 'Red-Marmoset/old-site'] });
  fakeGitHub.repos.set('Red-Marmoset/senet', { defaultBranch: 'master', branches: { master: { commit: 'a'.repeat(40), smithJson: null, paths: ['a.txt'], truncated: false } } });
  fakeGitHub.repos.set('Red-Marmoset/soccer-boy', { defaultBranch: 'main', branches: { main: { commit: 'b'.repeat(40), smithJson: null, paths: ['Assets/big.psd', 'Assets/huge.mp4'], truncated: false } }, sizes: { main: { 'Assets/big.psd': 15 * MiB, 'Assets/huge.mp4': 40 * MiB } }, sizeKb: 400000 });
  fakeGitHub.repos.set('Red-Marmoset/old-site', { defaultBranch: 'main', branches: { main: { commit: 'c'.repeat(40), smithJson: null, paths: [], truncated: true } }, archived: true });
}

describe('Import from GitHub listing', () => {
  it('lists the organisations and their repositories with sizes, archive flags, what is in Smith and the preflight', async () => {
    const f = await setup(); seedOrg();
    await f.stub.execute(f.human, 'put-settings', { githubToken: 'ghp_' + 'x'.repeat(30) });
    const orgs = await (await f.stub.execute(f.human, 'import-orgs', {})).json() as { configured: boolean; orgs: { login: string }[] };
    expect([orgs.configured, orgs.orgs.map(o => o.login)]).toEqual([true, ['Red-Marmoset']]);
    const listed = await (await f.stub.execute(f.human, 'import-repos', { org: 'Red-Marmoset', thresholdBytes: 10 * MiB })).json() as { repos: { fullName: string; archived: boolean; inSmith: string | null; large: { count: number; largest: number; over32: number; truncated: boolean } | null }[]; totalKb: number };
    expect(listed.repos.map(r => [r.fullName, r.archived, r.inSmith, r.large])).toEqual([
      ['Red-Marmoset/senet', false, 'senet', { count: 0, largest: 0, over32: 0, truncated: false }],   // the fixture project's repoUrl
      ['Red-Marmoset/soccer-boy', false, null, { count: 2, largest: 40 * MiB, over32: 1, truncated: false }],
      ['Red-Marmoset/old-site', true, null, { count: 0, largest: 0, over32: 0, truncated: true }],
    ]);
    expect(listed.totalKb).toBe(400000);
  });
  it('says what to do when no token can see the organisation', async () => {
    const f = await setup(); seedOrg();
    const none = await (await f.stub.execute(f.human, 'import-orgs', {})).json() as { configured: boolean; reason: string };
    expect([none.configured, none.reason]).toEqual([false, 'link']);
    await f.stub.execute(f.human, 'put-settings', { githubToken: 'ghp_' + 'y'.repeat(30) });
    fakeGitHub.orgs.set('Red-Marmoset', { repos: ['Red-Marmoset/senet'], visibleTo: ['other-token'] });
    const refused = await f.stub.execute(f.human, 'import-repos', { org: 'Red-Marmoset', thresholdBytes: 10 * MiB });
    expect(refused.status).toBe(502);
    expect(((await refused.json()) as { error: { message: string } }).error.message).toContain('cannot see the organisation Red-Marmoset');
  });
  it('is for admins only, and its routes exist', async () => {
    const f = await setup(); seedOrg();
    const operator = crypto.randomUUID();
    await runInDurableObject(f.stub, (_o, state) => { state.storage.sql.exec('INSERT INTO members (user_id, role) VALUES (?, ?)', operator, 'operator'); });
    expect((await f.stub.execute({ kind: 'human', userId: operator }, 'import-orgs', {})).status).toBe(403);
    expect((await f.stub.execute({ kind: 'human', userId: operator }, 'import-repos', { org: 'Red-Marmoset', thresholdBytes: 10 * MiB })).status).toBe(403);
    // The routes answer 401 to nobody, not 404.
    for (const path of ['imports/github/orgs', 'imports/github/repos?org=Red-Marmoset']) expect((await worker.fetch(new Request(`${origin}/api/v2/workspaces/${f.workspaceId}/${path}`), env)).status).toBe(401);
  });
});
