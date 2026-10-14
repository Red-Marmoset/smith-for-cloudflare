// The final review's fixes to the crew: Verify of a cut file list, eligibility re-checked at the claim, crew failures that
// must not stall the workspace, spend accounting, the creator's membership, a build-finished run's log, and the scheduler's
// smaller repairs. Proposals and runs as crew.test.ts drives them, through the workspace's own actions.
import { env } from 'cloudflare:workers';
import { beforeAll, describe, it, expect } from 'vitest';
import identity from '../migrations/0001_identity.sql?raw';
import { fakeArtifacts, repoNameFor } from '../src/artifacts-repos';
import { validateCrewReport } from '../src/crew';
import { CREW_AI, KEY, commit, crewSetup, errorOf, type CrewTurn, type Human, type Member } from './crew-fixture';

beforeAll(async () => { await env.DB.exec(identity); });

type Fixture = Awaited<ReturnType<typeof crewSetup>>;
type Proposal = { sessionId: string; status: string; files: string[]; filesTotal: number | null; filesTruncated: boolean };
const review = async (f: Fixture) => (await (await f.stub.execute(f.operator, 'crew-review', {})).json() as { proposals: Proposal[] }).proposals;
// A run that commits `files`, pushed and confirmed, so its proposal waits in Review. `extra` adds to its finish.
async function proposed(f: Fixture, member: Member, files: string[], extra: Record<string, unknown> = {}, title = 'Tidy') {
  const { sessionId } = await (await f.run(member.id)).json() as { sessionId: string };
  const turn = (await f.claim())!;
  const sha = 'c'.repeat(40);
  const finished = await f.finish(turn, { status: 'completed', message: 'ok', commit: sha, baseCommit: commit, costUsd: 0.2, files, ...extra,
    report: { summary: 'Tidied', findings: [], proposal: { title, summary: 'Tidies' } } });
  expect(finished.status, await finished.clone().text()).toBe(200);
  const push = (await f.claim())!;
  expect((await f.finish(push, { status: 'completed', message: 'pushed', commit: sha })).status).toBe(200);
  fakeArtifacts.seed(repoNameFor(f.id, member.projectIds[0]), push.repo.branch, sha);
  await f.alarm();
  expect((await review(f)).find(p => p.sessionId === sessionId)?.status).toBe('pending');
  return sessionId;
}
const lastStatus = async (f: Fixture, sessionId: string) =>
  (await (await f.stub.execute(f.operator, 'crew-run-events', { sessionId })).json() as { events: { kind: string; data: unknown }[] }).events.at(-1);
type RunRow = { state: string; wait_reason: string | null; session_id: string | null; reserved_usd: number; cost_usd: number | null; budget: string | null };
const runRow = (f: Fixture, runId: string) => f.sql(sql => sql.exec<RunRow>('SELECT state, wait_reason, session_id, reserved_usd, cost_usd, budget FROM crew_runs WHERE id = ?', runId).one());

describe('Verify of a change whose file list was cut', () => {
  it('refuses Verify when the finish says Smith could not record every changed file, and keeps the list’s size', async () => {
    const f = await crewSetup(); const member = await f.create({ verifyProduct: 'build' });
    const cut = await proposed(f, member, ['src/a.cpp'], { filesTotal: 900, filesTruncated: true }, 'Cut');
    expect((await review(f)).find(p => p.sessionId === cut)).toMatchObject({ files: ['src/a.cpp'], filesTotal: 900, filesTruncated: true });
    const tokens = fakeArtifacts.tokens.size;
    expect(await errorOf(f.stub.execute(f.operator, 'crew-verify', { sessionId: cut, requestId: 'v' })))
      .toMatchObject({ status: 409, code: 'verify_refused', message: expect.stringContaining('the change lists more files than Smith could record') });
    expect(fakeArtifacts.tokens.size).toBe(tokens);                                   // refused before any Artifacts call
    // A total larger than the list is a cut list, whatever the flag says.
    const short = await proposed(f, member, ['src/b.cpp'], { filesTotal: 2, filesTruncated: false }, 'Short');
    expect(await errorOf(f.stub.execute(f.operator, 'crew-verify', { sessionId: short, requestId: 'v' }))).toMatchObject({ status: 409, code: 'verify_refused' });
    // A complete list verifies.
    const whole = await proposed(f, member, ['src/c.cpp'], { filesTotal: 1, filesTruncated: false }, 'Whole');
    expect((await f.stub.execute(f.operator, 'crew-verify', { sessionId: whole, requestId: 'v' })).status).toBe(201);
    expect(await f.sql(sql => sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'build'").one().n)).toBe(1);
  });

  it('validates the size fields of a finish', async () => {
    const f = await crewSetup(); const member = await f.create();
    await f.run(member.id);
    const turn = (await f.claim())!;
    const ok = { status: 'completed', message: 'ok', files: ['a', 'b'] };
    for (const bad of [{ filesTotal: -1 }, { filesTotal: 1.5 }, { filesTotal: 1 }, { filesTotal: '3' }, { filesTruncated: 'yes' }])
      expect((await f.finish(turn, { ...ok, ...bad })).status, JSON.stringify(bad)).toBe(400);
    expect((await f.finish(turn, { ...ok, filesTotal: 2, filesTruncated: false })).status).toBe(200);
  });
});

describe('eligibility at the claim', () => {
  // A run is queued for the build machine; `change` then makes that machine unfit before it claims.
  async function refusedAtClaim(f: Fixture, member: Member, change: () => Promise<unknown>, reason: string) {
    const { sessionId, runId } = await (await f.run(member.id)).json() as { sessionId: string; runId: string };
    await change();
    expect(await f.claim()).toBeNull();
    expect(await runRow(f, runId)).toMatchObject({ state: 'waiting', wait_reason: reason, session_id: null, reserved_usd: 0 });
    expect(await lastStatus(f, sessionId)).toMatchObject({ kind: 'status', data: expect.stringContaining('It waits to be started again') });
    expect(await f.sql(sql => sql.exec<{ state: string }>("SELECT state FROM ai_turns WHERE session_id = ? AND kind = 'message'", sessionId).one().state)).toBe('stopped');
    return runId;
  }
  const nodeSql = (f: Fixture, set: string) => f.sql(sql => { sql.exec(`UPDATE nodes SET ${set} WHERE id = ?`, f.builder.nodeId); });

  it('refuses a queued run whose machine left crew work, and runs it once the machine is back', async () => {
    const f = await crewSetup(); const member = await f.create();
    const runId = await refusedAtClaim(f, member, () => nodeSql(f, 'run_crew = 0'), 'machine left crew work');
    await nodeSql(f, 'run_crew = 1'); await f.alarm();
    expect(await runRow(f, runId)).toMatchObject({ state: 'queued' });
    expect((await f.claim())?.sessionKind).toBe('crew');
  });

  it('refuses a queued run whose agent no longer reports the crew feature', async () => {
    const f = await crewSetup(); const member = await f.create();
    const runId = await refusedAtClaim(f, member, () => f.stub.execute(f.builder.node, 'heartbeat', { ai: { ...CREW_AI, features: ['push'] } }), 'agent update needed');
    expect((await f.stub.execute(f.builder.node, 'heartbeat', { ai: CREW_AI })).status).toBe(200);   // a crew machine's heartbeat promotes what waits
    expect(await runRow(f, runId)).toMatchObject({ state: 'queued' });
  });

  it('never hands the workspace key to a machine no longer enrolled for builds', async () => {
    const f = await crewSetup(); const member = await f.create();
    await refusedAtClaim(f, member, () => nodeSql(f, "purpose = 'personal'"), 'personal machine');
  });

  it('refuses a login run whose machine is no longer signed in', async () => {
    const f = await crewSetup(); const member = await f.create({ brain: 'login' });
    const signedIn = (yes: boolean) => f.stub.execute(f.builder.node, 'heartbeat', { ai: { ...CREW_AI, tools: [{ id: 'claude-code', version: '2.1', signedIn: yes }] } });
    expect((await signedIn(true)).status).toBe(200);
    await refusedAtClaim(f, member, () => signedIn(false), 'no signed-in machine');
  });

  it('puts a run back to wait when its key goes between promotion and claim', async () => {
    const f = await crewSetup(); const member = await f.create();
    await refusedAtClaim(f, member, () => f.stub.execute(f.owner, 'put-settings', { clearAnthropicApiKey: true }), 'no API key');
    expect((await f.stub.execute(f.owner, 'put-settings', { anthropicApiKey: KEY })).status).toBe(200);
    expect(await f.runs(member.id)).toMatchObject([{ state: 'queued' }]);
  });

  it('stops a machine’s queued crew turns when its owner turns crew work off there', async () => {
    const f = await crewSetup(); const member = await f.create();
    const { sessionId, runId } = await (await f.run(member.id)).json() as { sessionId: string; runId: string };
    expect((await f.stub.execute(f.owner, 'node-crew', { nodeId: f.builder.nodeId, run: false })).status).toBe(200);
    expect(await runRow(f, runId)).toMatchObject({ state: 'waiting', wait_reason: 'machine left crew work', session_id: null });
    expect(await lastStatus(f, sessionId)).toMatchObject({ kind: 'status', data: expect.stringContaining('turned crew work off') });
    expect(await f.claim()).toBeNull();
  });
});

describe('crew failures never stall the workspace', () => {
  // A table the crew's scheduler reads goes missing, so every promotion throws.
  const breakCrew = (f: Fixture) => f.sql(sql => { sql.exec('ALTER TABLE crew_reports RENAME TO crew_reports_gone'); });

  it('expires leases in an alarm whose crew steps throw', async () => {
    const f = await crewSetup(); const member = await f.create();
    await f.run(member.id);
    const turn = (await f.claim())!;
    await f.sql(sql => { sql.exec('UPDATE ai_turns SET lease_expires_at = ? WHERE id = ?', Date.now() - 1, turn.turnId); });
    await breakCrew(f);
    await f.alarm();
    expect(await f.sql(sql => sql.exec<{ state: string }>('SELECT state FROM ai_turns WHERE id = ?', turn.turnId).one().state)).toBe('lost');
  });

  it('saves Stop all crew, and stops the queued runs, even when promotion throws', async () => {
    const f = await crewSetup(); const member = await f.create();
    const { runId } = await (await f.run(member.id)).json() as { runId: string };
    await breakCrew(f);
    const response = await f.stub.execute(f.owner, 'put-settings', { crewStopped: true });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await (await f.stub.execute(f.owner, 'settings', {})).json()).toMatchObject({ crewStopped: true });
    expect(await runRow(f, runId)).toMatchObject({ state: 'waiting', wait_reason: 'stopped: workspace' });
    expect(await f.claim()).toBeNull();
  });
});

describe('spend accounting', () => {
  it('counts a metered run that started the CLI and reported no cost as having spent its reservation', async () => {
    const f = await crewSetup(); const member = await f.create({ budget: { usdPerRun: 0.75 } });
    const timedOut = await (await f.run(member.id)).json() as { runId: string };
    // After the CLI the agent always reports the file counts; a CLI killed by its time limit reports no cost.
    expect((await f.finish((await f.claim())!, { status: 'failed', message: 'Claude Code exited with code -1', files: [], filesTotal: 0, filesTruncated: false })).status).toBe(200);
    expect(await runRow(f, timedOut.runId)).toMatchObject({ state: 'failed', reserved_usd: 0, cost_usd: 0.75 });
    // A run that never started the CLI (a skip, a failed clone) spent nothing.
    const skipped = await (await f.run(member.id)).json() as { runId: string };
    expect((await f.finish((await f.claim())!, { status: 'completed', message: 'skipped', report: { summary: 'No new commits', findings: [], skipped: true } })).status).toBe(200);
    expect(await runRow(f, skipped.runId)).toMatchObject({ state: 'skipped', cost_usd: null });
    // A run on the machine's sign-in reserves nothing, so it is never charged one.
    const login = await f.create({ name: 'Login', brain: 'login' });
    expect((await f.stub.execute(f.builder.node, 'heartbeat', { ai: { ...CREW_AI, tools: [{ id: 'claude-code', version: '2.1', signedIn: true }] } })).status).toBe(200);
    const free = await (await f.run(login.id)).json() as { runId: string };
    expect((await f.finish((await f.claim())!, { status: 'failed', message: 'x', files: [], filesTotal: 0, filesTruncated: false })).status).toBe(200);
    expect(await runRow(f, free.runId)).toMatchObject({ cost_usd: null });
  });

  it('holds a run to the budget it was promoted with, though the member’s budget is raised before its claim', async () => {
    const f = await crewSetup(); const member = await f.create({ budget: { usdPerRun: 0.5, maxMinutes: 10 } });
    const { runId, sessionId } = await (await f.run(member.id)).json() as { runId: string; sessionId: string };
    expect(JSON.parse((await runRow(f, runId)).budget!)).toMatchObject({ usdPerRun: 0.5, maxMinutes: 10 });
    expect((await f.stub.execute(f.operator, 'crew-put', { id: member.id, budget: { usdPerRun: 5, maxMinutes: 120 } })).status).toBe(200);
    const before = Date.now();
    const turn = (await f.claim())! as CrewTurn & { budget: { usdPerRun: number; maxMinutes: number } };
    expect(turn.budget).toMatchObject({ usdPerRun: 0.5, maxMinutes: 10 });
    expect(turn.systemPrompt).toContain('up to $0.50 and 10 minutes');
    const expires = await f.sql(sql => sql.exec<{ expires_at: number }>('SELECT expires_at FROM access_tokens WHERE session_id = ?', sessionId).one().expires_at);
    expect(expires).toBeLessThanOrEqual(Date.now() + 25 * 60000);
    expect(expires).toBeGreaterThanOrEqual(before + 25 * 60000 - 5000);
  });
});

describe('the member’s creator', () => {
  it('waits while its creator has left the workspace or is below operator, and an operator’s re-save takes the member over', async () => {
    const f = await crewSetup(); const member = await f.create();
    const role = (who: Human, value: string | null) => f.sql(sql => {
      sql.exec('DELETE FROM members WHERE user_id = ?', who.userId);
      if (value) sql.exec('INSERT INTO members (user_id, role) VALUES (?, ?)', who.userId, value);
    });
    await role(f.operator, null);
    expect(await errorOf(f.run(member.id, f.owner))).toMatchObject({ status: 409, code: 'creator_missing', waitReason: 'creator not in workspace' });
    await role(f.operator, 'viewer');
    expect(await errorOf(f.run(member.id, f.owner))).toMatchObject({ status: 409, code: 'creator_demoted', waitReason: 'creator demoted' });
    // The owner saves the member: its runs are now the owner's.
    const saved = await f.stub.execute(f.owner, 'crew-put', { id: member.id });
    expect(await saved.json()).toMatchObject({ createdBy: f.owner.userId });
    const { sessionId } = await (await f.run(member.id, f.owner)).json() as { sessionId: string };
    expect(await f.sql(sql => sql.exec<{ owner_user_id: string }>('SELECT owner_user_id FROM ai_sessions WHERE id = ?', sessionId).one().owner_user_id)).toBe(f.owner.userId);
  });
});

describe('a build-finished run', () => {
  // A failed build of the member's project, with its log as the build machine streamed it.
  async function failedBuild(f: Fixture, chunks: string[][]) {
    const queued = await (await f.stub.execute(f.owner, 'enqueue', { requestId: crypto.randomUUID(), projectId: 'smith', product: 'build' })).json() as { id: string };
    const claim = await (await f.stub.execute(f.builder.node, 'claim', {})).json() as { envelope: { lease: Record<string, unknown> } };
    await f.sql(sql => chunks.forEach((lines, seq) => sql.exec("INSERT INTO logs (job_id, attempt_id, seq, stream, lines, byte_count, received_at) VALUES (?, 'a', ?, 'stdout', ?, 0, 0)",
      queued.id, seq, JSON.stringify(lines))));
    expect((await f.stub.execute(f.builder.node, 'complete', { ...claim.envelope.lease, result: { status: 'failed', exitCode: 1, durationMs: 1, message: '' } })).status).toBe(200);
    return queued.id;
  }

  it('hands the run the tail of the build’s log, which its prompt names', async () => {
    const f = await crewSetup(); const member = await f.create({ name: 'Test proposer', trigger: { kind: 'buildFinished', on: 'failed' } });
    const jobId = await failedBuild(f, [['first line', 'x'.repeat(40000)], ['y'.repeat(40000), 'error: the last line']]);
    await f.alarm();
    const turn = (await f.claim())! as CrewTurn & { buildLog?: { jobId: string; text: string } };
    expect(turn.prompt).toContain(`input/build-${jobId}.log`);
    expect(turn.buildLog?.jobId).toBe(jobId);
    const text = turn.buildLog!.text;
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(65536);
    expect(text.endsWith('error: the last line\n')).toBe(true);
    expect(text).not.toContain('first line');
    expect(text.startsWith('[earlier output cut by Smith]\n')).toBe(true);
    // Any other run's claim carries no build log.
    expect((await f.finish(turn, { status: 'completed', message: 'ok' })).status).toBe(200);
    await f.run(member.id);
    expect(await f.claim()).not.toHaveProperty('buildLog');
  });

  it('offers the newest build when a later one fails while the run still waits', async () => {
    const f = await crewSetup(); const member = await f.create({ name: 'Test proposer', trigger: { kind: 'buildFinished', on: 'failed' } });
    expect((await f.stub.execute(f.owner, 'put-settings', { crewStopped: true })).status).toBe(200);
    await failedBuild(f, [['one']]);
    const newer = await failedBuild(f, [['two']]);
    expect(await f.runs(member.id)).toMatchObject([{ state: 'waiting', trigger: { kind: 'buildFinished', jobId: newer } }]);
  });
});

describe('smaller repairs', () => {
  it('never answers a replayed Run now with the session it stopped', async () => {
    const f = await crewSetup(); const member = await f.create();
    const first = await (await f.run(member.id, f.operator, 'again')).json() as { sessionId: string };
    expect((await f.stub.execute(f.owner, 'put-settings', { crewStopped: true })).status).toBe(200);
    expect(await errorOf(f.run(member.id, f.operator, 'again'))).toMatchObject({ status: 409, code: 'stopped' });
    expect((await f.stub.execute(f.owner, 'put-settings', { crewStopped: false })).status).toBe(200);
    const replay = await (await f.run(member.id, f.operator, 'again')).json() as { sessionId: string };
    expect(replay.sessionId).not.toBe(first.sessionId);
  });

  it('limits a report’s memory by bytes, as crew_remember does', () => {
    expect(validateCrewReport({ summary: 's', findings: [], memory: 'é'.repeat(16384) }).memory).toHaveLength(16384);   // 32768 bytes
    expect(() => validateCrewReport({ summary: 's', findings: [], memory: 'é'.repeat(16385) })).toThrow(/32768 bytes/);
  });
});
