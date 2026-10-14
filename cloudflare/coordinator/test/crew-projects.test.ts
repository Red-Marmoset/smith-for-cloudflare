// Crew-created shared projects (crew_create_project): the workspace setting and the member's flag gate it, the workspace's own
// Cloudflare Artifacts account holds it, the push turn pushes it, and reconcileCrew confirms it before the crew is told.
import { env } from 'cloudflare:workers';
import { beforeAll, describe, it, expect } from 'vitest';
import worker from '../src/index';
import identity from '../migrations/0001_identity.sql?raw';
import { fakeArtifacts, repoNameFor } from '../src/artifacts-repos';
import type { Project } from '../src/projects';
import { CrewProjects } from '../src/crew-projects';
import { crewCreated, hasArtifactsCopy } from '../src/crew';
import { applyReport, type RepoProject } from '../src/repo-projects';
import senet from './fixtures/smith-json/senet.json?raw';
import { commit, crewSetup, errorOf, origin, projectBody, type CrewTurn, type Human, type Member } from './crew-fixture';

beforeAll(async () => { await env.DB.exec(identity); });

const ACCOUNT = '0123456789abcdef0123456789abcdef';
const CF_TOKEN = 'cf_test_token_1234567890abcdefghij';
const SHA = 'e'.repeat(40);
const CREATE = { requestId: 'req-1', id: 'tool-lib', name: 'Tool lib', description: 'Shared log parsing', purpose: 'One log parser for Smith and Senet' };
type Fixture = Awaited<ReturnType<typeof crewSetup>>;
type PushTurn = CrewTurn & { pushBranch?: boolean; createdProjects?: { id: string; remote: string; authToken: string }[] };

let nextId = 1;
async function tool(token: string, name: string, args: Record<string, unknown>) {
  const response = await worker.fetch(new Request(origin + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } }) }), env);
  const body = await response.json() as { result: { content: { text: string }[]; isError: boolean } };
  const text = body.result.content[0].text;
  return { isError: body.result.isError, text, json: (() => { try { return JSON.parse(text) as Record<string, unknown>; } catch { return null; } })() };
}
// A member that may create projects (an owner grants it), in the middle of a run on the build machine.
async function creating(f: Fixture, { allow = true, workspaceAccount = true, member: flag = true } = {}) {
  if (workspaceAccount) expect((await f.stub.execute(f.owner, 'put-settings', { cloudflareAccountId: ACCOUNT, cloudflareApiToken: CF_TOKEN })).status).toBe(200);
  if (allow) expect((await f.stub.execute(f.owner, 'put-settings', { crewMayCreateProjects: true })).status).toBe(200);
  const member = await f.create({ name: 'Toolsmith', mayCreateProjects: flag }, f.owner);
  const { sessionId, runId } = await (await f.run(member.id)).json() as { sessionId: string; runId: string };
  const turn = (await f.claim())!;
  expect(turn.sessionId).toBe(sessionId);
  return { member, sessionId, runId, turn };
}
const projects = async (f: Fixture, who: Human = f.operator) => (await (await f.stub.execute(who, 'projects', {})).json() as { projects: Project[] }).projects;
const row = (f: Fixture, id: string) => f.sql(sql => sql.exec<{ status: string; message: string | null; token_id: string | null; head_commit: string | null }>(
  'SELECT status, message, token_id, head_commit FROM crew_projects WHERE project_id = ?', id).toArray()[0]);
const inbox = (f: Fixture, crewId: string) => f.sql(sql => sql.exec<{ body: string }>('SELECT body FROM crew_messages WHERE to_crew_id = ? ORDER BY seq', crewId).toArray().map(m => m.body));
// The message turn ends listing the directories it left in new-project/, so Smith queues the push turn that pushes them.
async function finishRun(f: Fixture, turn: CrewTurn, created: { id: string }[] = [{ id: 'tool-lib' }], result: Record<string, unknown> = {}) {
  expect((await f.finish(turn, { status: 'completed', message: 'ok', baseCommit: commit, costUsd: 0.1, createdProjects: created, ...result })).status).toBe(200);
  return (await f.claim()) as PushTurn | null;
}

describe('crew-created projects', () => {
  it('needs the workspace setting, the member’s flag and the workspace’s own Cloudflare account', async () => {
    const off = await crewSetup(); const run = await creating(off, { allow: false });
    const refused = await tool(run.turn.mcp.token, 'crew_create_project', CREATE);
    expect(refused).toMatchObject({ isError: true, text: expect.stringContaining('an owner must allow') });
    const backend = await crewSetup(); const second = await creating(backend, { workspaceAccount: false });
    expect(await tool(second.turn.mcp.token, 'crew_create_project', CREATE)).toMatchObject({ isError: true, text: expect.stringContaining('own Cloudflare account') });
    expect(await errorOf(backend.stub.execute({ kind: 'token', token: second.turn.mcp.token }, 'crew-tool-create-project', CREATE))).toMatchObject({ status: 503, code: 'artifacts_unconfigured' });
    const unflagged = await crewSetup(); const third = await creating(unflagged, { member: false });
    expect(await tool(third.turn.mcp.token, 'crew_create_project', CREATE)).toMatchObject({ isError: true, text: expect.stringContaining('may not create projects') });
    // Nothing was reserved, no repository was made, and a person cannot call the tool.
    for (const f of [off, backend, unflagged]) expect(await f.sql(sql => sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM crew_projects').one().n)).toBe(0);
    expect(fakeArtifacts.repos.size).toBe(1);
    expect(await errorOf(unflagged.stub.execute(unflagged.owner, 'crew-tool-create-project', CREATE))).toMatchObject({ status: 403 });
  });

  it('reserves the ID, creates the repository, answers a replay the same, and refuses IDs it must not take', async () => {
    const f = await crewSetup(); const { member, sessionId, turn } = await creating(f);
    const created = await tool(turn.mcp.token, 'crew_create_project', CREATE);
    const remote = fakeArtifacts.remote(repoNameFor(f.id, 'tool-lib'), ACCOUNT);
    expect(created).toMatchObject({ isError: false, json: { projectId: 'tool-lib', remote, dir: 'new-project/tool-lib' } });
    expect((await tool(turn.mcp.token, 'crew_create_project', CREATE)).json).toEqual(created.json);
    expect(await tool(turn.mcp.token, 'crew_create_project', { ...CREATE, requestId: 'req-2' })).toMatchObject({ isError: true, text: expect.stringContaining('exists') });
    // The project is listed as a repository project (Smith reads its smith.json once it holds one), marked as the crew's,
    // while its first push is pending.
    expect((await projects(f)).find(p => p.id === 'tool-lib')).toMatchObject({ kind: 'repo', id: 'tool-lib', name: 'Tool lib', repoUrl: remote, branch: 'main', commit: null, actions: [],
      createdBy: { crewId: member.id, sessionId }, purpose: CREATE.purpose, artifacts: { status: 'pushing', accountId: ACCOUNT, source: 'workspace', remote } });
    expect(await f.sql(sql => sql.exec("SELECT id FROM jobs WHERE kind = 'scan'").toArray())).toEqual([]);   // nothing to read before the first push
    expect(await row(f, 'tool-lib')).toMatchObject({ status: 'pushing', token_id: null });
    // Until its first push is confirmed it is no shared project: crew_list (and related clones) leave it out.
    expect((await (await f.stub.execute({ kind: 'token', token: turn.mcp.token }, 'crew-tool-list', {})).json() as { sharedProjects: unknown[] }).sharedProjects).toEqual([]);
    for (const [id, why] of [['smoke', 'reserved'], ['smith', 'exists'], ['toolsmith', 'crew member'], ['Tool-Lib', 'ID'], ['x', 'ID'], ['a'.repeat(41), 'ID'], ['-lib', 'ID']]) {
      const answer = await tool(turn.mcp.token, 'crew_create_project', { ...CREATE, requestId: 'r-' + id, id });
      expect(answer, id).toMatchObject({ isError: true, text: expect.stringContaining(why) });
    }
    // The workspace's 20 projects include the crew's.
    await f.sql(sql => { for (let i = 0; i < 18; i++) sql.exec('INSERT INTO projects VALUES (?, ?)', `filler-${i}`, '{}'); });
    expect(await tool(turn.mcp.token, 'crew_create_project', { ...CREATE, requestId: 'r-cap', id: 'one-more' })).toMatchObject({ isError: true, text: expect.stringContaining('quota') });
  });

  it('records a repository Artifacts could not make as an error, and a replay says so', async () => {
    const f = await crewSetup(); const { turn } = await creating(f);
    fakeArtifacts.failNext = { status: 502, code: 'artifacts_failed' };
    expect(await tool(turn.mcp.token, 'crew_create_project', CREATE)).toMatchObject({ isError: true, text: expect.stringContaining('fake artifacts failure') });
    expect(await row(f, 'tool-lib')).toMatchObject({ status: 'error', message: expect.stringContaining('fake artifacts failure') });
    expect(await tool(turn.mcp.token, 'crew_create_project', CREATE)).toMatchObject({ isError: true, text: expect.stringContaining('fake artifacts failure') });
    expect((await projects(f)).some(p => p.id === 'tool-lib')).toBe(false);
    // The ID is free again for a new request.
    expect(await tool(turn.mcp.token, 'crew_create_project', { ...CREATE, requestId: 'req-2' })).toMatchObject({ isError: false });
  });

  it('pushes it in the push turn with a write token only that claim carries, confirms the head, and tells the crew', async () => {
    const f = await crewSetup(); const { member, sessionId, runId, turn } = await creating(f);
    const other = await f.create({ name: 'Bug hunter' });
    expect((await tool(turn.mcp.token, 'crew_create_project', CREATE)).isError).toBe(false);
    const name = repoNameFor(f.id, 'tool-lib');
    // The run changed nothing in its own project: the push turn pushes only the new project, with no token for the branch.
    const push = (await finishRun(f, turn))!;
    expect(push).toMatchObject({ sessionId, kind: 'push', pushBranch: false, createdProjects: [{ id: 'tool-lib', remote: fakeArtifacts.remote(name, ACCOUNT), authToken: expect.stringMatching(/^art_v1_0{28}w/) }] });
    expect(push.repo.authToken).toBeUndefined();
    const writeToken = push.createdProjects![0].authToken;
    const tokenId = (await row(f, 'tool-lib'))!.token_id;
    expect(fakeArtifacts.tokens.get(tokenId!)).toMatchObject({ account: ACCOUNT, repo: name, scope: 'write', revoked: false });
    expect(await f.runs(member.id)).toMatchObject([{ id: runId, state: 'pushing' }]);
    expect((await f.finish(push, { status: 'completed', message: 'pushed', commit: null, createdProjects: [{ id: 'tool-lib', commit: SHA }] })).status).toBe(200);
    expect(await row(f, 'tool-lib')).toMatchObject({ status: 'pushing', head_commit: SHA });
    expect(await f.runs(member.id)).toMatchObject([{ id: runId, state: 'completed' }]);
    // Artifacts does not show the push yet: Smith waits.
    await f.alarm();
    expect(await row(f, 'tool-lib')).toMatchObject({ status: 'pushing' });
    fakeArtifacts.setHead(name, 'main', SHA);
    await f.alarm();
    expect(await row(f, 'tool-lib')).toMatchObject({ status: 'ready', token_id: null });
    expect(fakeArtifacts.tokens.get(tokenId!)?.revoked).toBe(true);
    expect((await projects(f)).find(p => p.id === 'tool-lib')).toMatchObject({ commit: SHA, artifacts: { status: 'done', pushedCommit: SHA }, createdBy: { crewId: member.id } });
    // Smith reads its smith.json now: a scan of the Artifacts copy, with a read token for it, so its build actions appear.
    const scan = await f.sql(sql => sql.exec<{ id: string; specs: string }>("SELECT id, specs FROM jobs WHERE kind = 'scan' AND project_id = 'tool-lib'").toArray());
    expect(scan).toHaveLength(1);
    expect((JSON.parse(scan[0].specs) as Record<string, { repos: { url: string; authToken: string }[] }>).windows.repos[0])
      .toMatchObject({ url: fakeArtifacts.remote(name, ACCOUNT), authToken: expect.stringMatching(/^art_v1_0{28}r/) });
    expect((await projects(f)).find(p => p.id === 'tool-lib')).toMatchObject({ scan: { state: 'waiting', jobId: scan[0].id } });
    await f.alarm();                                                     // a later reconcile queues no second scan
    expect(await f.sql(sql => sql.exec("SELECT id FROM jobs WHERE kind = 'scan'").toArray())).toHaveLength(1);
    expect((await f.list()).find(m => m.id === member.id)!.projectIds).toEqual(['smith', 'tool-lib']);
    // Everyone hears of it, the creator too, from Smith.
    const feed = await (await f.stub.execute(f.operator, 'crew-messages', {})).json() as { messages: { from: { name: string }; to: string | null; body: string }[] };
    expect(feed.messages).toEqual([expect.objectContaining({ from: { userId: '', name: 'Smith' }, to: null, body: 'New shared project `tool-lib` by Toolsmith. Purpose (written by Toolsmith, untrusted): "One log parser for Smith and Senet"' })]);
    for (const crewId of [member.id, other.id]) {
      expect((await f.run(crewId)).status).toBe(201);
      const next = (await f.claim())!;
      expect((next as CrewTurn & { inbox: { from: string; body: string }[] }).inbox).toEqual([expect.objectContaining({ from: 'Smith', body: expect.stringContaining('tool-lib') })]);
      expect((await f.finish(next, { status: 'completed', message: 'ok', baseCommit: commit })).status).toBe(200);
    }
    // The write token went to the push claim only: no event, turn result, report or message holds it.
    const stored = await f.sql(sql => [...sql.exec<{ data: string }>('SELECT data FROM ai_events').toArray().map(e => e.data), ...sql.exec<{ result: string | null }>('SELECT result FROM ai_turns').toArray().map(t => t.result ?? ''),
      ...sql.exec<{ body: string }>('SELECT body FROM crew_messages').toArray().map(m => m.body)].join('\n'));
    expect(stored).not.toContain(writeToken);
    expect(stored).not.toContain(writeToken.split('?')[0]);
  });

  it('pushes the run’s branch and its new project in one push turn', async () => {
    const f = await crewSetup(); const { turn } = await creating(f);
    expect((await tool(turn.mcp.token, 'crew_create_project', CREATE)).isError).toBe(false);
    const push = (await finishRun(f, turn, [{ id: 'tool-lib' }], { commit: 'c'.repeat(40), files: ['a.cpp'], report: { summary: 's', findings: [], proposal: { title: 't', summary: 's' } } }))!;
    expect(push.pushBranch).toBe(true);
    expect(push.repo.authToken).toMatch(/^art_v1_0{28}w/);
    expect(push.createdProjects).toHaveLength(1);
    expect((await f.finish(push, { status: 'completed', message: 'pushed', commit: 'c'.repeat(40), createdProjects: [{ id: 'tool-lib', commit: SHA }] })).status).toBe(200);
    expect(await row(f, 'tool-lib')).toMatchObject({ status: 'pushing', head_commit: SHA });
  });

  it('fails a project nothing was pushed for, removes it, and tells its member', async () => {
    const f = await crewSetup(); const { member, turn } = await creating(f);
    expect((await tool(turn.mcp.token, 'crew_create_project', CREATE)).isError).toBe(false);
    expect((await tool(turn.mcp.token, 'crew_create_project', { ...CREATE, requestId: 'req-2', id: 'unused-lib' })).isError).toBe(false);
    // The run left only tool-lib (unused-lib had no valid directory), and the push turn did not push it either.
    const push = (await finishRun(f, turn, [{ id: 'tool-lib' }]))!;
    expect(push.createdProjects!.map(p => p.id)).toEqual(['tool-lib']);
    expect(await row(f, 'unused-lib')).toMatchObject({ status: 'failed', message: expect.stringContaining('new-project/unused-lib') });
    expect((await f.finish(push, { status: 'failed', message: 'git push failed', commit: null })).status).toBe(200);
    expect(await row(f, 'tool-lib')).toMatchObject({ status: 'failed' });
    expect((await projects(f)).map(p => p.id)).toEqual(['smith']);
    expect(await inbox(f, member.id)).toEqual([expect.stringMatching(/^Project unused-lib could not be created: /), expect.stringMatching(/^Project tool-lib could not be created: /)]);
    await f.alarm();
    expect([...fakeArtifacts.tokens.values()].filter(t => t.scope === 'write').every(t => t.revoked)).toBe(true);
    // A pushed head Artifacts disagrees with fails too.
    const g = await crewSetup(); const second = await creating(g);
    expect((await tool(second.turn.mcp.token, 'crew_create_project', CREATE)).isError).toBe(false);
    const pushed = (await finishRun(g, second.turn))!;
    expect((await g.finish(pushed, { status: 'completed', message: 'pushed', commit: null, createdProjects: [{ id: 'tool-lib', commit: SHA }] })).status).toBe(200);
    fakeArtifacts.setHead(repoNameFor(g.id, 'tool-lib'), 'main', 'f'.repeat(40));
    await g.alarm();
    expect(await row(g, 'tool-lib')).toMatchObject({ status: 'failed', message: expect.stringContaining('not the pushed commit') });
    expect((await projects(g)).some(p => p.id === 'tool-lib')).toBe(false);
  });

  it('fails a run’s projects when the run does not complete, and expires a reservation that never got its repository', async () => {
    const f = await crewSetup(); const { turn } = await creating(f);
    expect((await tool(turn.mcp.token, 'crew_create_project', CREATE)).isError).toBe(false);
    expect((await f.finish(turn, { status: 'failed', message: 'Claude Code exited with code 1', baseCommit: commit, createdProjects: [{ id: 'tool-lib' }] })).status).toBe(200);
    expect(await f.claim()).toBeNull();                                   // nothing to push
    expect(await row(f, 'tool-lib')).toMatchObject({ status: 'failed' });
    expect((await projects(f)).some(p => p.id === 'tool-lib')).toBe(false);
    // A crash between the reservation and the repository leaves a reserved row: an hour later it no longer holds the ID.
    await f.sql(sql => { sql.exec("INSERT INTO crew_projects (project_id, crew_id, session_id, request_id, status, created_at, updated_at) VALUES ('stuck-lib', 'c', 's', 's/r', 'reserved', ?, ?)", Date.now() - 2 * 3600000, Date.now() - 2 * 3600000); });
    await f.alarm();
    expect(await row(f, 'stuck-lib')).toMatchObject({ status: 'expired' });
  });

  it('lets only an owner delete a crew-made project, between its member’s runs, keeping the repository', async () => {
    const f = await crewSetup(); const { member, turn } = await creating(f);
    expect((await tool(turn.mcp.token, 'crew_create_project', CREATE)).isError).toBe(false);
    const push = (await finishRun(f, turn))!;
    expect(await errorOf(f.stub.execute(f.owner, 'crew-project-delete', { projectId: 'tool-lib' }))).toMatchObject({ status: 409, code: 'run_active' });
    expect((await f.finish(push, { status: 'completed', message: 'pushed', commit: null, createdProjects: [{ id: 'tool-lib', commit: SHA }] })).status).toBe(200);
    fakeArtifacts.setHead(repoNameFor(f.id, 'tool-lib'), 'main', SHA);
    await f.alarm();
    const admin = await f.member('admin');
    for (const who of [f.operator, admin]) expect(await errorOf(f.stub.execute(who, 'crew-project-delete', { projectId: 'tool-lib' }))).toMatchObject({ status: 403 });
    expect(await errorOf(f.stub.execute(f.owner, 'crew-project-delete', { projectId: 'smith' }))).toMatchObject({ status: 404 });
    // Not while another member works on it as its main project.
    const other = await f.create({ name: 'Parser keeper', projectIds: ['tool-lib'], enabled: false });
    expect(await errorOf(f.stub.execute(f.owner, 'crew-project-delete', { projectId: 'tool-lib' }))).toMatchObject({ status: 409, code: 'project_in_use' });
    expect((await f.stub.execute(f.operator, 'crew-delete', { crewId: other.id })).status).toBe(200);
    // A write token still on the record (say, revoking it failed so far) is revoked, not forgotten, when the project goes.
    fakeArtifacts.tokens.set('tok_left', { account: ACCOUNT, repo: repoNameFor(f.id, 'tool-lib'), scope: 'write', revoked: false });
    await f.sql(sql => { sql.exec("UPDATE crew_projects SET token_id = 'tok_left' WHERE project_id = 'tool-lib'"); });
    const deleted = await f.stub.execute(f.owner, 'crew-project-delete', { projectId: 'tool-lib' });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toMatchObject({ deleted: true, repositoryKept: true, message: expect.stringContaining('remains') });
    expect(fakeArtifacts.tokens.get('tok_left')?.revoked).toBe(true);
    expect((await projects(f)).map(p => p.id)).toEqual(['smith']);
    expect(await row(f, 'tool-lib')).toBeUndefined();
    expect((await f.list()).find((m: Member) => m.id === member.id)!.projectIds).toEqual(['smith']);
    expect(fakeArtifacts.repos.has(ACCOUNT + '/' + repoNameFor(f.id, 'tool-lib'))).toBe(true);
    // The kept repository has history, so the ID is not taken again over it.
    expect((await f.run(member.id)).status).toBe(201);
    const again = (await f.claim())!;
    expect(await tool(again.mcp.token, 'crew_create_project', { ...CREATE, requestId: 'again' })).toMatchObject({ isError: true, text: expect.stringContaining('already exists with history') });
    expect(await row(f, 'tool-lib')).toMatchObject({ status: 'error', message: expect.stringContaining('already exists with history') });
    expect((await projects(f)).map(p => p.id)).toEqual(['smith']);
  });

  it('keeps a project a member works on as its main one until the member is given another or deleted', async () => {
    const f = await crewSetup();
    const keeper = await f.create({ name: 'Smith keeper', projectIds: ['smith'], enabled: false });
    expect(await errorOf(f.stub.execute(f.owner, 'remove-project', { projectId: 'smith' }))).toMatchObject({ status: 409, code: 'project_in_use' });
    for (const m of (await f.list()) as Member[]) if (m.projectIds[0] === 'smith') expect((await f.stub.execute(f.operator, 'crew-delete', { crewId: m.id })).status).toBe(200);
    expect((await f.list()).some((m: Member) => m.id === keeper.id)).toBe(false);
    expect((await f.stub.execute(f.owner, 'remove-project', { projectId: 'smith' })).status).toBe(200);
    expect(await projects(f)).toEqual([]);
  });

  it('holds the 20-project cap across a reservation, from either side', async () => {
    const f = await crewSetup(); const { turn } = await creating(f);
    // A person's add counts the crew's reservations still waiting for their repository...
    await f.sql(sql => {
      for (let i = 0; i < 18; i++) sql.exec('INSERT INTO projects VALUES (?, ?)', `filler-${i}`, '{}');
      sql.exec("INSERT INTO crew_projects (project_id, crew_id, session_id, request_id, status, repo, created_at, updated_at) VALUES ('held-lib', 'c', ?, ?, 'reserved', 'r', ?, ?)", turn.sessionId, turn.sessionId + '/held', Date.now(), Date.now());
    });
    expect(await errorOf(f.stub.execute(f.owner, 'put-project', projectBody('late')))).toMatchObject({ status: 429, code: 'quota' });
    // ...and a person's add that landed while the repository was being made fails the reservation at record.
    await f.sql(sql => { sql.exec("INSERT INTO projects VALUES ('late', '{}')"); });
    const recorded = await f.sql(sql => new CrewProjects(sql).record({ key: turn.sessionId + '/held', id: 'held-lib', name: 'Held', description: '', purpose: 'p', repo: 'r', crewId: 'c', sessionId: turn.sessionId },
      fakeArtifacts.remote('r', ACCOUNT), { namespace: 'default', accountId: ACCOUNT }, Date.now()).status);
    expect(recorded).toBe(429);
    expect(await row(f, 'held-lib')).toMatchObject({ status: 'error', message: expect.stringContaining('20 projects') });
    expect((await projects(f)).some(p => p.id === 'held-lib')).toBe(false);
  });

  it('fails a project whose push token cannot be minted, saying so, and names the new projects when no machine pushes them', async () => {
    const f = await crewSetup(); const { member, turn } = await creating(f);
    expect((await tool(turn.mcp.token, 'crew_create_project', CREATE)).isError).toBe(false);
    expect((await f.finish(turn, { status: 'completed', message: 'ok', baseCommit: commit, createdProjects: [{ id: 'tool-lib' }] })).status).toBe(200);
    fakeArtifacts.failNext = { status: 502, code: 'artifacts_failed' };
    const push = (await f.claim()) as PushTurn;
    expect(push.createdProjects).toBeUndefined();
    expect(await row(f, 'tool-lib')).toMatchObject({ status: 'failed', message: expect.stringContaining('Smith could not mint a push token: fake artifacts failure') });
    expect(await inbox(f, member.id)).toEqual([expect.stringContaining('Smith could not mint a push token')]);
    // Another run's push turn that no machine takes in 15 minutes says it was the new projects that were not pushed.
    const g = await crewSetup(); const second = await creating(g);
    expect((await tool(second.turn.mcp.token, 'crew_create_project', CREATE)).isError).toBe(false);
    expect((await g.finish(second.turn, { status: 'completed', message: 'ok', baseCommit: commit, createdProjects: [{ id: 'tool-lib' }] })).status).toBe(200);
    await g.sql(sql => { sql.exec("UPDATE ai_turns SET created_at = ? WHERE kind = 'push'", Date.now() - 16 * 60000); });
    await g.alarm();
    const events = await (await g.stub.execute(g.operator, 'crew-run-events', { sessionId: second.sessionId })).json() as { events: { data: unknown }[] };
    expect(events.events.map(e => e.data)).toContain('Smith stopped this push: no machine pushed the new project(s) within 15 minutes, so they were not created.');
    expect(await row(g, 'tool-lib')).toMatchObject({ status: 'failed' });
  });

  it('tells a crew-made project from one a person added by its createdBy, whatever its shape', () => {
    const artifacts = { repo: 'r', namespace: 'default', remote: 'https://a.artifacts.cloudflare.net/git/default/r.git', status: 'done' as const, accountId: ACCOUNT, source: 'workspace' as const, sourceRepoUrl: '', updatedAt: 1 };
    const repo = (createdBy?: RepoProject['createdBy']): RepoProject => ({ kind: 'repo', id: 'p', name: 'p', customName: true, repoUrl: artifacts.remote, source: 'git', branch: 'main', commit: SHA,
      scan: { state: 'ready', message: '', via: null, host: null, jobId: null, at: 1 }, actions: [], unusedRules: 0, disabledRules: 0, warnings: [], createdAt: 1, artifacts, ...(createdBy ? { createdBy } : {}) });
    expect(crewCreated(repo({ crewId: 'c', sessionId: 's' }))).toBe(true);
    expect(crewCreated(repo('a-user-id'))).toBe(false);                  // added from a Git URL: createdBy is the person
    expect(crewCreated(repo())).toBe(false);
    expect(crewCreated({ ...projectBody('x'), createdBy: { crewId: 'c', sessionId: 's' } } as unknown as Project)).toBe(true);
    expect(crewCreated(projectBody('x') as unknown as Project)).toBe(false);
    expect(crewCreated(undefined)).toBe(false);
    expect(hasArtifactsCopy(repo({ crewId: 'c', sessionId: 's' }))).toBe(true);
  });

  it('builds a crew-made project, once Smith has read it, without the workspace’s secrets', async () => {
    const f = await crewSetup(); const { turn } = await creating(f);
    expect((await tool(turn.mcp.token, 'crew_create_project', CREATE)).isError).toBe(false);
    const push = (await finishRun(f, turn))!;
    expect((await f.finish(push, { status: 'completed', message: 'pushed', commit: null, createdProjects: [{ id: 'tool-lib', commit: SHA }] })).status).toBe(200);
    fakeArtifacts.setHead(repoNameFor(f.id, 'tool-lib'), 'main', SHA);
    await f.alarm();
    // Its scan finds senet's smith.json (as a machine would report it), so its build actions appear.
    await f.sql(sql => {
      const stored = JSON.parse(sql.exec<{ definition: string }>("SELECT definition FROM projects WHERE id = 'tool-lib'").one().definition) as RepoProject;
      sql.exec("UPDATE projects SET definition = ? WHERE id = 'tool-lib'", JSON.stringify(applyReport(stored, { commit: SHA, branch: 'main', smithJson: senet, paths: [], truncated: false }, 'machine', 'builder', Date.now())));
    });
    const stored = (await projects(f)).find(p => p.id === 'tool-lib') as unknown as RepoProject;
    expect(stored).toMatchObject({ kind: 'repo', scan: { state: 'ready' }, createdBy: { crewId: expect.any(String) } });
    expect(crewCreated(stored)).toBe(true);
    const queued = await f.stub.execute(f.owner, 'enqueue', { requestId: crypto.randomUUID(), projectId: 'tool-lib', product: 'build-check' });
    expect(queued.status, await queued.clone().text()).toBe(201);
    const { id } = await queued.json() as { id: string };
    expect(await f.sql(sql => sql.exec<{ secretless: number }>('SELECT secretless FROM jobs WHERE id = ?', id).one().secretless)).toBe(1);
  });
});
