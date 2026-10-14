import { beforeAll, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import identity from '../migrations/0001_identity.sql?raw';
import { CrewEvents } from '../src/crew-events';
import { crewSetup, CREW_AI } from './crew-fixture';
beforeAll(async () => { await env.DB.exec(identity); });
async function setup() {
  const f = await crewSetup();
  await f.stub.execute(f.owner, 'put-settings', { orchestration: { enabled: true }, crewMaxConcurrentRuns: 3 });
  await f.sql(sql => sql.exec('UPDATE nodes SET ai=? WHERE id=?', JSON.stringify({ ...CREW_AI, features: [...CREW_AI.features, 'crew-orchestration-v1'] }), f.builder.nodeId));
  const member = await f.create({ permissionMode: 'plan', orchestration: { events: ['push'] } });
  async function event(branch = 'main', projectId = 'smith') {
    const response = await f.stub.execute(f.operator, 'crew-checkin', { projectId, branch, kind: 'push', baseCommit: 'a'.repeat(40), headCommit: 'b'.repeat(40), deliveryId: crypto.randomUUID() });
    const { eventId } = await response.json() as { eventId: string };
    await f.sql(sql => new CrewEvents(sql).ready(eventId, { changes: [{ path: 'src/a.ts', oldPath: null, added: 1, deleted: 0 }], complete: true, ancestor: true, testState: 'unknown' }, Date.now()));
    await f.alarm(); return eventId;
  }
  return { ...f, member, event };
}
it.each(['disabled', 'capability', 'repository'])('rechecks %s at event claim without consuming units', async reason => {
  const f = await setup(), id = await f.event();
  if (reason === 'disabled') await f.stub.execute(f.owner, 'put-settings', { orchestration: { enabled: false } });
  if (reason === 'capability') await f.sql(sql => sql.exec('UPDATE nodes SET ai=? WHERE id=?', JSON.stringify(CREW_AI), f.builder.nodeId));
  if (reason === 'repository') await f.sql(sql => sql.exec("UPDATE projects SET definition=json_set(definition,'$.repoUrl','https://github.com/other/repo.git') WHERE id='smith'"));
  expect(await f.claim()).toBeNull();
  expect(await f.sql(sql => sql.exec<{ state: string }>('SELECT state FROM crew_unit_ledger WHERE event_id=?', id).toArray().some(row => row.state === 'consumed'))).toBe(false);
});
it.each(['expired', 'stopped'])('rejects tools from a %s turn without waiting for an alarm', async reason => {
  const f = await setup(); await f.event(); const turn = (await f.claim())!;
  await f.sql(sql => sql.exec(reason === 'expired' ? 'UPDATE ai_turns SET lease_expires_at=0 WHERE id=?' : 'UPDATE ai_turns SET stop_requested=1 WHERE id=?', turn.turnId));
  const response = await f.stub.execute({ kind: 'token', token: turn.mcp.token }, 'crew-tool-remember', { text: 'late change' });
  expect(response.status).toBe(401);
  expect((await f.list()).find(m => m.id === f.member.id)?.memory).not.toBe('late change');
});
it('recovers an interrupted metadata read without a native job', async () => {
  const f = await setup();
  const response = await f.stub.execute(f.operator, 'crew-checkin', { projectId: 'smith', branch: 'main', kind: 'push', baseCommit: 'a'.repeat(40), headCommit: 'b'.repeat(40), deliveryId: 'interrupted' });
  const { eventId } = await response.json() as { eventId: string };
  await f.sql(sql => sql.exec("UPDATE crew_checkins SET state='loading',job_id=NULL,next_at=NULL,updated_at=? WHERE id=?", Date.now() - 120000, eventId));
  await f.alarm();
  expect(await f.sql(sql => sql.exec<{ state: string }>('SELECT state FROM crew_checkins WHERE id=?', eventId).one().state)).toBe('blocked');
  expect((await f.stub.execute(f.operator, 'crew-checkin-retry', { eventId })).status).toBe(200);
});
it('keeps separate event runs when an unclaimed run is requeued', async () => {
  const f = await setup(); const first = await f.event('first'), second = await f.event('second');
  await f.stub.execute(f.owner, 'node-crew', { nodeId: f.builder.nodeId, run: false });
  const rows = await f.sql(sql => sql.exec<{ event_id: string; state: string }>('SELECT event_id,state FROM crew_runs WHERE crew_id=?', f.member.id).toArray());
  expect(rows).toEqual(expect.arrayContaining([{ event_id: first, state: 'waiting' }, { event_id: second, state: 'waiting' }]));
});
it('blocks legacy project aliases and refuses repository changes at admission', async () => {
  const f = await setup();
  await f.sql(sql => sql.exec("INSERT INTO projects SELECT 'alias',json_set(definition,'$.id','alias','$.name','Alias') FROM projects WHERE id='smith'"));
  const legacy = await f.create({ name: 'Legacy' }); await f.run(legacy.id);
  await f.stub.execute(f.operator, 'crew-put', { id: f.member.id, projectIds: ['alias'] });
  const machine = await f.machine(f.owner, 'build', { ...CREW_AI, features: [...CREW_AI.features, 'crew-orchestration-v1'] });
  await f.stub.execute(f.owner, 'node-crew', { nodeId: machine.nodeId, run: true });
  await f.event('main', 'alias');
  expect((await f.runs(f.member.id))[0]).toMatchObject({ state: 'waiting' });
  await f.sql(sql => {
    sql.exec("UPDATE projects SET definition=json_set(definition,'$.repoUrl','https://github.com/other/repo.git') WHERE id='alias'");
    sql.exec("UPDATE ai_turns SET state='stopped'"); sql.exec("UPDATE crew_runs SET state='stopped' WHERE crew_id=?", legacy.id);
  });
  await f.alarm();
  expect((await f.runs(f.member.id))[0]).toMatchObject({ state: 'waiting', waitReason: 'repository changed' });
});
it('queues a fresh metadata job when a check-in whose native job failed is retried', async () => {
  const f = await setup();
  const response = await f.stub.execute(f.operator, 'crew-checkin', { projectId: 'smith', branch: 'main', kind: 'push', baseCommit: 'a'.repeat(40), headCommit: 'b'.repeat(40), deliveryId: 'retried' });
  const { eventId } = await response.json() as { eventId: string };
  const checkIn = () => f.sql(sql => sql.exec<{ state: string; job_id: string | null }>('SELECT state,job_id FROM crew_checkins WHERE id=?', eventId).one());
  await f.alarm();
  const first = await checkIn();
  expect(first).toMatchObject({ state: 'loading', job_id: expect.any(String) });
  await f.sql(sql => sql.exec("UPDATE jobs SET state='failed' WHERE id=?", first.job_id));
  await f.alarm();
  expect((await checkIn()).state).toBe('blocked');
  expect((await f.stub.execute(f.operator, 'crew-checkin-retry', { eventId })).status).toBe(200);
  await f.alarm();   // the retry's job must not collide with the failed one's request id
  const second = await checkIn();
  expect(second).toMatchObject({ state: 'loading', job_id: expect.any(String) });
  expect(second.job_id).not.toBe(first.job_id);
});
it('Run now leaves a waiting check-in run to its event', async () => {
  const f = await setup();
  await f.stub.execute(f.owner, 'node-crew', { nodeId: f.builder.nodeId, run: false });
  const eventId = await f.event();
  const later = Date.now() + 3600000;   // still inside its debounce window
  await f.sql(sql => sql.exec('UPDATE crew_runs SET due_at=? WHERE crew_id=? AND event_id=?', later, f.member.id, eventId));
  await f.stub.execute(f.owner, 'node-crew', { nodeId: f.builder.nodeId, run: true });
  const response = await f.run(f.member.id);
  expect(response.status, await response.clone().text()).toBe(201);
  const eventRun = await f.sql(sql => sql.exec<{ id: string; state: string; due_at: number; trigger: string }>('SELECT id,state,due_at,trigger FROM crew_runs WHERE event_id=?', eventId).one());
  expect((await response.json() as { runId: string }).runId).not.toBe(eventRun.id);
  expect(eventRun).toMatchObject({ state: 'waiting', due_at: later });
  expect(JSON.parse(eventRun.trigger).kind).not.toBe('manual');
});
