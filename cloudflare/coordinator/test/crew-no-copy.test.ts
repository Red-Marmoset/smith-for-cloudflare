// Crew after the experiment branch made Smith's copy optional and put a machine online in every workspace its owner is in:
// a project with no copy is checked out, read and pushed with the machine's own Git login (no Smith token at all), its
// proposal is pending as soon as the push reports, and a machine mirrored from another workspace takes crew runs here only
// once its owner opted it in here.
import { env } from 'cloudflare:workers';
import { beforeAll, describe, it, expect } from 'vitest';
import identity from '../migrations/0001_identity.sql?raw';
import { fakeArtifacts } from '../src/artifacts-repos';
import { hash } from '../src/http';
import { CREW_AI, commit, crewSetup, errorOf, projectBody, type Node } from './crew-fixture';

beforeAll(async () => { await env.DB.exec(identity); });

type Fixture = Awaited<ReturnType<typeof crewSetup>>;
type Proposal = { sessionId: string; status: string; message: string | null; branch: string; commit: string };
const review = async (f: Fixture) => (await (await f.stub.execute(f.operator, 'crew-review', {})).json() as { proposals: Proposal[] }).proposals;
const events = async (f: Fixture, sessionId: string) =>
  (await (await f.stub.execute(f.operator, 'crew-run-events', { sessionId })).json() as { events: { kind: string; data: unknown }[] }).events;

describe('a project with no copy in Smith', () => {
  it('runs, reads related projects and pushes with the machine’s own Git login, and its proposal is pending at once', async () => {
    const f = await crewSetup();
    for (const id of ['docs', 'notes']) expect((await f.stub.execute(f.owner, 'put-project', projectBody(id))).status).toBe(201);
    const member = await f.create({ name: 'Docs', projectIds: ['docs', 'notes', 'smith'], verifyProduct: 'build' });
    const { sessionId, runId } = await (await f.run(member.id)).json() as { sessionId: string; runId: string };
    const turn = (await f.claim())!;
    expect(turn.repo.url).toBe(projectBody('docs').repoUrl);
    expect(turn.repo.authToken ?? '').toBe('');
    // A related project without a copy goes with an empty token (the agent clones it with its own login); one with a copy
    // still gets a read token for it.
    expect(turn.related).toEqual([
      { projectId: 'notes', url: projectBody('notes').repoUrl, commit, branch: 'main', authToken: '' },
      expect.objectContaining({ projectId: 'smith', authToken: expect.stringMatching(/^art_v1_/) })]);
    expect([...fakeArtifacts.tokens.values()].map(t => t.scope)).toEqual(['read']);
    const sha = 'c'.repeat(40);
    expect((await f.finish(turn, { status: 'completed', message: 'ok', commit: sha, baseCommit: commit, files: ['docs/a.md'],
      report: { summary: 'Typos', findings: [], proposal: { title: 'Fix typos', summary: 'Fixes typos' } } })).status).toBe(200);
    const push = (await f.claim())!;
    // The push turn carries no Smith token: no write token is minted for a project that is not Smith's copy.
    expect(push).toMatchObject({ sessionId, kind: 'push', pushBranch: true, repo: { url: projectBody('docs').repoUrl } });
    expect(push.repo.authToken ?? '').toBe('');
    expect([...fakeArtifacts.tokens.values()].filter(t => t.scope === 'write')).toEqual([]);
    expect((await f.finish(push, { status: 'completed', message: 'pushed', commit: sha })).status).toBe(200);
    // Nothing to confirm the head against: pending straight away, saying so, with no alarm and no Artifacts call.
    expect(await review(f)).toMatchObject([{ sessionId, status: 'pending', message: null, branch: push.repo.branch, commit: sha }]);
    expect(await f.runs(member.id)).toMatchObject([{ id: runId, state: 'completed' }]);
    expect((await events(f, sessionId)).at(-1)).toMatchObject({ kind: 'status', data: `Pushed ${push.repo.branch} with this computer's Git login; Smith cannot confirm the head.` });
    await f.alarm();
    expect((await review(f))[0].status).toBe('pending');
    // Verify pins the commit the push reported, and needs no read token (the build machine clones with its own login).
    const tokens = fakeArtifacts.tokens.size;
    expect((await f.stub.execute(f.operator, 'crew-verify', { sessionId, requestId: 'v' })).status).toBe(201);
    expect(fakeArtifacts.tokens.size).toBe(tokens);
    const job = await f.sql(sql => sql.exec<{ specs: string; secretless: number }>("SELECT specs, secretless FROM jobs WHERE kind = 'build'").one());
    expect(job.secretless).toBe(1);
    const repos = Object.values(JSON.parse(job.specs) as Record<string, { repos: { url: string; branch: string; commit: string }[] }>).map(spec => spec.repos[0]);
    expect(repos).toEqual([expect.objectContaining({ url: projectBody('docs').repoUrl, branch: push.repo.branch, commit: sha })]);
  });

  it('stales an older pending proposal of the same title when a no-copy push lands, as a confirmed head does', async () => {
    const f = await crewSetup();
    expect((await f.stub.execute(f.owner, 'put-project', projectBody('docs'))).status).toBe(201);
    const member = await f.create({ name: 'Docs', projectIds: ['docs'] });
    const pushOnce = async (sha: string) => {
      const { sessionId } = await (await f.run(member.id)).json() as { sessionId: string };
      expect((await f.finish((await f.claim())!, { status: 'completed', message: 'ok', commit: sha, baseCommit: commit, files: ['a.md'],
        report: { summary: 'S', findings: [], proposal: { title: 'Same', summary: 's' } } })).status).toBe(200);
      expect((await f.finish((await f.claim())!, { status: 'completed', message: 'pushed', commit: sha })).status).toBe(200);
      return sessionId;
    };
    const first = await pushOnce('a'.repeat(40)), second = await pushOnce('b'.repeat(40));
    const statuses = Object.fromEntries((await review(f)).map(p => [p.sessionId, p.status]));
    expect(statuses).toEqual({ [first]: 'stale', [second]: 'pending' });
  });

  it('fails a no-copy push that reports another commit than the run’s, as before', async () => {
    const f = await crewSetup();
    expect((await f.stub.execute(f.owner, 'put-project', projectBody('docs'))).status).toBe(201);
    const member = await f.create({ name: 'Docs', projectIds: ['docs'] });
    const { sessionId } = await (await f.run(member.id)).json() as { sessionId: string };
    expect((await f.finish((await f.claim())!, { status: 'completed', message: 'ok', commit: 'c'.repeat(40), baseCommit: commit, files: ['a.md'],
      report: { summary: 'S', findings: [], proposal: { title: 'T', summary: 's' } } })).status).toBe(200);
    expect((await f.finish((await f.claim())!, { status: 'completed', message: 'pushed', commit: 'd'.repeat(40) })).status).toBe(200);
    expect((await review(f))[0]).toMatchObject({ sessionId, status: 'failed', message: expect.stringContaining('not the run’s commit') });
  });
});

describe('a machine mirrored from another of its owner’s workspaces', () => {
  // The machine as linked-nodes.ts adds it here: the same node ID and credential, its home workspace's purpose and inventory.
  async function linked(f: Fixture, signedIn: boolean) {
    const token = `smn.${crypto.randomUUID()}.linked`, id = crypto.randomUUID();
    const ai = JSON.stringify({ ...CREW_AI, tools: [{ id: 'claude-code', version: '2.1', signedIn }] });
    expect(await f.stub.linkNode({ id, tokenHash: await hash(token), os: 'windows', hostname: 'linked-pc', arch: 'x64', labels: '[]', agentVersion: '0.1.0',
      ownerUserId: f.operator.userId, purpose: 'personal', ai })).toBe(true);
    return { id, node: { kind: 'node', token } as Node };
  }

  it('takes crew runs here only once its owner turns crew on here, and only while Claude Code is signed in there', async () => {
    const f = await crewSetup();
    expect((await f.stub.execute(f.owner, 'node-crew', { nodeId: f.builder.nodeId, run: false })).status).toBe(200);   // only the linked machine is left
    const machine = await linked(f, true);
    const member = await f.create({ brain: 'login' });
    // Linked in, but crew work is off here until its owner opts it in, whatever its home workspace says.
    expect(await errorOf(f.run(member.id))).toMatchObject({ status: 409, code: 'no_machine' });
    expect(await errorOf(f.stub.execute(f.owner, 'node-crew', { nodeId: machine.id, run: true }))).toMatchObject({ status: 404 });   // not the owner's machine
    expect((await f.stub.execute(f.operator, 'node-crew', { nodeId: machine.id, run: true })).status).toBe(200);
    const { runId } = await (await f.run(member.id)).json() as { runId: string };
    // Its heartbeat reaches this workspace too (the Worker mirrors it); signed out by then, the claim refuses the run.
    expect((await f.stub.execute(machine.node, 'heartbeat', { ai: { ...CREW_AI, tools: [{ id: 'claude-code', version: '2.1', signedIn: false }] } })).status).toBe(200);
    expect(await f.claim(machine.node)).toBeNull();
    expect(await f.sql(sql => sql.exec<{ state: string; wait_reason: string }>('SELECT state, wait_reason FROM crew_runs WHERE id = ?', runId).one()))
      .toEqual({ state: 'waiting', wait_reason: 'no signed-in machine' });
    // Signed in again: the heartbeat promotes the waiting run onto it, and it claims it.
    expect((await f.stub.execute(machine.node, 'heartbeat', { ai: { ...CREW_AI, tools: [{ id: 'claude-code', version: '2.1', signedIn: true }] } })).status).toBe(200);
    expect(await f.claim(machine.node)).toMatchObject({ sessionKind: 'crew', kind: 'message' });
  });

  it('never runs the workspace key on a mirrored personal machine', async () => {
    const f = await crewSetup();
    expect((await f.stub.execute(f.owner, 'node-crew', { nodeId: f.builder.nodeId, run: false })).status).toBe(200);
    const machine = await linked(f, true);
    expect((await f.stub.execute(f.operator, 'node-crew', { nodeId: machine.id, run: true })).status).toBe(200);
    const member = await f.create();   // the api-key brain
    expect(await errorOf(f.run(member.id))).toMatchObject({ status: 409, code: 'no_machine', waitReason: 'personal machine' });
  });
});
