import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import worker from '../src/index';
import { fakeGitHub } from '../src/github-reader';
import { fakeHooks, parsePush, signPayload, verifySignature } from '../src/push-builds';
import { mapPipeline, parseSmithJson } from '../src/pipeline';
import identity from '../migrations/0001_identity.sql?raw';
import providerTokens from '../migrations/0006_provider_tokens.sql?raw';

const commit = 'a'.repeat(40); const newer = 'b'.repeat(40);
const sql = (schema: string) => env.DB.exec(schema.split('\n').filter(line => line.trim() && !line.trim().startsWith('--')).join('\n'));
beforeAll(async () => { await sql(identity); await sql(providerTokens); });
beforeEach(() => { fakeGitHub.reset(); fakeHooks.reset(); });

// Smith's own smith.json shape: one product the webhook trigger names, one it does not, on feature/cloudflare-experiment.
const smithJson = (triggers: object[] = [{ type: 'webhook', branches: ['feature/cloudflare-experiment'], product: 'deploy-experiment' }]) => JSON.stringify({
  schemaVersion: 1, project: { id: 'smith', name: 'Smith' },
  buildProducts: [
    { name: 'build', rules: [{ name: 'build-release', branches: ['*'], command: { windows: { interpreter: 'ps1', script: 'Build.ps1' }, linux: { interpreter: 'sh', script: 'Build.sh' } } }] },
    { name: 'deploy-experiment', rules: [{ name: 'deploy', branches: ['feature/cloudflare-experiment'], serial: true, nodeSelector: { labels: ['smith-deploy'] }, command: { windows: { interpreter: 'bat', script: 'DeployWorker.bat', args: ['--unattended'] } } }] },
    { name: 'tray', rules: [{ name: 'build-tray', branches: ['*'], command: { windows: { interpreter: 'ps1', script: 'Build.ps1' } }, handoff: [{ name: 'ship', type: 'steam' }] }] },
    { name: 'installer', rules: [{ name: 'pack', branches: ['*'], inputs: [{ product: 'build' }], command: { windows: { interpreter: 'ps1', script: 'Pack.ps1' } } }] },
  ],
  triggers,
});
type PublicProject = { id: string; branch: string; commit: string | null; onPush: string[]; actions: { id: string; notes: string[] }[]; push: { enabled: boolean; via: string; registered: boolean; message: string; lastDelivery: { outcome: string; jobIds: string[]; commit: string } | null } | null; scan: { state: string }; warnings: string[] };
type Job = { id: string; state: string; product: string; projectId: string; secretless: boolean };

async function linkGitHub(userId: string, token: string) {
  await env.DB.batch([env.DB.prepare('INSERT OR IGNORE INTO users (id, created_at) VALUES (?, ?)').bind(userId, Date.now()),
    env.DB.prepare('INSERT INTO provider_tokens (user_id, provider, access_token, refresh_token, expires_at, updated_at) VALUES (?, ?, ?, NULL, NULL, ?)').bind(userId, 'github', token, Date.now())]);
}
// Workspace IDs are SHA-256 hashes (index.ts); the hook route only admits that shape.
const workspaceIdHex = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
async function setup(linked = true) {
  const id = workspaceIdHex(); const userId = crypto.randomUUID();
  const stub = env.WORKSPACES.getByName(id);
  await stub.initialize(id, userId);
  const human = { kind: 'human' as const, userId };
  const token = 'link-' + userId.slice(0, 8);
  if (linked) await linkGitHub(userId, token);
  fakeGitHub.repos.set('Red-Marmoset/smith', { defaultBranch: 'main', branches: { 'feature/cloudflare-experiment': { commit, smithJson: smithJson(), paths: [], truncated: false }, main: { commit, smithJson: smithJson(), paths: [], truncated: false } } });
  const added = await (await stub.execute(human, 'add-repo-project', { source: 'git', url: 'git@github.com:Red-Marmoset/smith.git', branch: 'feature/cloudflare-experiment' })).json() as PublicProject;
  const project = async () => (await (await stub.execute(human, 'projects', {})).json() as { projects: PublicProject[] }).projects.find(p => p.id === added.id)!;
  const jobs = async () => (await (await stub.execute(human, 'list', {})).json() as { jobs: Job[] }).jobs;
  const toggle = (enabled: boolean) => stub.execute(human, 'push-builds', { projectId: added.id, enabled });
  const deliver = async (payload: object, extra: { event?: string; secret?: string; signature?: string; deliveryId?: string } = {}) => {
    const body = JSON.stringify(payload);
    const secret = extra.secret ?? await runInDurableObject(stub, (_object, state) => (JSON.parse(state.storage.sql.exec<{ definition: string }>('SELECT definition FROM projects WHERE id = ?', added.id).one().definition) as { push?: { secret: string } }).push?.secret ?? '');
    return stub.execute({ kind: 'hook' }, 'push-delivery', { projectId: added.id, event: extra.event ?? 'push', deliveryId: extra.deliveryId ?? crypto.randomUUID(), signature: extra.signature ?? await signPayload(secret, body), payload: body });
  };
  return { id, stub, human, token, added, project, jobs, toggle, deliver };
}
const pushOf = (branch: string, after: string, extra: object = {}) => ({ ref: `refs/heads/${branch}`, before: commit, after, deleted: false, forced: false, repository: { full_name: 'Red-Marmoset/smith' }, ...extra });

describe('smith.json webhook triggers', () => {
  it('are kept by the parser and mapped to the actions a push builds', () => {
    const config = parseSmithJson(smithJson([{ type: 'poll', branches: ['main'], intervalSeconds: 120, product: 'build' }, { type: 'webhook', product: 'build' }, { type: 'manual' }]));
    expect(config.triggers).toEqual([{ type: 'poll', branches: ['main'], product: 'build' }, { type: 'webhook', branches: [], product: 'build' }, { type: 'manual', branches: [], product: '' }]);
    // Only webhook triggers build on a push; poll and schedule are not run here. A trigger with no branches applies to every branch.
    expect(mapPipeline(smithJson([{ type: 'webhook', product: 'build' }]), [], 'main').onPush).toEqual(['build']);
    expect(mapPipeline(smithJson([{ type: 'poll', product: 'build' }]), [], 'main').onPush).toEqual([]);
    // Branch filters follow LAN's glob matching; a product that does not build on the branch is a warning, not a build.
    expect(mapPipeline(smithJson(), [], 'main').onPush).toEqual([]);
    const other = mapPipeline(smithJson([{ type: 'webhook', branches: ['main'], product: 'deploy-experiment' }]), [], 'main');
    expect(other.onPush).toEqual([]);
    expect(other.warnings).toEqual([expect.stringContaining('does not build on main')]);
    // A trigger without a product builds the first product (HandleWebhook's fallback); duplicates collapse; an unavailable action is reported.
    const several = mapPipeline(smithJson([{ type: 'webhook' }, { type: 'webhook', product: 'build' }, { type: 'webhook', product: 'tray' }, { type: 'webhook', product: 'installer' }]), [], 'feature/x');
    expect(several.onPush).toEqual(['build', 'tray']);
    expect(several.warnings).toEqual([expect.stringContaining('"installer" cannot run here')]);
    expect(mapPipeline(smithJson(), [], 'feature/cloudflare-experiment').onPush).toEqual(['deploy-experiment']);
  });
  it('signs and verifies deliveries the way GitHub does, and reads a push', async () => {
    const body = '{"ref":"refs/heads/main"}';
    const signature = await signPayload('s3cret', body);
    expect(signature).toMatch(/^sha256=[a-f0-9]{64}$/);
    expect(await verifySignature('s3cret', body, signature)).toBe(true);
    expect(await verifySignature('s3cret', body + ' ', signature)).toBe(false);
    expect(await verifySignature('other', body, signature)).toBe(false);
    expect(await verifySignature('s3cret', body, null)).toBe(false);
    expect(await verifySignature('', body, signature)).toBe(false);
    expect(parsePush(pushOf('feature/x', newer))).toEqual({ branch: 'feature/x', commit: newer, deleted: false, forced: false });
    expect(parsePush({ ref: 'refs/tags/v1', after: newer })).toMatchObject({ branch: null });
    expect(parsePush({ ref: 'refs/heads/gone', after: '0'.repeat(40), deleted: true })).toMatchObject({ branch: 'gone', deleted: true, commit: '' });
    expect(parsePush('junk')).toEqual({ branch: null, commit: '', deleted: false, forced: false });
  });
});

describe('Build on push', () => {
  it('registers the hook on GitHub through the person’s link, hides the secret, and builds what the triggers name', async () => {
    const f = await setup();
    expect((await f.project()).onPush).toEqual(['deploy-experiment']);
    expect((await f.project()).push).toBeNull();
    const on = await f.toggle(true);
    expect(on.status).toBe(200);
    const result = await on.json() as { project: PublicProject; url: string; secret?: string };
    expect(result.url).toBe(`https://exp.redmarmosetstudios.com/api/v2/hooks/github/${f.id}/${f.added.id}`);
    expect(result.secret).toBeUndefined();   // Smith registered it: nobody needs the secret
    expect(result.project.push).toMatchObject({ enabled: true, via: 'github', registered: true, message: '', lastDelivery: null });
    expect(JSON.stringify(result.project)).not.toContain('secret');
    const hook = fakeHooks.hooks.get('Red-Marmoset/smith')![0];
    expect(hook).toMatchObject({ url: result.url, active: true });
    expect(hook.secret.length).toBeGreaterThan(40);
    // A ping (GitHub sends one on registration) is answered without building.
    expect(await (await f.deliver({ zen: 'Keep it logically awesome.', hook_id: hook.id }, { event: 'ping' })).json()).toEqual({ accepted: true, reason: 'pong' });
    expect(await f.jobs()).toEqual([]);
    // A push to the branch: smith.json is re-read at the new commit and the trigger's product is queued as a branch-tip build.
    fakeGitHub.repos.get('Red-Marmoset/smith')!.branches['feature/cloudflare-experiment'] = { commit: newer, smithJson: smithJson(), paths: [], truncated: false };
    const pushed = await f.deliver(pushOf('feature/cloudflare-experiment', newer));
    expect(pushed.status).toBe(202);
    const outcome = await pushed.json() as { accepted: boolean; reason: string; jobIds: string[] };
    expect(outcome).toMatchObject({ accepted: true, reason: 'queued 1 build (deploy-experiment)' });
    const jobs = await f.jobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ id: outcome.jobIds[0], state: 'queued', product: 'deploy-experiment', projectId: f.added.id, secretless: false });
    const after = await f.project();
    expect(after.commit).toBe(newer);
    expect(after.push?.lastDelivery).toMatchObject({ outcome: 'queued 1 build (deploy-experiment)', jobIds: outcome.jobIds, commit: newer });
    // The queued build is claimable by a Windows machine with the rule's label.
    const { code } = await (await f.stub.execute(f.human, 'enrollments', {})).json() as { code: string };
    const { token } = await (await f.stub.execute({ kind: 'enrollment' }, 'enroll', { code, protocolVersion: 2, os: 'windows', hostname: 'DEPLOY-PC', arch: 'x64', labels: ['smith-repo-projects', 'smith-deploy'], agentVersion: '0.2.0' })).json() as { token: string };
    const claim = await (await f.stub.execute({ kind: 'node', token }, 'claim', {})).json() as { hasJob: boolean; envelope: { spec: { repos: { branch: string; commit: string }[]; resolve: { action: string } } } };
    expect(claim.hasJob).toBe(true);
    expect(claim.envelope.spec.resolve).toEqual({ action: 'deploy-experiment' });
    expect(claim.envelope.spec.repos[0]).toMatchObject({ branch: 'feature/cloudflare-experiment', commit: '' });   // branch tip, as every repository build
  });
  it('refuses a bad signature, ignores other branches, tags and deletions, and stops when turned off', async () => {
    const f = await setup();
    await f.toggle(true);
    expect((await f.deliver(pushOf('feature/cloudflare-experiment', newer), { secret: 'wrong' })).status).toBe(401);
    expect((await f.deliver(pushOf('feature/cloudflare-experiment', newer), { signature: '' })).status).toBe(401);
    expect(await (await f.deliver(pushOf('main', newer))).json()).toMatchObject({ accepted: false, reason: 'ignored: push to main, this project builds feature/cloudflare-experiment' });
    expect(await (await f.deliver({ ref: 'refs/tags/v1', after: newer })).json()).toMatchObject({ accepted: false, reason: 'ignored: not a branch push' });
    expect(await (await f.deliver(pushOf('feature/cloudflare-experiment', '0'.repeat(40), { deleted: true }))).json()).toMatchObject({ accepted: false, reason: 'ignored: branch deleted' });
    expect(await (await f.deliver({ action: 'opened' }, { event: 'pull_request' })).json()).toMatchObject({ accepted: false, reason: 'ignored: pull_request event' });
    expect(await f.jobs()).toEqual([]);
    expect((await f.project()).push?.lastDelivery).toMatchObject({ outcome: 'ignored: branch deleted' });
    // Off: the hook is removed from GitHub and deliveries are refused; the secret is gone with it.
    const off = await (await f.toggle(false)).json() as { project: PublicProject };
    expect(off.project.push).toBeNull();
    expect(fakeHooks.hooks.get('Red-Marmoset/smith')).toEqual([]);
    expect((await f.deliver(pushOf('feature/cloudflare-experiment', newer), { secret: 'anything' })).status).toBe(404);
  });
  it('falls back to a hand-added hook, with the URL and secret shown once, when no GitHub link can register it', async () => {
    // Nobody linked GitHub (the project waits for a machine to read it): the hook can only be added by hand.
    const f = await setup(false);
    const on = await (await f.toggle(true)).json() as { project: PublicProject; url: string; secret?: string };
    expect(on.project.push).toMatchObject({ enabled: true, via: 'manual', registered: false, message: expect.stringContaining('nobody in the workspace has linked GitHub') });
    expect(on.secret).toMatch(/^[a-f0-9-]{72,}$/);
    expect(fakeHooks.hooks.size).toBe(0);
    expect(JSON.stringify(await f.project())).not.toContain(on.secret!);
    // A push before smith.json has been read builds nothing, and says so.
    expect(await (await f.deliver(pushOf('feature/cloudflare-experiment', newer), { secret: on.secret })).json()).toMatchObject({ accepted: false, reason: expect.stringContaining('nothing built') });
    // A link that GitHub refuses (no admin on the repository) also ends in the manual fallback, naming GitHub's answer;
    // deliveries signed with the shown secret build all the same.
    const g = await setup();
    fakeHooks.refuse.add(g.token);
    const refused = await (await g.toggle(true)).json() as { project: PublicProject; secret?: string };
    expect(refused.project.push).toMatchObject({ via: 'manual', message: expect.stringContaining('GitHub answered 404') });
    expect(refused.secret).toBeDefined();
    expect((await g.deliver(pushOf('feature/cloudflare-experiment', newer), { secret: refused.secret })).status).toBe(202);
    expect(await g.jobs()).toHaveLength(1);
  });
  it('builds once per burst when the workspace supersedes queued builds, and reports a trigger that names nothing', async () => {
    const f = await setup();
    await f.toggle(true);
    await f.stub.execute(f.human, 'put-settings', { supersedeQueued: true });
    const first = await (await f.deliver(pushOf('feature/cloudflare-experiment', newer))).json() as { jobIds: string[] };
    const second = await (await f.deliver(pushOf('feature/cloudflare-experiment', 'c'.repeat(40)))).json() as { jobIds: string[] };
    const jobs = await f.jobs();
    expect(jobs.find(j => j.id === first.jobIds[0])?.state).toBe('cancelled');
    expect(jobs.find(j => j.id === second.jobIds[0])?.state).toBe('queued');
    // The same delivery redelivered (GitHub's Redeliver) does not queue twice.
    const again = await f.deliver(pushOf('feature/cloudflare-experiment', 'c'.repeat(40)), { deliveryId: 'fixed-delivery' });
    const repeat = await f.deliver(pushOf('feature/cloudflare-experiment', 'c'.repeat(40)), { deliveryId: 'fixed-delivery' });
    expect((await repeat.json() as { jobIds: string[] }).jobIds).toEqual((await again.json() as { jobIds: string[] }).jobIds);
    // smith.json at the pushed commit drops the trigger: nothing is built, and the card says so.
    fakeGitHub.repos.get('Red-Marmoset/smith')!.branches['feature/cloudflare-experiment'] = { commit: 'd'.repeat(40), smithJson: smithJson([{ type: 'manual' }]), paths: [], truncated: false };
    expect(await (await f.deliver(pushOf('feature/cloudflare-experiment', 'd'.repeat(40)))).json()).toMatchObject({ accepted: false, reason: 'nothing built: smith.json has no webhook trigger for this branch' });
    expect((await f.project()).onPush).toEqual([]);
  });
  it('replaces queued builds when the project is ticked to, whatever the workspace says, and only on the same branch', async () => {
    const f = await setup();
    await f.toggle(true);
    const burst = async () => {
      const ids: string[] = [];
      for (const tip of [newer, 'c'.repeat(40), 'd'.repeat(40)]) ids.push(((await (await f.deliver(pushOf('feature/cloudflare-experiment', tip))).json()) as { jobIds: string[] }).jobIds[0]);
      const jobs = await f.jobs();
      return ids.map(id => jobs.find(j => j.id === id)?.state);
    };
    // Untouched, the card shows the workspace setting (off) as the default.
    expect(await f.project()).toMatchObject({ replaceQueued: false, replaceQueuedChosen: false });
    const ticked = await (await f.stub.execute(f.human, 'replace-queued', { projectId: f.added.id, enabled: true })).json() as PublicProject & { replaceQueued: boolean; replaceQueuedChosen: boolean };
    expect(ticked).toMatchObject({ replaceQueued: true, replaceQueuedChosen: true });
    expect(await burst()).toEqual(['cancelled', 'cancelled', 'queued']);
    // A queued build of the same action on another branch is left alone.
    const [latest] = (await f.jobs()).filter(j => j.state === 'queued');
    await runInDurableObject(f.stub, (_object, state) => { state.storage.sql.exec("UPDATE jobs SET specs = replace(specs, '\"branch\":\"feature/cloudflare-experiment\"', '\"branch\":\"main\"') WHERE id = ?", latest.id); });
    await f.deliver(pushOf('feature/cloudflare-experiment', 'e'.repeat(40)));
    expect((await f.jobs()).find(j => j.id === latest.id)?.state).toBe('queued');
    // Unticked here, the project keeps every build even though the workspace replaces them.
    await f.stub.execute(f.human, 'put-settings', { supersedeQueued: true });
    await f.stub.execute(f.human, 'replace-queued', { projectId: f.added.id, enabled: false });
    expect(await burst()).toEqual(['queued', 'queued', 'queued']);
    // Back to the workspace default (on): replaced again.
    await f.stub.execute(f.human, 'replace-queued', { projectId: f.added.id, enabled: null });
    expect(await f.project()).toMatchObject({ replaceQueued: true, replaceQueuedChosen: false });
    expect((await burst()).slice(-1)).toEqual(['queued']);
    const queued = (await f.jobs()).filter(j => j.state === 'queued').map(j => j.id);
    expect(queued).toHaveLength(2); expect(queued).toContain(latest.id);
    expect((await f.stub.execute(f.human, 'replace-queued', { projectId: f.added.id, enabled: 'yes' })).status).toBe(400);
  });
  it('runs a serial product one build at a time, whatever the number of machines', async () => {
    const f = await setup();
    await f.toggle(true);
    const machine = async (hostname: string) => {
      const { code } = await (await f.stub.execute(f.human, 'enrollments', {})).json() as { code: string };
      const { token } = await (await f.stub.execute({ kind: 'enrollment' }, 'enroll', { code, protocolVersion: 2, os: 'windows', hostname, arch: 'x64', labels: ['smith-repo-projects', 'smith-deploy', 'una-engine'], agentVersion: '0.2.0' })).json() as { token: string };
      return { kind: 'node' as const, token };
    };
    const one = await machine('DEPLOY-1'); const two = await machine('DEPLOY-2');
    expect((await f.project()).actions.find(a => a.id === 'deploy-experiment')?.notes).toEqual([expect.stringContaining('One at a time')]);
    // Two pushes, queued builds not superseded: two deploys wait in order.
    const first = await (await f.deliver(pushOf('feature/cloudflare-experiment', newer))).json() as { jobIds: string[] };
    const second = await (await f.deliver(pushOf('feature/cloudflare-experiment', 'c'.repeat(40)))).json() as { jobIds: string[] };
    const claim = async (n: { kind: 'node'; token: string }) => await (await f.stub.execute(n, 'claim', {})).json() as { hasJob: boolean; envelope?: { lease: { jobId: string; attemptId: string; leaseToken: string; leaseExpiresAt: number; nodeId: string } } };
    const a = await claim(one);
    expect(a.envelope?.lease.jobId).toBe(first.jobIds[0]);
    // The second machine gets nothing while the first deploy is running, and the dashboard still lists the build as queued.
    expect((await claim(two)).hasJob).toBe(false);
    expect((await f.jobs()).find(j => j.id === second.jobIds[0])?.state).toBe('queued');
    // A build of another product is not held back by it.
    const other = await (await f.stub.execute(f.human, 'enqueue', { requestId: crypto.randomUUID(), projectId: f.added.id, product: 'build' })).json() as { id: string };
    expect((await claim(two)).envelope?.lease.jobId).toBe(other.id);
    // Once the first deploy completes, the next one is handed out.
    await f.stub.execute(one, 'complete', { ...a.envelope!.lease, result: { exitCode: 0, durationMs: 5, message: '', status: 'success' } });
    expect((await claim(one)).envelope?.lease.jobId).toBe(second.jobIds[0]);
  });
  it('says a deploy waits for a label, and an admin gives it to a machine from the build page', async () => {
    const f = await setup();
    await f.toggle(true);
    const { code } = await (await f.stub.execute(f.human, 'enrollments', {})).json() as { code: string };
    // The agent advertises its own smith-* labels and una-engine, but nobody started it with --labels smith-deploy.
    const { token, nodeId } = await (await f.stub.execute({ kind: 'enrollment' }, 'enroll', { code, protocolVersion: 2, os: 'windows', hostname: 'BUILD-PC', arch: 'x64', labels: ['smith-repo-projects', 'una-engine'], agentVersion: '0.2.0' })).json() as { token: string; nodeId: string };
    const node = { kind: 'node' as const, token };
    const queued = await (await f.deliver(pushOf('feature/cloudflare-experiment', newer))).json() as { jobIds: string[] };
    const job = async () => await (await f.stub.execute(f.human, 'get', { jobId: queued.jobIds[0] })).json() as Job & { waiting: string; waitingMachines: { nodeId: string; reason: string; addLabels?: string[] }[] };
    expect((await f.stub.execute(node, 'claim', {})).status).toBe(200);
    // Not "an older Smith": smith-deploy is a label a person gives, so the page offers to add it.
    expect((await job()).waiting).toBe('BUILD-PC lacks the label smith-deploy');
    expect((await job()).waitingMachines).toEqual([{ nodeId, hostname: 'BUILD-PC', reason: 'BUILD-PC lacks the label smith-deploy', addLabels: ['smith-deploy'] }]);
    // Operators cannot, labels the agent advertises by itself cannot be given, and personal machines take no builds.
    const operator = { kind: 'human' as const, userId: crypto.randomUUID() };
    await runInDurableObject(f.stub, (_object, state) => { state.storage.sql.exec('INSERT INTO members (user_id, role) VALUES (?, ?)', operator.userId, 'operator'); });
    expect((await f.stub.execute(operator, 'node-labels', { nodeId, labels: ['smith-deploy'] })).status).toBe(403);
    expect((await f.stub.execute(f.human, 'node-labels', { nodeId, labels: ['smith-repo-sync'] })).status).toBe(400);
    expect((await f.stub.execute(f.human, 'node-labels', { nodeId, labels: ['bad label'] })).status).toBe(400);
    expect(await (await f.stub.execute(f.human, 'node-labels', { nodeId, labels: ['smith-deploy'] })).json()).toEqual({ nodeId, labels: ['smith-repo-projects', 'una-engine', 'smith-deploy'], assignedLabels: ['smith-deploy'] });
    // A heartbeat (which reports only what the agent advertises) keeps the given label, and the machine card shows it apart.
    await f.stub.execute(node, 'heartbeat', { labels: ['smith-repo-projects', 'una-engine'] });
    const card = (await (await f.stub.execute(f.human, 'nodes', {})).json() as { nodes: { id: string; labels: string[]; assignedLabels: string[] }[] }).nodes.find(n => n.id === nodeId)!;
    expect(card).toMatchObject({ labels: ['smith-repo-projects', 'una-engine', 'smith-deploy'], assignedLabels: ['smith-deploy'] });
    const claimed = await (await f.stub.execute(node, 'claim', {})).json() as { hasJob: boolean; envelope?: { lease: { jobId: string } } };
    expect(claimed.envelope?.lease.jobId).toBe(queued.jobIds[0]);
    // Removing it takes it away at once; what the agent advertises stays.
    expect(await (await f.stub.execute(f.human, 'node-labels', { nodeId, labels: [] })).json()).toEqual({ nodeId, labels: ['smith-repo-projects', 'una-engine'], assignedLabels: [] });
  });
  it('says a machine without a label its agent advertises runs an older Smith', async () => {
    const f = await setup();
    const { code } = await (await f.stub.execute(f.human, 'enrollments', {})).json() as { code: string };
    await f.stub.execute({ kind: 'enrollment' }, 'enroll', { code, protocolVersion: 2, os: 'windows', hostname: 'OLD-PC', arch: 'x64', labels: ['una-engine'], agentVersion: '0.1.0' });
    const queued = await (await f.stub.execute(f.human, 'enqueue', { requestId: crypto.randomUUID(), projectId: f.added.id, product: 'build' })).json() as { id: string };
    const job = await (await f.stub.execute(f.human, 'get', { jobId: queued.id })).json() as { waitingMachines: { reason: string; addLabels?: string[] }[] };
    expect(job.waitingMachines).toEqual([expect.objectContaining({ reason: expect.stringContaining('OLD-PC runs an older Smith (no smith-repo-projects)') })]);
    expect(job.waitingMachines[0].addLabels).toBeUndefined();
  });
  it('is limited to admins and to projects added from a Git URL', async () => {
    const f = await setup();
    const operator = { kind: 'human' as const, userId: crypto.randomUUID() };
    await runInDurableObject(f.stub, (_object, state) => { state.storage.sql.exec('INSERT INTO members (user_id, role) VALUES (?, ?)', operator.userId, 'operator'); });
    expect((await f.stub.execute(operator, 'push-builds', { projectId: f.added.id, enabled: true })).status).toBe(403);
    expect((await f.stub.execute(f.human, 'push-builds', { projectId: 'missing', enabled: true })).status).toBe(404);
    expect((await f.stub.execute(f.human, 'push-builds', { projectId: f.added.id, enabled: 'yes' })).status).toBe(400);
    expect((await f.stub.execute(f.human, 'put-project', { id: 'pinned', name: 'Pinned', repoUrl: 'https://github.com/Red-Marmoset/smith.git', branch: 'main', commit, products: [{ name: 'build', commands: { windows: { interpreter: 'ps1', script: 'Build.ps1' } } }] })).status).toBe(201);
    expect((await f.stub.execute(f.human, 'push-builds', { projectId: 'pinned', enabled: true })).status).toBe(409);
  });
  it('is reachable by GitHub at the hook URL without a session, origin or CSRF token', async () => {
    const f = await setup();
    const { url } = await (await f.toggle(true)).json() as { url: string };
    const secret = fakeHooks.hooks.get('Red-Marmoset/smith')![0].secret;
    const body = JSON.stringify(pushOf('feature/cloudflare-experiment', newer));
    const post = (headers: Record<string, string>, payload = body) => worker.fetch(new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'GitHub-Hookshot/abc', ...headers }, body: payload }), env);
    const ok = await post({ 'X-GitHub-Event': 'push', 'X-GitHub-Delivery': crypto.randomUUID(), 'X-Hub-Signature-256': await signPayload(secret, body) });
    expect(ok.status).toBe(202);
    expect(await ok.json()).toMatchObject({ accepted: true });
    expect((await post({ 'X-GitHub-Event': 'push', 'X-Hub-Signature-256': 'sha256=' + 'f'.repeat(64) })).status).toBe(401);
    expect((await post({ 'X-GitHub-Event': 'push' })).status).toBe(401);
    // A delivery for a project without a hook, or an unknown workspace, is a 404 with nothing read from the body.
    expect((await worker.fetch(new Request(url.replace(f.added.id, 'nope'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }), env)).status).toBe(404);
    expect((await worker.fetch(new Request(url.replace(f.id, 'e'.repeat(64)), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }), env)).status).toBe(404);
    // The route takes POST only, and large pushes within GitHub's payload sizes.
    expect((await worker.fetch(new Request(url, { method: 'GET' }), env)).status).toBe(404);
    const big = JSON.stringify({ ...pushOf('feature/cloudflare-experiment', newer), commits: Array.from({ length: 2000 }, (_, i) => ({ id: i, message: 'x'.repeat(100) })) });
    expect(big.length).toBeGreaterThan(65536);
    expect((await post({ 'X-GitHub-Event': 'push', 'X-Hub-Signature-256': await signPayload(secret, big) }, big)).status).toBe(202);
    expect((await post({ 'X-GitHub-Event': 'push' }, 'x'.repeat(1024 * 1024 + 1))).status).toBe(413);
  });
});

describe('removing a project with Build on push on', () => {
  it('takes the hook off GitHub, and deliveries for it are refused', async () => {
    const f = await setup();
    expect((await f.toggle(true)).status).toBe(200);
    expect(fakeHooks.hooks.get('Red-Marmoset/smith')).toHaveLength(1);
    const removed = await f.stub.execute(f.human, 'remove-project', { projectId: f.added.id });
    expect(removed.status).toBe(200);
    expect(fakeHooks.hooks.get('Red-Marmoset/smith')).toEqual([]);
    expect((await (await f.stub.execute(f.human, 'projects', {})).json() as { projects: PublicProject[] }).projects).toEqual([]);
    expect((await f.deliver(pushOf('feature/cloudflare-experiment', newer), { secret: 'anything' })).status).toBe(404);
  });
});

describe('choosing what a push builds', () => {
  it('replaces smith.json’s triggers with the actions ticked on the card, and goes back to them', async () => {
    const f = await setup();
    const choose = async (actions: string[] | null) => f.stub.execute(f.human, 'push-choose', { projectId: f.added.id, actions });
    expect(await f.project()).toMatchObject({ onPush: ['deploy-experiment'], onPushDefault: ['deploy-experiment'], pushChosen: false });
    expect((await choose(['nope'])).status).toBe(400);
    // Ticked in any order, kept in smith.json order.
    expect(await (await choose(['tray', 'build'])).json()).toMatchObject({ onPush: ['build', 'tray'], onPushDefault: ['deploy-experiment'], pushChosen: true });
    expect((await f.toggle(true)).status).toBe(200);
    const delivered = await (await f.deliver(pushOf('feature/cloudflare-experiment', newer))).json() as { jobIds: string[] };
    expect(delivered.jobIds).toHaveLength(2);
    expect((await f.jobs()).map(j => j.product).sort()).toEqual(['build', 'tray']);
    // Nothing ticked: a push builds nothing, and says why.
    await choose([]);
    expect(await (await f.deliver(pushOf('feature/cloudflare-experiment', 'c'.repeat(40)))).json()).toMatchObject({ accepted: false, reason: expect.stringContaining('none of the actions chosen') });
    expect(await (await choose(null)).json()).toMatchObject({ onPush: ['deploy-experiment'], pushChosen: false });
    // Only owners and admins choose.
    const viewer = { kind: 'human' as const, userId: crypto.randomUUID() };
    await runInDurableObject(f.stub, (_o, state) => { state.storage.sql.exec("INSERT INTO members (user_id, role) VALUES (?, 'operator')", viewer.userId); });
    expect((await f.stub.execute(viewer, 'push-choose', { projectId: f.added.id, actions: ['build'] })).status).toBe(403);
  });
});
