import { beforeAll, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import identity from '../migrations/0001_identity.sql?raw';
import { Crew, type CrewHooks } from '../src/crew';
import { DEFAULT_WORKSPACE_SETTINGS } from '../src/settings';
import { validateOrchestrationPolicy } from '../src/crew-orchestration-model';
import { crewSetup } from './crew-fixture';

beforeAll(async () => { await env.DB.exec(identity); });
const settings = (crewId: string, target: 'fixerCrewId' | 'testCrewId') => ({ ...DEFAULT_WORKSPACE_SETTINGS,
  orchestration: validateOrchestrationPolicy({ enabled: true, projectRules: { smith: { automation: { mode: 'automatic_fix', [target]: crewId } } } }) });
it.each(['interval', 'branchChanged'])('does not enqueue a configured finding writer through %s', async kind => {
  const f = await crewSetup();
  await f.stub.execute(f.owner, 'put-settings', { crewStopped: true });
  const member = await f.create({ trigger: kind === 'interval' ? { kind, intervalMinutes: 15 } : { kind, checkMinutes: 5 } });
  await f.sql(sql => {
    sql.exec('UPDATE crew_members SET next_run_at=? WHERE id=?', Date.now()-1000, member.id);
    const now = Date.now(); new Crew(sql).enqueueDue(now, settings(member.id, 'fixerCrewId'));
    expect(sql.exec('SELECT * FROM crew_runs WHERE crew_id=?', member.id).toArray()).toHaveLength(0);
    expect(sql.exec<{next_run_at:number}>('SELECT next_run_at FROM crew_members WHERE id=?', member.id).one().next_run_at).toBeGreaterThan(now);
  });
});
it.each(['fixerCrewId', 'testCrewId'] as const)('does not enqueue a configured %s through ordinary build completion', async target => {
  const f = await crewSetup(); const member = await f.create({ trigger: { kind: 'buildFinished', on: 'failed' } });
  await f.sql(sql => {
    new Crew(sql).onJobFinished({ id: 'failure', kind: 'build', request_id: 'ordinary', secretless: 0, project_id: 'smith', state: 'failed' }, Date.now(), settings(member.id, target));
    expect(sql.exec('SELECT * FROM crew_runs WHERE crew_id=?', member.id).toArray()).toHaveLength(0);
  });
});
it('rejects previously queued legacy writer work at start after it becomes an action target', async () => {
  const f = await crewSetup(); const member = await f.create();
  await runInDurableObject(f.stub, (coordinator, state) => {
    const crew = new Crew(state.storage.sql), hooks = (coordinator as unknown as { crewHooks: () => CrewHooks }).crewHooks();
    const result = crew.startRun(crew.member(member.id)!, { id: 'old-legacy', trigger: JSON.stringify({ kind: 'interval' }) }, Date.now(), { ...hooks, settings: settings(member.id, 'fixerCrewId') });
    expect(result).toMatchObject({ code: 'project_report_only', waitReason: 'project automation requires a finding action' });
  });
});
it('rechecks the action-target restriction at claim while preserving explicit manual runs', async () => {
  const f = await crewSetup(); const member = await f.create();
  const { sessionId } = await (await f.run(member.id)).json() as { sessionId: string };
  await f.sql(sql => {
    sql.exec('UPDATE ai_sessions SET trigger=? WHERE id=?', JSON.stringify({ kind: 'interval' }), sessionId);
    sql.exec('UPDATE crew_runs SET trigger=? WHERE session_id=?', JSON.stringify({ kind: 'interval' }), sessionId);
  });
  expect((await f.stub.execute(f.owner, 'put-settings', { orchestration: settings(member.id, 'fixerCrewId').orchestration })).status).toBe(200);
  expect(await f.claim()).toBeNull();
  expect((await f.run(member.id)).status).toBe(201);
  expect(await f.claim()).not.toBeNull();
});
