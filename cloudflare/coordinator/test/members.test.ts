import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import worker from '../src/index';
import { hash } from '../src/http';
import identity from '../migrations/0001_identity.sql?raw';
import browser from '../migrations/0002_browser_auth.sql?raw';
import directory from '../migrations/0003_workspace_directory.sql?raw';
import profile from '../migrations/0005_account_profile.sql?raw';
import studio from '../migrations/0007_studio_access.sql?raw';

const origin = 'https://exp.redmarmosetstudios.com';
// D1's exec runs one statement per line and rejects comment-only lines (wrangler's migration runner does not).
beforeAll(async () => { for (const schema of [identity, browser, directory, profile, studio]) await env.DB.exec(schema.split('\n').filter(line => line.trim() && !line.trim().startsWith('--')).join('\n')); });

async function call(path: string, token: string, body?: unknown) {
  return worker.fetch(new Request(origin + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env);
}
// `domain` is what their last Google sign-in proved (users.google_domain, set by oauth.ts).
async function person(name: string, domain: string | null = null) {
  const token = crypto.randomUUID(); const userId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO users (id, created_at, display_name, google_domain) VALUES (?, ?, ?, ?)').bind(userId, Date.now(), name, domain),
    env.DB.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').bind(await hash(token), userId, Date.now() + 600000),
  ]);
  return { token, userId };
}
type Who = { token: string; userId: string };
async function workspace() {
  const owner = await person('Owner', 'redmarmosetstudios.com');
  const created = await call('/api/v2/workspaces', owner.token, { requestId: crypto.randomUUID() });
  expect(created.status).toBe(201);
  const { workspaceId } = await created.json() as { workspaceId: string };
  return { owner, workspaceId, base: `/api/v2/workspaces/${workspaceId}` };
}
const listed = async (who: Who) => ((await (await call('/api/v2/workspaces', who.token)).json()) as { workspaces: { id: string }[] }).workspaces.map(w => w.id);
type MemberList = { members: { userId: string; role: string; via: string; name: string; you: boolean }[]; removed: { userId: string; name: string }[]; canManage: boolean };
const members = async (base: string, who: Who) => (await call(base + '/members', who.token)).json() as Promise<MemberList>;
const roleOf = async (base: string, owner: Who, who: Who) => (await members(base, owner)).members.find(m => m.userId === who.userId);
const studioAccess = async (base: string, owner: Who, value: string) => expect((await call(base + '/settings', owner.token, { studioAccess: value })).status).toBe(200);

describe('workspace members and Studio access', () => {
  it('lets studio Google accounts join a workspace shared with the studio, with the role it names', async () => {
    const { owner, workspaceId, base } = await workspace();
    const alex = await person('Alex', 'redmarmosetstudios.com');
    const outsider = await person('Outsider');
    const elsewhere = await person('Elsewhere', 'example.com');
    expect(await listed(alex)).not.toContain(workspaceId);   // off by default
    expect((await call(base + '/jobs', alex.token)).status).toBe(403);

    await studioAccess(base, owner, 'operator');
    expect(await listed(alex)).toContain(workspaceId);
    expect(await listed(outsider)).not.toContain(workspaceId);
    expect(await listed(elsewhere)).not.toContain(workspaceId);
    expect((await call(base + '/jobs', alex.token)).status).toBe(200);
    expect(await roleOf(base, owner, alex)).toMatchObject({ role: 'operator', via: 'studio', name: 'Alex', you: false });
    expect((await members(base, owner)).members.find(m => m.you)).toMatchObject({ userId: owner.userId, role: 'owner', via: 'added' });

    // A new Studio access role applies to everyone who joined through it; turning it off removes them.
    await studioAccess(base, owner, 'viewer');
    expect(await roleOf(base, owner, alex)).toMatchObject({ role: 'viewer', via: 'studio' });
    await studioAccess(base, owner, 'off');
    expect(await roleOf(base, owner, alex)).toBeUndefined();
    expect(await listed(alex)).not.toContain(workspaceId);
    expect((await call(base + '/jobs', alex.token)).status).toBe(403);
  });

  it('pins a role an admin sets by hand, so Studio access changes leave it alone', async () => {
    const { owner, base } = await workspace();
    const sam = await person('Sam', 'redmarmosetstudios.com');
    await studioAccess(base, owner, 'viewer');
    await listed(sam);
    const set = await call(`${base}/members/${sam.userId}`, owner.token, { role: 'admin' });
    expect(set.status).toBe(200);
    await studioAccess(base, owner, 'off');
    expect(await roleOf(base, owner, sam)).toMatchObject({ role: 'admin', via: 'added' });
    // An admin manages members, but only an owner changes ownership.
    const pat = await person('Pat', 'redmarmosetstudios.com');
    await studioAccess(base, owner, 'operator'); await listed(pat);
    expect((await call(`${base}/members/${pat.userId}`, sam.token, { role: 'viewer' })).status).toBe(200);
    expect((await call(`${base}/members/${pat.userId}`, sam.token, { role: 'owner' })).status).toBe(403);
    expect((await call(`${base}/members/${owner.userId}`, sam.token, { role: 'viewer' })).status).toBe(403);
    expect((await call(`${base}/members/${owner.userId}/remove`, sam.token, {})).status).toBe(403);
    // Only owners and admins change roles; nobody sets an unknown one.
    expect((await call(`${base}/members/${sam.userId}`, pat.token, { role: 'viewer' })).status).toBe(403);
    expect((await call(`${base}/members/${pat.userId}`, owner.token, { role: 'boss' })).status).toBe(400);
  });

  it('keeps someone who was removed out until an admin lets them back', async () => {
    const { owner, workspaceId, base } = await workspace();
    const kim = await person('Kim', 'redmarmosetstudios.com');
    await studioAccess(base, owner, 'operator');
    expect(await listed(kim)).toContain(workspaceId);
    expect((await call(`${base}/members/${kim.userId}/remove`, owner.token, {})).status).toBe(200);
    expect(await listed(kim)).not.toContain(workspaceId);
    expect((await call(base + '/jobs', kim.token)).status).toBe(403);
    expect((await members(base, owner)).removed).toEqual([expect.objectContaining({ userId: kim.userId, name: 'Kim' })]);
    expect((await call(`${base}/members/${kim.userId}/allow`, owner.token, {})).status).toBe(200);
    expect((await members(base, owner)).removed).toEqual([]);
    expect(await listed(kim)).toContain(workspaceId);
  });

  it('lets anyone leave, but never leaves a workspace without an owner', async () => {
    const { owner, workspaceId, base } = await workspace();
    const lee = await person('Lee', 'redmarmosetstudios.com');
    await studioAccess(base, owner, 'viewer'); await listed(lee);
    const asViewer = await members(base, lee);
    expect(asViewer.canManage).toBe(false);
    expect(asViewer.removed).toEqual([]);
    expect((await call(`${base}/members/${lee.userId}/remove`, lee.token, {})).status).toBe(200);
    expect(await listed(lee)).not.toContain(workspaceId);   // and stays out: leaving counts as removal

    expect((await call(`${base}/members/${owner.userId}/remove`, owner.token, {})).status).toBe(409);
    expect((await call(`${base}/members/${owner.userId}`, owner.token, { role: 'admin' })).status).toBe(409);
    const kit = await person('Kit', 'redmarmosetstudios.com');
    await listed(kit);
    expect((await call(`${base}/members/${kit.userId}`, owner.token, { role: 'owner' })).status).toBe(200);
    expect((await call(`${base}/members/${owner.userId}/remove`, owner.token, {})).status).toBe(200);
    expect(await roleOf(base, kit, kit)).toMatchObject({ role: 'owner' });
  });

  it('refuses a malformed member path or body', async () => {
    const { owner, base } = await workspace();
    expect((await call(`${base}/members/not%20an%20id`, owner.token, { role: 'viewer' })).status).toBe(404);
    expect((await call(`${base}/members/${crypto.randomUUID()}`, owner.token, { role: 'viewer' })).status).toBe(404);
    expect((await call(`${base}/members/${owner.userId}/remove`, owner.token, { role: 'viewer' })).status).toBe(400);
  });
});
