import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import identity from '../migrations/0001_identity.sql?raw';
import { crewSetup, CREW_AI, errorOf } from './crew-fixture';
import { CrewEvents } from '../src/crew-events';
import { CrewFindings } from '../src/crew-findings';
import { CrewActions } from '../src/crew-actions';
import { Crew } from '../src/crew';
import { validateOrchestrationPolicy } from '../src/crew-orchestration-model';

beforeAll(async () => { await env.DB.exec(identity); });
async function fixture(mode = 'suggest') {
  const f = await crewSetup();
  const fixer = await f.create({ name: 'Scoped fixer', orchestration: { mode: 'write', writeScopes: ['src/'] } });
  const tester = await f.create({ name: 'Scoped tester', orchestration: { mode: 'write', writeScopes: ['tests/'] } });
  const automation = { mode, fixerCrewId: fixer.id, testCrewId: tester.id, maxFixAttempts: 2 };
  const policy = { enabled: true, projectRules: { smith: { automation } } };
  expect((await f.stub.execute(f.owner, 'put-settings', { orchestration: policy })).status).toBe(200);
  const machine = await f.machine(f.owner, 'build', { ...CREW_AI, features: [...CREW_AI.features, 'crew-orchestration-v1'] });
  await f.stub.execute(f.owner, 'node-crew', { nodeId: machine.nodeId, run: true });
  const response = await f.stub.execute(f.operator, 'crew-checkin', { projectId: 'smith', branch: 'main', baseCommit: 'a'.repeat(40), headCommit: 'b'.repeat(40), kind: 'push', deliveryId: 'finding-action' });
  const { eventId } = await response.json() as { eventId: string };
  const findingId = await f.sql(sql => {
    new CrewEvents(sql).ready(eventId, { complete: true, ancestor: true, testState: 'unknown', changes: [{ path: 'src/code.ts', oldPath: null, added: 1, deleted: 0 }] }, Date.now());
    new CrewFindings(sql).ingest('source-run', eventId, 'smith', 'b'.repeat(40), { summary: 'Review', findings: [{ severity: 'high', title: 'Bounds error', file: 'src/code.ts', detail: 'The last element is skipped.' }] }, Date.now());
    return sql.exec<{ id: string }>('SELECT id FROM crew_findings').one().id;
  });
  const action = (extra: Record<string, unknown> = {}, who = f.operator) => f.stub.execute(who, 'crew-finding-action', { findingId, eventId, kind: 'fix', requestId: 'request-one', ...extra });
  return { ...f, fixer, tester, machine, eventId, findingId, action, automation };
}

describe('finding actions', () => {
  it('retries a blocked automatic action with its corrected target and exact event', async () => {
    const f = await fixture();
    await f.sql(sql => {
      const policy = validateOrchestrationPolicy({ enabled: true, projectRules: { smith: { automation: { mode: 'automatic_fix' } } } });
      new CrewActions(sql).automatic(new Crew(sql).members(), policy, false, Date.now());
      expect(sql.exec('SELECT target_crew_id,state FROM crew_actions').one()).toMatchObject({ target_crew_id: '', state: 'blocked' });
      sql.exec(`INSERT INTO crew_checkins(id,project_id,repo_key,branch,base_commit,head_commit,kind,source,delivery_id,created_at,updated_at,state,metadata)
        SELECT 'retry-event',project_id,repo_key,branch,base_commit,head_commit,'manual',source,'retry',created_at,updated_at,state,metadata FROM crew_checkins WHERE id=?`, f.eventId);
      new CrewFindings(sql).ingest('retry-source', 'retry-event', 'smith', 'b'.repeat(40), { summary: 'Reviewed again', findings: [
        { severity: 'high', title: 'Bounds error', file: 'src/code.ts', detail: 'Updated evidence on the same exact commit.' },
      ] }, Date.now());
    });
    const response = await f.action({ eventId: 'retry-event' }); expect(response.status).toBe(201);
    const action = await response.json() as { runId: string };
    expect(await f.sql(sql => {
      const row = sql.exec('SELECT target_crew_id,event_id,head_commit,evidence FROM crew_actions').one();
      const policy = validateOrchestrationPolicy({ enabled: true, projectRules: { smith: { automation: f.automation } } });
      return { ...row, evidence: JSON.parse(String(row.evidence)).detail, refusal: new CrewActions(sql).refusal(action.runId, policy) };
    })).toEqual({ target_crew_id: f.fixer.id, event_id: 'retry-event', head_commit: 'b'.repeat(40), evidence: 'Updated evidence on the same exact commit.', refusal: null });
  });
  it('finds automatic projects behind more than fifty newer report-only findings', async () => {
    const f = await fixture();
    await f.sql(sql => {
      const now = Date.now();
      sql.exec(`INSERT INTO crew_checkins(id,project_id,repo_key,branch,base_commit,head_commit,kind,source,delivery_id,created_at,updated_at,state,metadata)
        SELECT 'other-event','other',repo_key,branch,base_commit,head_commit,kind,source,'other',?,?,state,metadata FROM crew_checkins WHERE id=?`, now, now, f.eventId);
      for (let i = 0; i < 51; i++) new CrewFindings(sql).ingest(`other-run-${i}`, 'other-event', 'other', 'b'.repeat(40), {
        summary: 'Other project', findings: [{ severity: 'high', title: `Other finding ${i}`, detail: 'Unrelated evidence.' }],
      }, now + i + 1);
      const policy = validateOrchestrationPolicy({ enabled: true, projectRules: { smith: { automation: { ...f.automation, mode: 'automatic_fix' } }, other: { automation: { mode: 'report_only' } } } });
      new CrewActions(sql).automatic(new Crew(sql).members(), policy, false, now + 100);
      expect(sql.exec('SELECT finding_id,state FROM crew_actions').toArray()).toEqual([{ finding_id: f.findingId, state: 'queued' }]);
    });
  });
  it('applies a lowered attempt cap to queued actions while preserving already consumed work', async () => {
    const f = await fixture();
    const first = await (await f.action()).json() as { runId: string };
    const secondResponse = await f.action({ kind: 'regression_test', requestId: 'test-action' });
    expect(secondResponse.status).toBe(201);
    const second = await secondResponse.json() as { runId: string };
    await f.sql(sql => {
      const policy = validateOrchestrationPolicy({ enabled: true, projectRules: { smith: { automation: { ...f.automation, maxFixAttempts: 1 } } } });
      const actions = new CrewActions(sql);
      expect(actions.refusal(first.runId, policy)).toBeNull();
      expect(actions.refusal(second.runId, policy)).toBe('project action attempt limit lowered');
      sql.exec("INSERT INTO crew_unit_ledger VALUES(?,?,1,'consumed',?) ON CONFLICT(run_id) DO UPDATE SET state='consumed'", second.runId, f.eventId, Date.now());
      expect(actions.refusal(second.runId, policy)).toBeNull();
      expect(actions.refusal(first.runId, policy)).toBe('project action attempt limit lowered');
    });
  });
  it('queues a pinned scoped fix with immutable evidence and deduplicates repeated clicks', async () => {
    const f = await fixture();
    const response = await f.action(); expect(response.status).toBe(201);
    const first = await response.json() as { runId: string };
    expect(await (await f.action()).json()).toMatchObject({ runId: first.runId });
    expect(await (await f.action({ requestId: 'another-click' })).json()).toMatchObject({ runId: first.runId });
    await f.sql(sql => sql.exec('UPDATE crew_findings SET value=? WHERE id=?', JSON.stringify({severity:'high',title:'Bounds error',detail:'New evidence from a later commit'}), f.findingId));
    const detail = await (await f.stub.execute(f.operator, 'crew-checkin-detail', { eventId: f.eventId })).json() as {findings:{value:{detail:string}}[]};
    expect(detail.findings[0].value.detail).toBe('The last element is skipped.');
    await f.alarm();
    const turn = await f.claim(f.machine.node); expect(turn).not.toBeNull();
    expect(turn!.prompt).toContain('The last element is skipped.');
    expect(turn!.prompt).toContain('Request fix');
    expect(turn!.repo).toMatchObject({ commit: 'b'.repeat(40) });
    expect(await f.sql(sql => sql.exec('SELECT * FROM crew_actions').toArray())).toHaveLength(1);
  });
  it('routes regression-test requests to the test writer and caps action attempts per event', async () => {
    const f = await fixture();
    expect((await f.action({ kind: 'regression_test' })).status).toBe(201);
    expect(await f.sql(sql => sql.exec('SELECT target_crew_id FROM crew_actions').one())).toMatchObject({ target_crew_id: f.tester.id });
    expect(await errorOf(f.action({ kind: 'fix' }))).toMatchObject({ status: 409, code: 'request_conflict' });
  });
  it('refuses viewer actions, report-only mode, stopped crew and paused target', async () => {
    const f = await fixture('report_only'); const viewer = await f.member('viewer');
    expect((await f.action({}, viewer)).status).toBe(403);
    expect(await errorOf(f.action())).toMatchObject({ code: 'report_only' });
    await f.stub.execute(f.owner, 'put-settings', { orchestration: { projectRules: { smith: { automation: { ...f.automation, mode: 'suggest' } } } }, crewStopped: true });
    expect(await errorOf(f.action())).toMatchObject({ code: 'stopped' });
    await f.stub.execute(f.owner, 'put-settings', { crewStopped: false });
    await f.stub.execute(f.operator, 'crew-enable', { crewId: f.fixer.id, enabled: false });
    expect(await errorOf(f.action())).toMatchObject({ code: 'target_disabled' });
  });
  it('refuses stale occurrence evidence', async () => {
    const f = await fixture();
    await f.sql(sql => sql.exec('UPDATE crew_finding_occurrences SET head_commit=?', 'c'.repeat(40)));
    expect(await errorOf(f.action())).toMatchObject({ code: 'stale_finding' });
  });
  it('automatically queues at most one fix in automatic mode and exposes it in event details', async () => {
    const f = await fixture('automatic_fix'); await f.alarm(); await f.alarm();
    const detail = await (await f.stub.execute(f.operator, 'crew-checkin-detail', { eventId: f.eventId })).json() as { actions: { kind: string; run_id: string }[] };
    expect(detail.actions).toHaveLength(1); expect(detail.actions[0]).toMatchObject({ kind: 'fix' });
    expect(detail.actions[0].run_id).toBeTruthy();
  });
  it('does not automatically act on findings marked no action', async () => {
    const f = await fixture();
    await f.stub.execute(f.operator, 'crew-finding-decide', { findingId: f.findingId, disposition: 'no_action' });
    await f.stub.execute(f.owner, 'put-settings', { orchestration: { projectRules: { smith: { automation: { ...f.automation, mode: 'automatic_fix' } } } } });
    await f.alarm();
    expect(await f.sql(sql => sql.exec('SELECT * FROM crew_actions').toArray())).toHaveLength(0);
  });
  it('rechecks a policy downgrade before a queued model turn is claimed', async () => {
    const f = await fixture(); expect((await f.action()).status).toBe(201); await f.alarm();
    await f.stub.execute(f.owner, 'put-settings', { orchestration: { projectRules: { smith: { automation: { ...f.automation, mode: 'report_only' } } } } });
    expect(await f.claim(f.machine.node)).toBeNull();
  });
});
