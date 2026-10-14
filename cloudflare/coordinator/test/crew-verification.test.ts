import { beforeAll, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { CrewReview } from '../src/crew-review';
import identity from '../migrations/0001_identity.sql?raw';
import { crewSetup, commit, errorOf } from './crew-fixture';

beforeAll(async () => { await env.DB.exec(identity); });
type Fixture = Awaited<ReturnType<typeof crewSetup>>;
async function policy(f: Fixture, mode = 'automatic_fix', maxAttempts = 2, enabled = true) {
  const response = await f.stub.execute(f.owner, 'put-settings', { orchestration: { enabled: true, projectRules: { smith: { automation: {
    mode, verification: { enabled, maxAttempts, timeoutMinutes: 3 }
  } } } } });
  expect(response.status, await response.clone().text()).toBe(200);
}
async function proposal(f: Fixture, action = false) {
  const member = await f.create({ name: 'Verifier ' + crypto.randomUUID().slice(0, 8), verifyProduct: 'build' });
  const sessionId = crypto.randomUUID(), runId = crypto.randomUUID();
  await f.sql(sql => {
    sql.exec("INSERT INTO crew_reports (session_id,crew_id,summary,findings,proposal,files,status,created_at,project_id,branch,head_commit,base_commit) VALUES (?,?,'change','[]','{}','[\"src/code.ts\"]','pending',?,'smith','crew/fix',?,?)", sessionId, member.id, Date.now(), 'c'.repeat(40), commit);
    if (action) {
      sql.exec("INSERT INTO crew_runs (id,crew_id,due_at,state,trigger,created_at,updated_at,session_id) VALUES (?,?,1,'completed','manual',1,1,?)", runId, member.id, sessionId);
      sql.exec("INSERT INTO crew_actions (id,finding_id,event_id,kind,target_crew_id,run_id,state,reason,request_id,actor,head_commit,created_at,evidence) VALUES (?,'finding','event','fix',?,?,'queued','',?,?,?,1,'{}')", crypto.randomUUID(), member.id, runId, crypto.randomUUID(), f.operator.userId, commit);
    }
  });
  return { sessionId, member };
}
const verify = (f: Fixture, sessionId: string, requestId: string) => f.stub.execute(f.operator, 'crew-verify', { sessionId, requestId });
const jobs = (f: Fixture) => f.sql(sql => sql.exec<{ id: string; request_id: string; state: string; required_labels: string; specs: string; secretless: number }>("SELECT * FROM jobs WHERE request_id LIKE 'crew-verify-%'").toArray());

it('caps attempts, preserves replay, pins secretless isolated builds and prevents concurrent duplicate verification', async () => {
  const f = await crewSetup(); await policy(f);
  const { sessionId } = await proposal(f);
  expect((await verify(f, sessionId, 'first')).status).toBe(201);
  expect((await verify(f, sessionId, 'first')).status).toBe(201);
  expect(await errorOf(verify(f, sessionId, 'other'))).toMatchObject({ status: 409, code: 'verify_in_progress' });
  let queued = await jobs(f); expect(queued).toHaveLength(1);
  expect(queued[0].secretless).toBe(1); expect(JSON.parse(queued[0].required_labels)).toContain('crew-verify-isolated');
  expect(JSON.parse(queued[0].specs).windows).toMatchObject({ timeoutSeconds: 180, repos: [{ branch: 'crew/fix', commit: 'c'.repeat(40) }] });
  expect(await (await f.stub.execute(f.builder.node, 'claim', {})).json()).toMatchObject({ hasJob: false });
  await f.sql(sql => sql.exec("UPDATE jobs SET state='failed' WHERE id=?", queued[0].id));
  expect((await verify(f, sessionId, 'retry')).status).toBe(201);
  queued = await jobs(f); expect(queued).toHaveLength(2);
  await f.sql(sql => sql.exec("UPDATE jobs SET state='failed' WHERE request_id LIKE 'crew-verify-%'"));
  expect(await errorOf(verify(f, sessionId, 'third'))).toMatchObject({ status: 429, code: 'verify_attempts' });
});
it.each(['queued', 'leased', 'running'])('automatically verifies only action proposals once and cancels %s builds on Stop all', async state => {
  const f = await crewSetup(); await policy(f);
  const action = await proposal(f, true); await proposal(f);
  await f.alarm();
  const queued = await jobs(f); expect(queued).toHaveLength(1); expect(queued[0].request_id).toBe(`crew-verify-${action.sessionId}-auto`);
  await f.sql(sql => sql.exec('UPDATE jobs SET state=? WHERE id=?', state, queued[0].id));
  expect((await f.stub.execute(f.owner, 'put-settings', { crewStopped: true })).status).toBe(200);
  expect((await jobs(f))[0].state).toBe('cancelled');
  await f.stub.execute(f.owner, 'put-settings', { crewStopped: false }); await f.alarm();
  expect(await jobs(f)).toHaveLength(1);
});
it.each(['suggest', 'disabled', 'scheduler_disabled', 'paused', 'stopped', 'removed_actor'])('refuses automatic verification for %s', async reason => {
  const f = await crewSetup(); await policy(f, reason === 'suggest' ? 'suggest' : 'automatic_fix', 2, reason !== 'disabled');
  const { member } = await proposal(f, true);
  if (reason === 'scheduler_disabled') await f.sql(sql => sql.exec("UPDATE settings SET value=json_set(value,'$.orchestration.enabled',false) WHERE id=1"));
  if (reason === 'paused') await f.stub.execute(f.operator, 'crew-enable', { crewId: member.id, enabled: false });
  if (reason === 'stopped') await f.stub.execute(f.owner, 'put-settings', { crewStopped: true });
  if (reason === 'removed_actor') await f.sql(sql => sql.exec('DELETE FROM members WHERE user_id=?', f.operator.userId));
  await f.alarm(); expect(await jobs(f)).toHaveLength(0);
});
it('retains build-definition guards for action verification', async () => {
  const f = await crewSetup(); await policy(f); const { sessionId } = await proposal(f, true);
  await f.sql(sql => sql.exec('UPDATE crew_reports SET files=? WHERE session_id=?', JSON.stringify(['smith.json']), sessionId));
  await f.alarm(); expect(await jobs(f)).toHaveLength(0);
  expect(await f.sql(sql => sql.exec<{message:string}>('SELECT message FROM crew_reports WHERE session_id=?', sessionId).one().message)).toMatch(/^Automatic Verify:.*smith.json/);
  expect(await errorOf(verify(f, sessionId, 'unsafe'))).toMatchObject({ code: 'verify_refused' });
});
it('rechecks automation policy after the read token is minted', async () => {
  const f = await crewSetup(); await policy(f); await proposal(f, true);
  await runInDurableObject(f.stub, async (coordinator, state) => {
    const object = coordinator as unknown as { artifactsReadToken: () => Promise<string>; automaticCrewVerifies: (review: CrewReview) => Promise<void> };
    const original = object.artifactsReadToken;
    object.artifactsReadToken = async () => {
      state.storage.sql.exec("UPDATE settings SET value=json_set(value,'$.orchestration.projectRules.smith.automation.mode','report_only') WHERE id=1");
      return 'minted-before-downgrade';
    };
    try { await object.automaticCrewVerifies(new CrewReview(state.storage.sql)); }
    finally { object.artifactsReadToken = original; }
  });
  expect(await jobs(f)).toHaveLength(0);
});
it('records a failed token mint once and allows a manual retry', async () => {
  const f = await crewSetup(); await policy(f); const { sessionId } = await proposal(f, true);
  await runInDurableObject(f.stub, async (coordinator, state) => {
    const object = coordinator as unknown as { artifactsReadToken: () => Promise<string>; automaticCrewVerifies: (review: CrewReview) => Promise<void> };
    const original = object.artifactsReadToken; let calls = 0;
    object.artifactsReadToken = async () => { calls++; throw new Error('temporary outage'); };
    try {
      await object.automaticCrewVerifies(new CrewReview(state.storage.sql));
      await object.automaticCrewVerifies(new CrewReview(state.storage.sql));
      expect(calls).toBe(1);
      expect(state.storage.sql.exec<{message:string}>('SELECT message FROM crew_reports WHERE session_id=?', sessionId).one().message).toContain('Automatic Verify: Build preparation failed');
    } finally { object.artifactsReadToken = original; }
  });
  expect(await jobs(f)).toHaveLength(0);
  expect((await verify(f, sessionId, 'manual-after-outage')).status).toBe(201);
  expect(await f.sql(sql => sql.exec<{message:string|null}>('SELECT message FROM crew_reports WHERE session_id=?', sessionId).one().message)).toBeNull();
});
it('does not starve eligible verification behind more than a batch of ineligible proposals', async () => {
  const f = await crewSetup(); await policy(f);
  const { sessionId, member } = await proposal(f, true);
  await f.sql(sql => {
    for (let i = 0; i < 101; i++) {
      const oldSession = `older-${i}`, oldRun = `older-run-${i}`;
      sql.exec("INSERT INTO crew_reports (session_id,crew_id,summary,findings,proposal,files,status,created_at,project_id,branch,head_commit,base_commit) VALUES (?,?,'old change','[]','{}','[]','pending',1,'suggest-project','crew/old',?,?)", oldSession, member.id, 'd'.repeat(40), commit);
      sql.exec("INSERT INTO crew_runs (id,crew_id,due_at,state,trigger,created_at,updated_at,session_id) VALUES (?,?,1,'completed','manual',1,1,?)", oldRun, member.id, oldSession);
      sql.exec("INSERT INTO crew_actions (id,finding_id,event_id,kind,target_crew_id,run_id,state,reason,request_id,actor,head_commit,created_at,evidence) VALUES (?,?,?,'fix',?,?,'completed','',?,?,?,1,'{}')", `older-action-${i}`, `older-finding-${i}`, `older-event-${i}`, member.id, oldRun, `older-request-${i}`, f.operator.userId, commit);
    }
  });
  await f.alarm();
  expect(await jobs(f)).toMatchObject([{ request_id: `crew-verify-${sessionId}-auto` }]);
});
