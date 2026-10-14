import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import worker from '../src/index';
import { handleAuth } from '../src/auth';
import { errorResponse, hash } from '../src/http';
import { DEFAULT_PREFERENCES, DEFAULT_WORKSPACE_SETTINGS, parsePreferences, parseWorkspaceSettings, validatePreferences, validateWorkspaceSettings, workspaceJobEnv, crewTurnEnv } from '../src/settings';
import schema from '../migrations/0001_identity.sql?raw';
import browserSchema from '../migrations/0002_browser_auth.sql?raw';
import directorySchema from '../migrations/0003_workspace_directory.sql?raw';
import profileSchema from '../migrations/0005_account_profile.sql?raw';

const origin = 'https://exp.redmarmosetstudios.com';
const TOKEN = 'cf_test_token_1234567890abcdefghij';
beforeAll(async () => { for (const sql of [schema, browserSchema, directorySchema, profileSchema]) await env.DB.exec(sql); });

async function call(path: string, token = '', body?: unknown) {
  return worker.fetch(new Request(origin + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env);
}
async function person() {
  const token = crypto.randomUUID(); const userId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO users (id, created_at) VALUES (?, ?)').bind(userId, Date.now()),
    env.DB.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').bind(await hash(token), userId, Date.now() + 60000),
  ]);
  return { token, userId };
}
async function workspace() {
  const owner = await person();
  const created = await call('/api/v2/workspaces', owner.token, { requestId: crypto.randomUUID() });
  expect(created.status).toBe(201);
  const { workspaceId } = await created.json() as { workspaceId: string };
  const base = `/api/v2/workspaces/${workspaceId}`;
  const node = async (os = 'linux') => {
    const { code } = await (await call(base + '/enrollments', owner.token, {})).json() as { code: string };
    const enrolled = await call(base + '/nodes/enroll', '', { code, protocolVersion: 2, os });
    expect(enrolled.status).toBe(201);
    return (await enrolled.json() as { token: string }).token;
  };
  return { owner, workspaceId, base, node };
}
type Settings = Record<string, unknown> & { cloudflareApiTokenSet: boolean; name: string };

describe('settings validation', () => {
  it('merges partial preference updates and rejects unknown keys, zones and ranges', () => {
    const next = validatePreferences({ timeZone: 'Europe/London', clock: '24', logTimestamps: 'elapsed' }, DEFAULT_PREFERENCES);
    expect(next).toEqual({ ...DEFAULT_PREFERENCES, timeZone: 'Europe/London', clock: '24', logTimestamps: 'elapsed' });
    expect(() => validatePreferences({ timeZone: 'Mars/Olympus' }, DEFAULT_PREFERENCES)).toThrow(/time zone/);
    expect(() => validatePreferences({ refreshSeconds: 1 }, DEFAULT_PREFERENCES)).toThrow(/2–60/);
    expect(() => validatePreferences({ theme: 'dark' }, DEFAULT_PREFERENCES)).toThrow(/Unsupported field/);
    expect(() => validatePreferences({ logTimestamps: 'maybe' }, DEFAULT_PREFERENCES)).toThrow(/one of/);
  });
  it('tolerates stale stored preferences one key at a time', () => {
    expect(parsePreferences('{"clock":"24","legacyKey":1,"refreshSeconds":999}')).toEqual({ ...DEFAULT_PREFERENCES, clock: '24' });
    expect(parsePreferences('not json')).toEqual(DEFAULT_PREFERENCES);
    expect(parseWorkspaceSettings('{"name":"Ours","nodeOfflineSeconds":"soon"}')).toEqual({ ...DEFAULT_WORKSPACE_SETTINGS, name: 'Ours' });
  });
  it('treats a blank token as keep, validates token shape and account IDs, and never contradicts a clear', () => {
    expect(validateWorkspaceSettings({ cloudflareApiToken: '' }, DEFAULT_WORKSPACE_SETTINGS).secrets).toEqual({});
    expect(validateWorkspaceSettings({ cloudflareApiToken: ` ${TOKEN} ` }, DEFAULT_WORKSPACE_SETTINGS).secrets).toEqual({ cloudflareApiToken: TOKEN });
    expect(validateWorkspaceSettings({ clearCloudflareApiToken: true }, DEFAULT_WORKSPACE_SETTINGS).secrets).toEqual({ cloudflareApiToken: null });
    expect(() => validateWorkspaceSettings({ cloudflareApiToken: 'short' }, DEFAULT_WORKSPACE_SETTINGS)).toThrow(/Cloudflare API token/);
    expect(() => validateWorkspaceSettings({ cloudflareApiToken: TOKEN, clearCloudflareApiToken: true }, DEFAULT_WORKSPACE_SETTINGS)).toThrow(/either/);
    expect(() => validateWorkspaceSettings({ cloudflareAccountId: 'nope' }, DEFAULT_WORKSPACE_SETTINGS)).toThrow(/32 hex/);
    expect(() => validateWorkspaceSettings({ name: '   ' }, DEFAULT_WORKSPACE_SETTINGS)).toThrow(/required/);
    expect(() => validateWorkspaceSettings({ nodeOfflineSeconds: 5 }, DEFAULT_WORKSPACE_SETTINGS)).toThrow(/15–3600/);
  });
  it('maps workspace credentials onto the environment wrangler reads', () => {
    expect(workspaceJobEnv({ ...DEFAULT_WORKSPACE_SETTINGS, cloudflareAccountId: 'a'.repeat(32) }, { cloudflareApiToken: TOKEN }))
      .toEqual({ CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32) });
    expect(workspaceJobEnv(DEFAULT_WORKSPACE_SETTINGS, {})).toEqual({});
  });
  it('validates the crew settings and the Anthropic key separately from the Cloudflare token', () => {
    const current = { ...DEFAULT_WORKSPACE_SETTINGS };
    const update = validateWorkspaceSettings({ crewMayCreateProjects: true, crewMaxConcurrentRuns: 2, crewDailyUsdLimit: 25, crewStopped: false, anthropicApiKey: 'sk-ant-' + 'a'.repeat(40) }, current);
    expect(update.settings).toMatchObject({ crewMayCreateProjects: true, crewMaxConcurrentRuns: 2, crewDailyUsdLimit: 25, crewStopped: false });
    expect(update.secrets).toEqual({ anthropicApiKey: 'sk-ant-' + 'a'.repeat(40) });
    expect(() => validateWorkspaceSettings({ crewMaxConcurrentRuns: 0 }, current)).toThrow();
    expect(() => validateWorkspaceSettings({ anthropicApiKey: 'not-a-key' }, current)).toThrow();
    expect(validateWorkspaceSettings({ clearAnthropicApiKey: true }, current).secrets).toEqual({ anthropicApiKey: null });
    expect(workspaceJobEnv(current, { anthropicApiKey: 'sk-ant-x' })).toEqual({});           // builds never see it
    expect(crewTurnEnv('api-key', { anthropicApiKey: 'sk-ant-x' })).toEqual({ ANTHROPIC_API_KEY: 'sk-ant-x' });
    expect(crewTurnEnv('ollama', { anthropicApiKey: 'sk-ant-x' })).toEqual({});
    expect(crewTurnEnv('login', { anthropicApiKey: 'sk-ant-x' })).toEqual({});              // the machine's own sign-in: no key
  });
});

describe('workspace settings', () => {
  it('stores the Anthropic key write-only next to the crew settings and leaves the Cloudflare token alone', async () => {
    const w = await workspace(); const KEY = 'sk-ant-' + 'k'.repeat(40);
    const saved = await call(w.base + '/settings', w.owner.token, { anthropicApiKey: KEY, crewMaxConcurrentRuns: 3, crewStopped: true });
    expect(saved.status).toBe(200);
    const after = await saved.json() as Settings;
    expect(after).toMatchObject({ anthropicApiKeySet: true, cloudflareApiTokenSet: false, githubTokenSet: false, crewMaxConcurrentRuns: 3, crewStopped: true, crewDailyUsdLimit: 10, canEdit: true });
    expect(after.anthropicApiKeyUpdatedAt).toEqual(expect.any(Number));
    expect(JSON.stringify(after)).not.toContain(KEY);
    // A blank key keeps the stored one; clearing removes it without touching the Cloudflare token.
    expect(((await (await call(w.base + '/settings', w.owner.token, { anthropicApiKey: '' })).json()) as Settings).anthropicApiKeySet).toBe(true);
    expect(((await (await call(w.base + '/settings', w.owner.token, { clearAnthropicApiKey: true })).json()) as Settings).anthropicApiKeySet).toBe(false);
    expect((await call(w.base + '/settings', w.owner.token, { crewDailyUsdLimit: 1001 })).status).toBe(400);
  });
  it('redacts the Cloudflare token, keeps it on blank saves, clears on request and restricts writes to admins', async () => {
    const w = await workspace();
    const initial = await (await call(w.base + '/settings', w.owner.token)).json() as Settings;
    expect(initial).toMatchObject({ ...DEFAULT_WORKSPACE_SETTINGS, name: 'Workspace 1', cloudflareApiTokenSet: false });
    const saved = await call(w.base + '/settings', w.owner.token, { name: 'Marmoset builds', cloudflareApiToken: TOKEN, cloudflareAccountId: 'b'.repeat(32), nodeOfflineSeconds: 120 });
    expect(saved.status).toBe(200);
    const after = await saved.json() as Settings;
    expect(after).toMatchObject({ name: 'Marmoset builds', cloudflareApiTokenSet: true, cloudflareAccountId: 'b'.repeat(32), nodeOfflineSeconds: 120, role: 'owner', canEdit: true });
    expect(JSON.stringify(after)).not.toContain(TOKEN);
    // The workspace picker reflects the new name.
    const list = await (await call('/api/v2/workspaces', w.owner.token)).json() as { workspaces: { id: string; name: string }[] };
    expect(list.workspaces.find(item => item.id === w.workspaceId)?.name).toBe('Marmoset builds');
    // Blank token keeps the stored one; a clear removes it.
    expect(((await (await call(w.base + '/settings', w.owner.token, { cloudflareApiToken: '', supersedeQueued: true })).json()) as Settings).cloudflareApiTokenSet).toBe(true);
    expect(((await (await call(w.base + '/settings', w.owner.token, { clearCloudflareApiToken: true })).json()) as Settings).cloudflareApiTokenSet).toBe(false);
    expect((await call(w.base + '/settings', w.owner.token, { cloudflareApiToken: 'x' })).status).toBe(400);
    // An operator may read settings but not change them; a stranger sees nothing.
    const operator = await person(); const stranger = await person();
    await runInDurableObject(env.WORKSPACES.getByName(w.workspaceId), (_instance, state) => { state.storage.sql.exec('INSERT INTO members (user_id, role) VALUES (?, ?)', operator.userId, 'operator'); });
    expect(await (await call(w.base + '/settings', operator.token)).json()).toMatchObject({ role: 'operator', canEdit: false, cloudflareApiTokenSet: false });
    expect((await call(w.base + '/settings', operator.token, { name: 'Hijacked' })).status).toBe(403);
    expect((await call(w.base + '/settings', stranger.token)).status).toBe(403);
    expect(((await (await call(w.base + '/settings', w.owner.token)).json()) as Settings).name).toBe('Marmoset builds');
  });
  it('numbers new workspaces with the lowest free "Workspace N" and keeps the number after a rename', async () => {
    const owner = await person();
    const create = async () => (await (await call('/api/v2/workspaces', owner.token, { requestId: crypto.randomUUID() })).json() as { workspaceId: string }).workspaceId;
    const name = async (id: string) => ((await (await call(`/api/v2/workspaces/${id}/settings`, owner.token)).json()) as Settings).name;
    const first = await create(); const second = await create();
    expect([await name(first), await name(second)]).toEqual(['Workspace 1', 'Workspace 2']);
    // A retried create (same request ID) keeps its name rather than taking the next number.
    const requestId = crypto.randomUUID();
    const third = (await (await call('/api/v2/workspaces', owner.token, { requestId })).json() as { workspaceId: string }).workspaceId;
    expect((await (await call('/api/v2/workspaces', owner.token, { requestId })).json() as { workspaceId: string }).workspaceId).toBe(third);
    expect(await name(third)).toBe('Workspace 3');
    // Renaming frees its number for the next new workspace.
    expect((await call(`/api/v2/workspaces/${first}/settings`, owner.token, { name: 'Soccer Boy' })).status).toBe(200);
    expect(await name(await create())).toBe('Workspace 1');
  });
  it('hands the Cloudflare credentials to claimed jobs without storing them in the frozen spec', async () => {
    const w = await workspace();
    await call(w.base + '/settings', w.owner.token, { cloudflareApiToken: TOKEN, cloudflareAccountId: 'c'.repeat(32) });
    const queued = await (await call(w.base + '/jobs', w.owner.token, { requestId: 'build-1', projectId: 'smoke' })).json() as { id: string };
    const stored = await runInDurableObject(env.WORKSPACES.getByName(w.workspaceId), (_instance, state) =>
      state.storage.sql.exec<{ specs: string }>('SELECT specs FROM jobs WHERE id = ?', queued.id).one().specs);
    expect(stored).not.toContain(TOKEN);
    const nodeToken = await w.node();
    const assignment = await (await call(w.base + '/claims', nodeToken, {})).json() as { hasJob: boolean; envelope: { spec: { env: Record<string, string> } } };
    expect(assignment.hasJob).toBe(true);
    expect(assignment.envelope.spec.env).toEqual({ CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: 'c'.repeat(32) });
    // A rotated token reaches the next claim; the job list never exposes either value.
    const rotated = 'cf_rotated_token_1234567890abcdefghij';
    await call(w.base + '/settings', w.owner.token, { cloudflareApiToken: rotated });
    await call(w.base + '/jobs', w.owner.token, { requestId: 'build-2', projectId: 'smoke' });
    const second = await (await call(w.base + '/claims', await w.node(), {})).json() as { envelope: { spec: { env: Record<string, string> } } };
    expect(second.envelope.spec.env.CLOUDFLARE_API_TOKEN).toBe(rotated);
    expect(JSON.stringify(await (await call(w.base + '/jobs', w.owner.token)).json())).not.toMatch(/cf_(test|rotated)_token/);
  });
  it('replaces a still-queued build of the same target only when supersedeQueued is on, and stamps log chunks', async () => {
    const w = await workspace();
    const first = await (await call(w.base + '/jobs', w.owner.token, { requestId: 'a', projectId: 'smoke' })).json() as { id: string };
    await call(w.base + '/jobs', w.owner.token, { requestId: 'b', projectId: 'smoke' });
    expect(((await (await call(w.base + '/jobs/' + first.id, w.owner.token)).json()) as { state: string }).state).toBe('queued');
    await call(w.base + '/settings', w.owner.token, { supersedeQueued: true });
    const third = await (await call(w.base + '/jobs', w.owner.token, { requestId: 'c', projectId: 'smoke' })).json() as { id: string; state: string };
    expect(third.state).toBe('queued');
    const states = (await (await call(w.base + '/jobs', w.owner.token)).json() as { jobs: { id: string; state: string }[] }).jobs;
    expect(states.filter(job => job.state === 'cancelled')).toHaveLength(2);
    expect(states.find(job => job.id === third.id)?.state).toBe('queued');
    const before = Date.now();
    const nodeToken = await w.node();
    const { envelope } = await (await call(w.base + '/claims', nodeToken, {})).json() as { envelope: { lease: Record<string, unknown> } };
    expect((await call(w.base + '/logs', nodeToken, { ...envelope.lease, seq: 0, stream: 'stdout', lines: ['hello'] })).status).toBe(200);
    const log = await (await call(`${w.base}/jobs/${third.id}/logs?after=-1`, w.owner.token)).json() as { chunks: { at: number; lines: string[] }[] };
    expect(log.chunks).toHaveLength(1);
    expect(log.chunks[0].lines).toEqual(['hello']);
    expect(log.chunks[0].at).toBeGreaterThanOrEqual(before);
  });
});

describe('account profile', () => {
  async function auth(path: string, token: string, body?: unknown) {
    try {
      return (await handleAuth(new Request(origin + path, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }), env))!;
    } catch (error) { return errorResponse(error); }
  }
  type Identity = { user: { label: string; displayName: string; email: string; preferences: typeof DEFAULT_PREFERENCES } };
  it('stores display name, e-mail and preferences per user and reports them on /auth/me', async () => {
    const me = await person();
    const fresh = await (await auth('/auth/me', me.token)).json() as Identity;
    expect(fresh.user).toMatchObject({ label: 'Experiment workspace', displayName: '', email: '', preferences: DEFAULT_PREFERENCES });
    const updated = await auth('/auth/profile', me.token, { displayName: ' Sem ', email: 'sem@example.com', preferences: { timeZone: 'Europe/London', logTimestamps: 'iso' } });
    expect(updated.status).toBe(200);
    const after = await (await auth('/auth/me', me.token)).json() as Identity;
    expect(after.user).toMatchObject({ label: 'Sem', displayName: 'Sem', email: 'sem@example.com', preferences: { ...DEFAULT_PREFERENCES, timeZone: 'Europe/London', logTimestamps: 'iso' } });
    // Another account is untouched; bad input changes nothing.
    const other = await person();
    expect(((await (await auth('/auth/me', other.token)).json()) as Identity).user.displayName).toBe('');
    expect((await auth('/auth/profile', me.token, { email: 'not-an-address' })).status).toBe(400);
    expect((await auth('/auth/profile', me.token, { preferences: { timeZone: 'Nowhere/Land' } })).status).toBe(400);
    expect((await auth('/auth/profile', me.token, { role: 'admin' })).status).toBe(400);
    expect((await auth('/auth/profile', '', { displayName: 'x' })).status).toBe(401);
    expect(((await (await auth('/auth/me', me.token)).json()) as Identity).user.email).toBe('sem@example.com');
  });
});

describe('GitHub token setting', () => {
  it('accepts fine-grained and classic tokens, keeps them write-only, and never sends them to jobs', () => {
    const fine = 'github_pat_' + 'A1b2'.repeat(10);
    const update = validateWorkspaceSettings({ githubToken: ` ${fine} ` }, DEFAULT_WORKSPACE_SETTINGS);
    expect(update.secrets).toEqual({ githubToken: fine });
    expect(validateWorkspaceSettings({ githubToken: 'ghp_' + 'x'.repeat(36) }, DEFAULT_WORKSPACE_SETTINGS).secrets.githubToken).toBe('ghp_' + 'x'.repeat(36));
    expect(validateWorkspaceSettings({ githubToken: '' }, DEFAULT_WORKSPACE_SETTINGS).secrets).toEqual({});
    expect(validateWorkspaceSettings({ clearGithubToken: true }, DEFAULT_WORKSPACE_SETTINGS).secrets).toEqual({ githubToken: null });
    expect(() => validateWorkspaceSettings({ githubToken: 'not-a-token' }, DEFAULT_WORKSPACE_SETTINGS)).toThrow('does not look like a GitHub token');
    expect(() => validateWorkspaceSettings({ githubToken: fine, clearGithubToken: true }, DEFAULT_WORKSPACE_SETTINGS)).toThrow('either a new token or clearing');
    expect(workspaceJobEnv(DEFAULT_WORKSPACE_SETTINGS, { githubToken: fine })).toEqual({});
  });
  it('still validates the Cloudflare token the same way', () => {
    expect(() => validateWorkspaceSettings({ cloudflareApiToken: 'short' }, DEFAULT_WORKSPACE_SETTINGS)).toThrow('does not look like a Cloudflare API token');
    expect(() => validateWorkspaceSettings({ clearCloudflareApiToken: 'yes' }, DEFAULT_WORKSPACE_SETTINGS)).toThrow('Invalid field: clearCloudflareApiToken');
  });
  it('holds the Cloudflare token, the GitHub token and the Anthropic key side by side, each reaching only its own consumer', () => {
    const secrets = { cloudflareApiToken: 'cf_test_token_1234567890abcdefghij', githubToken: 'github_pat_' + 'A1b2'.repeat(10), anthropicApiKey: 'sk-ant-' + 'a'.repeat(40) };
    expect(validateWorkspaceSettings({ ...secrets }, DEFAULT_WORKSPACE_SETTINGS).secrets).toEqual(secrets);
    expect(validateWorkspaceSettings({ clearCloudflareApiToken: true, clearGithubToken: true, clearAnthropicApiKey: true }, DEFAULT_WORKSPACE_SETTINGS).secrets)
      .toEqual({ cloudflareApiToken: null, githubToken: null, anthropicApiKey: null });
    expect(() => validateWorkspaceSettings({ anthropicApiKey: 'sk-ant-short' }, DEFAULT_WORKSPACE_SETTINGS)).toThrow('does not look like an Anthropic API key');
    expect(() => validateWorkspaceSettings({ anthropicApiKey: secrets.anthropicApiKey, clearAnthropicApiKey: true }, DEFAULT_WORKSPACE_SETTINGS)).toThrow('either a new token or clearing');
    expect(workspaceJobEnv(DEFAULT_WORKSPACE_SETTINGS, secrets)).toEqual({ CLOUDFLARE_API_TOKEN: secrets.cloudflareApiToken });   // builds: the Cloudflare token only
    expect(crewTurnEnv('api-key', secrets)).toEqual({ ANTHROPIC_API_KEY: secrets.anthropicApiKey });                          // crew turns: the Anthropic key only
  });
});

describe('large files settings', () => {
  it('validates the LFS quota and keeps its default', () => {
    const current = { ...DEFAULT_WORKSPACE_SETTINGS };
    expect(DEFAULT_WORKSPACE_SETTINGS.lfsQuotaBytes).toBe(5368709120);
    expect(validateWorkspaceSettings({ lfsQuotaBytes: 1073741824 }, current).settings.lfsQuotaBytes).toBe(1073741824);
    expect(() => validateWorkspaceSettings({ lfsQuotaBytes: -1 }, current)).toThrow();
    expect(() => validateWorkspaceSettings({ lfsQuotaBytes: 1099511627777 }, current)).toThrow();
    expect(parseWorkspaceSettings('{}').lfsQuotaBytes).toBe(5368709120);
  });
});

describe('copies settings and the import threshold', () => {
  it('validates the copies settings and the import threshold', () => {
    const s = validateWorkspaceSettings({ copyBudgetBytes: 50 * 1073741824, copiesPerItem: 3, lfsImportThresholdBytes: 10 * 1048576 }, DEFAULT_WORKSPACE_SETTINGS).settings;
    expect([s.copyBudgetBytes, s.copiesPerItem, s.lfsImportThresholdBytes]).toEqual([50 * 1073741824, 3, 10 * 1048576]);
    expect(DEFAULT_WORKSPACE_SETTINGS).toMatchObject({ copyBudgetBytes: 50 * 1073741824, copiesPerItem: 2, lfsImportThresholdBytes: 10 * 1048576 });
    expect(() => validateWorkspaceSettings({ copiesPerItem: 6 }, DEFAULT_WORKSPACE_SETTINGS)).toThrow(/copiesPerItem must be 1–5/);
    expect(() => validateWorkspaceSettings({ copyBudgetBytes: 1 }, DEFAULT_WORKSPACE_SETTINGS)).toThrow(/copyBudgetBytes must be/);
    expect(() => validateWorkspaceSettings({ lfsImportThresholdBytes: 33 * 1048576 }, DEFAULT_WORKSPACE_SETTINGS)).toThrow(/lfsImportThresholdBytes must be/);
  });
});
