import { env } from 'cloudflare:workers';
import { runInDurableObject, runDurableObjectAlarm, abortAllDurableObjects } from 'cloudflare:test';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import schema from '../migrations/0001_identity.sql?raw';
import browserSchema from '../migrations/0002_browser_auth.sql?raw';
import directorySchema from '../migrations/0003_workspace_directory.sql?raw';
import { CREW_AI, commit, crewSetup, errorOf } from './crew-fixture';
import { Crew, type FinishedJob } from '../src/crew';

const origin = 'https://exp.redmarmosetstudios.com';
beforeAll(async () => { await env.DB.exec(schema); await env.DB.exec(browserSchema); await env.DB.exec(directorySchema); });
async function call(path: string, token = '', body?: unknown) {
  return worker.fetch(new Request(origin + '/api/v2' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env);
}
async function person() {
  const token = crypto.randomUUID(); const userId = crypto.randomUUID();
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))), b => b.toString(16).padStart(2, '0')).join('');
  await env.DB.batch([
    env.DB.prepare('INSERT INTO users (id, created_at) VALUES (?, ?)').bind(userId, Date.now()),
    env.DB.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').bind(hash, userId, Date.now() + 60000),
  ]);
  return { token, userId };
}
async function fixture() {
  const owner = await person();
  const response = await call('/workspaces', owner.token, { requestId: crypto.randomUUID() });
  expect(response.status).toBe(201);
  const { workspaceId } = await response.json() as { workspaceId: string };
  const base = `/workspaces/${workspaceId}`;
  const node = async () => {
    const codeResponse = await call(base + '/enrollments', owner.token, {});
    expect(codeResponse.status).toBe(201);
    const { code } = await codeResponse.json() as { code: string };
    const response = await call(base + '/nodes/enroll', '', { code, protocolVersion: 2, os: 'linux' });
    expect(response.status).toBe(201);
    const credentials = await response.json() as { nodeId: string; token: string };
    return { ...credentials, code };
  };
  const enqueue = async (requestId = crypto.randomUUID()) => {
    const response = await call(base + '/jobs', owner.token, { requestId, projectId: 'smoke' });
    expect(response.status).toBe(201);
    return await response.json() as { id: string; state: string };
  };
  return { owner, workspaceId, base, node, enqueue };
}
type Assignment = { hasJob: boolean; envelope: { lease: { jobId: string; attemptId: string; leaseToken: string }; spec: { projectId: string } } };
describe('durable hosted scheduling', () => {
  it('authorizes from membership, not the workspace URL, and revokes sessions immediately', async () => {
    const f = await fixture(); const stranger = await person();
    expect((await call(f.base + '/jobs', stranger.token)).status).toBe(403);
    expect((await call(f.base + '/jobs', stranger.token, { requestId: 'foreign', projectId: 'smoke' })).status).toBe(403);
    await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(f.owner.userId).run();
    expect((await call(f.base + '/jobs', f.owner.token)).status).toBe(401);
  });
  it('reserves workspace capacity atomically under concurrent creation', async () => {
    const owner = await person();
    for (let i = 0; i < 19; i++) await env.DB.prepare('INSERT INTO workspace_directory VALUES (?, ?, ?)').bind(`reserved-${owner.userId}-${i}`, owner.userId, 'Reserved').run();
    const responses = await Promise.all(['a', 'b'].map(requestId => call('/workspaces', owner.token, { requestId })));
    expect(responses.map(r => r.status).sort()).toEqual([201, 429]);
  });
  it('deduplicates enqueue and grants one replayable lease under concurrent claims', async () => {
    const f = await fixture(); const a = await f.node(); const b = await f.node();
    const job = await f.enqueue('same-request');
    expect((await f.enqueue('same-request')).id).toBe(job.id);
    const responses = await Promise.all([call(f.base + '/claims', a.token, {}), call(f.base + '/claims', b.token, {})]);
    const assignments = await Promise.all(responses.map(r => r.json())) as Assignment[];
    expect(assignments.filter(x => x.hasJob)).toHaveLength(1);
    const index = assignments.findIndex(x => x.hasJob); const winner = index === 0 ? a : b;
    const assignment = assignments[index];
    expect(assignment.envelope.lease.jobId).toBe(job.id);
    expect(assignment.envelope.spec.projectId).toBe('smoke');
    const replay = await (await call(f.base + '/claims', winner.token, {})).json();
    expect(replay).toEqual(assignment);
    const result = { ...assignment.envelope.lease, result: { status: 'success', exitCode: 0, durationMs: 12, message: 'fixture' } };
    expect((await call(f.base + '/complete', winner.token, result)).status).toBe(200);
    expect((await call(f.base + '/complete', winner.token, result)).status).toBe(200);
    expect((await call(f.base + '/complete', winner.token, { ...result, result: { ...result.result, status: 'failed' } })).status).toBe(409);
    const read = await (await call(f.base + '/jobs/' + job.id, f.owner.token)).json();
    expect(read).toMatchObject({ id: job.id, state: 'success' });
    expect(JSON.stringify(read)).not.toContain(assignment.envelope.lease.leaseToken);
  });
  it('builds a crew-created project without workspace secrets or its own env, and only the server can mark one', async () => {
    const f = await fixture(); const stub = env.WORKSPACES.getByName(f.workspaceId); const human = { kind: 'human' as const, userId: f.owner.userId };
    const TOKEN = 'cf_test_token_1234567890abcdefghij'; const ACCOUNT = 'c'.repeat(32);
    expect((await stub.execute(human, 'put-settings', { cloudflareApiToken: TOKEN, cloudflareAccountId: ACCOUNT })).status).toBe(200);
    const project = { id: 'crew-toy', name: 'Crew toy', repoUrl: 'https://github.com/Red-Marmoset/crew-toy.git', branch: 'main', commit: 'a'.repeat(40),
      products: [{ name: 'build', description: '', labels: [], timeoutSeconds: 60, commands: { linux: { interpreter: 'sh', script: 'build.sh', args: [] } }, env: { GREETING: 'hi', CLOUDFLARE_API_TOKEN: 'mine' } }] };
    // createdBy / purpose are server-set only: a caller supplying them is rejected like any unknown field.
    expect((await stub.execute(human, 'put-project', { ...project, createdBy: { crewId: 'crew-1', sessionId: 'session-1' } })).status).toBe(400);
    expect((await stub.execute(human, 'put-project', { ...project, purpose: 'toy' })).status).toBe(400);
    expect((await stub.execute(human, 'put-project', project)).status).toBe(201);
    const node = await f.node();
    const claimEnv = async (requestId: string) => {
      const queued = await (await stub.execute(human, 'enqueue', { requestId, projectId: 'crew-toy', product: 'build' })).json() as { id: string; secretless: boolean };
      const claim = await (await call(f.base + '/claims', node.token, {})).json() as { envelope: { lease: { jobId: string }; spec: { env: Record<string, string> } } };
      expect(claim.envelope.lease.jobId).toBe(queued.id);
      expect((await call(f.base + '/complete', node.token, { ...claim.envelope.lease, result: { status: 'success', exitCode: 0, durationMs: 1, message: '' } })).status).toBe(200);
      return { env: claim.envelope.spec.env, secretless: queued.secretless };
    };
    // A human-made project is an ordinary build.
    expect(await claimEnv('ordinary')).toEqual({ secretless: false, env: { GREETING: 'hi', CLOUDFLARE_API_TOKEN: 'mine', CLOUDFLARE_ACCOUNT_ID: ACCOUNT } });
    // The same project, once a crew created it, is not.
    await runInDurableObject(stub, (_o, state) => { state.storage.sql.exec("UPDATE projects SET definition = json_set(definition, '$.createdBy', json(?), '$.purpose', 'toy') WHERE id = 'crew-toy'", JSON.stringify({ crewId: 'crew-1', sessionId: 'session-1' })); });
    const crew = await claimEnv('crew-made');
    expect(crew.secretless).toBe(true);
    expect(crew.env).toMatchObject({ CLOUDFLARE_API_TOKEN: '', ANTHROPIC_API_KEY: '', GITHUB_TOKEN: '', CLOUDFLARE_ACCOUNT_ID: ACCOUNT });
    expect(crew.env).not.toHaveProperty('GREETING');
  });
  it('keeps a crew-created project crew-created when a person edits it', async () => {
    const f = await fixture(); const stub = env.WORKSPACES.getByName(f.workspaceId); const human = { kind: 'human' as const, userId: f.owner.userId };
    const project = { id: 'crew-toy', name: 'Crew toy', repoUrl: 'https://github.com/Red-Marmoset/crew-toy.git', branch: 'main', commit: 'a'.repeat(40),
      products: [{ name: 'build', description: '', labels: [], timeoutSeconds: 60, commands: { linux: { interpreter: 'sh', script: 'build.sh', args: [] } } }] };
    const createdBy = { crewId: 'crew-1', sessionId: 'session-1' };
    // Seeded as the server would have written it: put-project itself never accepts these fields.
    await runInDurableObject(stub, (_o, state) => { state.storage.sql.exec('INSERT INTO projects VALUES (?, ?)', 'crew-toy', JSON.stringify({ ...project, products: project.products.map(p => ({ ...p, env: {}, artifacts: { globs: [], package: 'none' }, workingDir: '.' })), createdBy, purpose: 'toy' })); });
    const stored = () => runInDurableObject(stub, (_o, state) => JSON.parse(state.storage.sql.exec<{ definition: string }>("SELECT definition FROM projects WHERE id = 'crew-toy'").one().definition) as Record<string, unknown>);
    // A person edits it (new name, new pinned commit); the marker survives, so there is no way to launder a crew project.
    expect((await stub.execute(human, 'put-project', { ...project, name: 'Renamed toy', commit: 'b'.repeat(40) })).status).toBe(201);
    expect(await stored()).toMatchObject({ name: 'Renamed toy', commit: 'b'.repeat(40), createdBy, purpose: 'toy' });
    const queued = await (await stub.execute(human, 'enqueue', { requestId: 'after-edit', projectId: 'crew-toy', product: 'build' })).json() as { secretless: boolean };
    expect(queued.secretless).toBe(true);
  });
  it('rejects reused enrollment codes and a revoked node credential', async () => {
    const f = await fixture(); const node = await f.node();
    expect((await call(f.base + '/nodes/enroll', '', { code: node.code, protocolVersion: 2, os: 'linux' })).status).toBe(401);
    expect((await call(f.base + '/nodes/' + node.nodeId + '/revoke', f.owner.token, {})).status).toBe(200);
    expect((await call(f.base + '/claims', node.token, {})).status).toBe(401);
  });
  it('reconstructs durable leases and keeps the enqueued specification frozen', async () => {
    const f = await fixture(); const node = await f.node(); const job = await f.enqueue();
    const stub = env.WORKSPACES.getByName(f.workspaceId);
    const frozen = await runInDurableObject(stub, async (_object, state) => {
      return state.storage.sql.exec<{ specs: string }>('SELECT specs FROM jobs WHERE id = ?', job.id).one().specs;
    });
    expect(JSON.parse(frozen).linux.command.args).toEqual(['Smith Cloudflare smoke']);
    const first = await (await call(f.base + '/claims', node.token, {})).json();
    await abortAllDurableObjects();
    expect(await (await call(f.base + '/claims', node.token, {})).json()).toEqual(first);
    expect((await call(f.base + '/jobs', f.owner.token)).status).toBe(200);
  });
  it('keeps accepted completion when D1 history is unavailable and retries the outbox', async () => {
    const f = await fixture(); const node = await f.node(); const job = await f.enqueue();
    const assignment = await (await call(f.base + '/claims', node.token, {})).json() as Assignment;
    const stub = env.WORKSPACES.getByName(f.workspaceId);
    await env.DB.exec('ALTER TABLE job_history RENAME TO unavailable_history');
    try {
      expect((await call(f.base + '/complete', node.token, { ...assignment.envelope.lease, result: { status: 'success', exitCode: 0, durationMs: 1, message: '' } })).status).toBe(200);
      await runDurableObjectAlarm(stub);
      expect(await (await call(f.base + '/jobs/' + job.id, f.owner.token)).json()).toMatchObject({ state: 'success' });
      const pending = await runInDurableObject(stub, async (_object, state) => state.storage.sql.exec('SELECT * FROM outbox').toArray().length);
      expect(pending).toBeGreaterThan(0);
    } finally { await env.DB.exec('ALTER TABLE unavailable_history RENAME TO job_history'); }
    await runDurableObjectAlarm(stub);
    expect(await env.DB.prepare('SELECT state FROM job_history WHERE workspace_id = ? AND job_id = ?').bind(f.workspaceId, job.id).first()).toEqual({ state: 'success' });
  });
  it('does not postpone a pending projection when clients poll jobs', async () => {
    const f = await fixture(); await f.enqueue();
    const stub = env.WORKSPACES.getByName(f.workspaceId);
    const before = await runInDurableObject(stub, (_object, state) => state.storage.getAlarm());
    await new Promise(resolve => setTimeout(resolve, 20));
    await call(f.base + '/jobs', f.owner.token);
    const after = await runInDurableObject(stub, (_object, state) => state.storage.getAlarm());
    expect(after).toBe(before);
  });
  it('allows node renewal and completion during a complete D1 outage', async () => {
    const f = await fixture(); const node = await f.node(); await f.enqueue();
    const assignment = await (await call(f.base + '/claims', node.token, {})).json() as Assignment;
    const unavailableDB = new Proxy(env.DB, { get() { return () => { throw new Error('D1 unavailable'); }; } });
    for (const [route, body] of [
      ['renew', assignment.envelope.lease],
      ['complete', { ...assignment.envelope.lease, result: { status: 'success', exitCode: 0, durationMs: 1, message: '' } }],
    ] as const) {
      const response = await worker.fetch(new Request(origin + '/api/v2' + f.base + '/' + route, {
        method: 'POST', headers: { Authorization: `Bearer ${node.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      }), { ...env, DB: unavailableDB });
      expect(response.status).toBe(200);
    }
  });
  it('enforces node capacity when outstanding enrollment codes are redeemed', async () => {
    const f = await fixture();
    const { code } = await (await call(f.base + '/enrollments', f.owner.token, {})).json() as { code: string };
    await runInDurableObject(env.WORKSPACES.getByName(f.workspaceId), (_object, state) => {
      for (let i = 0; i < 50; i++) state.storage.sql.exec('INSERT INTO nodes (id, token_hash, os, active) VALUES (?, ?, ?, 1)', `fixture-${i}`, `hash-${i}`, 'linux');
    });
    expect((await call(f.base + '/nodes/enroll', '', { code, protocolVersion: 2, os: 'linux' })).status).toBe(429);
  });
  it('fences expired attempts and persists expiry through the alarm', async () => {
    const f = await fixture(); const node = await f.node(); const job = await f.enqueue();
    const assignment = await (await call(f.base + '/claims', node.token, {})).json() as Assignment;
    const stub = env.WORKSPACES.getByName(f.workspaceId);
    await runInDurableObject(stub, async (_object, state) => {
      state.storage.sql.exec('UPDATE jobs SET lease_expires_at = ? WHERE id = ?', Date.now() - 1, job.id);
    });
    expect((await call(f.base + '/renew', node.token, assignment.envelope.lease)).status).toBe(409);
    await runDurableObjectAlarm(stub);
    expect(await (await call(f.base + '/jobs/' + job.id, f.owner.token)).json()).toMatchObject({ state: 'lost' });
    expect((await call(f.base + '/complete', node.token, { ...assignment.envelope.lease, result: { status: 'success', exitCode: 0, durationMs: 1, message: '' } })).status).toBe(409);
  });
  it('blocks viewer mutation and respects removed membership', async () => {
    const f = await fixture();
    await runInDurableObject(env.WORKSPACES.getByName(f.workspaceId), async (_object, state) => {
      state.storage.sql.exec('UPDATE members SET role = ? WHERE user_id = ?', 'viewer', f.owner.userId);
    });
    expect((await call(f.base + '/jobs', f.owner.token)).status).toBe(200);
    expect((await call(f.base + '/jobs', f.owner.token, { requestId: 'denied', projectId: 'smoke' })).status).toBe(403);
    await runInDurableObject(env.WORKSPACES.getByName(f.workspaceId), async (_object, state) => {
      state.storage.sql.exec('DELETE FROM members WHERE user_id = ?', f.owner.userId);
    });
    expect((await call(f.base + '/jobs', f.owner.token)).status).toBe(403);
  });
  it('rejects v1, foreign origins, oversized input and unsupported project configuration', async () => {
    const f = await fixture();
    expect((await call(f.base + '/nodes/enroll', '', { code: 'x', protocolVersion: 1, os: 'linux' })).status).toBe(426);
    expect((await call(f.base + '/jobs', f.owner.token, { requestId: 'bad', projectId: 'smoke', command: 'rm' })).status).toBe(400);
    expect((await call(f.base + '/jobs', f.owner.token, { requestId: 'x'.repeat(70000), projectId: 'smoke' })).status).toBe(413);
    const response = await worker.fetch(new Request(origin + '/api/v2/workspaces', { method: 'POST', headers: { Authorization: `Bearer ${f.owner.token}`, Origin: 'https://foreign.test', 'Content-Type': 'application/json' }, body: '{}' }), env);
    expect(response.status).toBe(403);
  });
});

// The crew's scheduler: waiting runs promoted from the alarm, finishes, build completions and heartbeats, under the
// workspace's caps (crew-fixture.ts builds the workspace: the smith project copied to Artifacts, one opted-in build machine).
describe('crew scheduler', () => {
  const interval = { kind: 'interval', intervalMinutes: 60 };
  type Run = { id: string; sessionId: string | null; nodeId: string | null; state: string; waitReason: string | null; trigger: Record<string, unknown> };
  const runsOf = async (f: Awaited<ReturnType<typeof crewSetup>>, crewId: string) => await f.runs(crewId) as Run[];

  it('promotes due interval members first come, first served under the concurrency cap, and never skips a waiting run inside the hour', async () => {
    const f = await crewSetup(); await f.copied('tools'); await f.copied('docs');
    const [a, b, c] = [await f.create({ name: 'A', projectIds: ['smith'], trigger: interval }), await f.create({ name: 'B', projectIds: ['tools'], trigger: interval }),
      await f.create({ name: 'C', projectIds: ['docs'], trigger: interval })];
    await f.due(a.id, 3000); await f.due(b.id, 2000); await f.due(c.id, 1000);
    const before = Date.now();
    await f.alarm();
    expect(await runsOf(f, a.id)).toMatchObject([{ state: 'queued', trigger: { kind: 'interval' } }]);
    for (const id of [b.id, c.id]) expect(await runsOf(f, id)).toMatchObject([{ state: 'waiting', waitReason: 'concurrency', sessionId: null }]);
    // Each schedule moves on by its interval: one run per missed window.
    for (const m of await f.list()) expect(m.nextRunAt).toBeGreaterThanOrEqual(before + 3600000);
    const turn = (await f.claim())!;
    expect(turn.member?.id).toBe(a.id);
    expect((await f.finish(turn, { status: 'completed', message: 'ok' })).status).toBe(200);
    await f.alarm();
    expect(await runsOf(f, a.id)).toMatchObject([{ state: 'completed' }]);
    expect(await runsOf(f, b.id)).toMatchObject([{ state: 'queued' }]);
    expect(await runsOf(f, c.id)).toMatchObject([{ state: 'waiting', waitReason: 'concurrency' }]);
    // 59 minutes after it was due, C still waits; past the hour it is skipped, keeping its reason.
    const age = (ms: number) => f.sql(sql => { sql.exec("UPDATE crew_runs SET due_at = ? WHERE crew_id = ? AND state = 'waiting'", Date.now() - ms, c.id); });
    await age(59 * 60000); await f.alarm();
    expect(await runsOf(f, c.id)).toMatchObject([{ state: 'waiting', waitReason: 'concurrency' }]);
    await age(61 * 60000); await f.alarm();
    expect(await runsOf(f, c.id)).toMatchObject([{ state: 'skipped', waitReason: 'concurrency' }]);
  });

  it('waits a minute between checks while no machine can take a due run, rather than waking the alarm at once', async () => {
    const f = await crewSetup();
    expect((await f.stub.execute(f.owner, 'node-crew', { nodeId: f.builder.nodeId, run: false })).status).toBe(200);
    const member = await f.create({ trigger: interval });
    await f.due(member.id);
    const before = Date.now();
    await f.alarm();
    expect(await runsOf(f, member.id)).toMatchObject([{ state: 'waiting', waitReason: 'no machine online' }]);
    const alarm = await runInDurableObject(f.stub, (_o, state) => state.storage.getAlarm());
    expect(alarm).toBeGreaterThanOrEqual(before + 60000);
    // The machine opted in again: its next heartbeat promotes the run without waiting for the alarm.
    expect((await f.stub.execute(f.owner, 'node-crew', { nodeId: f.builder.nodeId, run: true })).status).toBe(200);
    expect((await f.stub.execute(f.builder.node, 'heartbeat', {})).status).toBe(200);
    expect(await runsOf(f, member.id)).toMatchObject([{ state: 'queued' }]);
  });

  it('runs one crew session per project at a time: the second waits for the first to finish', async () => {
    const f = await crewSetup();
    expect((await f.stub.execute(f.owner, 'put-settings', { crewMaxConcurrentRuns: 2 })).status).toBe(200);   // so the cap is not what holds it
    const first = await f.create({ name: 'Standards', trigger: interval }), second = await f.create({ name: 'Bug hunter', trigger: interval });
    await f.due(first.id, 2000); await f.due(second.id, 1000);
    await f.alarm();
    expect(await runsOf(f, first.id)).toMatchObject([{ state: 'queued' }]);
    expect(await runsOf(f, second.id)).toMatchObject([{ state: 'waiting', waitReason: 'project busy: Standards' }]);
    expect((await f.finish((await f.claim())!, { status: 'completed', message: 'ok' })).status).toBe(200);
    await f.alarm();
    expect(await runsOf(f, second.id)).toMatchObject([{ state: 'queued' }]);
  });

  it('wakes a build-finished member once per ordinary build, never for a Verify of a crew branch', async () => {
    const f = await crewSetup();
    const member = await f.create({ name: 'Test proposer', trigger: { kind: 'buildFinished', on: 'failed' } });
    // `mark` rewrites the job the way a Verify (or a crew-made project's build) would have queued it.
    const build = async (requestId: string, status: string, mark = '') => {
      const queued = await (await f.stub.execute(f.owner, 'enqueue', { requestId, projectId: 'smith', product: 'build' })).json() as { id: string };
      if (mark) await f.sql(sql => { sql.exec(`UPDATE jobs SET ${mark} WHERE id = ?`, queued.id); });
      const claim = await (await f.stub.execute(f.builder.node, 'claim', {})).json() as { envelope: { lease: Record<string, unknown> } };
      expect((await f.stub.execute(f.builder.node, 'complete', { ...claim.envelope.lease, result: { status, exitCode: status === 'success' ? 0 : 1, durationMs: 1, message: '' } })).status).toBe(200);
      return queued.id;
    };
    // Each filter alone keeps the member asleep: a secretless build, an ai-verify- request, a crew- request.
    await build('secretless', 'failed', 'secretless = 1');
    await build('verify', 'failed', "request_id = 'ai-verify-' || request_id");
    await build('crew', 'failed', "request_id = 'crew-' || request_id");
    await build('green', 'success');                        // on: 'failed' ignores a build that passed
    await f.alarm();
    expect(await runsOf(f, member.id)).toEqual([]);
    const jobId = await build('red', 'failed');
    await f.alarm(); await f.alarm();
    const runs = await runsOf(f, member.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ state: 'queued', trigger: { kind: 'buildFinished', jobId, jobState: 'failed' } });
    // The same job reported finished again (its run is no longer waiting) wakes nobody a second time.
    await f.sql(sql => {
      const job = sql.exec<FinishedJob>('SELECT id, kind, request_id, project_id, state, secretless FROM jobs WHERE id = ?', jobId).one();
      new Crew(sql).onJobFinished(job, Date.now()); new Crew(sql).onJobFinished(job, Date.now());
    });
    expect(await runsOf(f, member.id)).toHaveLength(1);
  });

  it('runs an interval member once when it is resumed, or crew work restarted, long after its next run', async () => {
    const f = await crewSetup(); await f.copied('tools');
    const paused = await f.create({ name: 'Paused', trigger: interval }), stopped = await f.create({ name: 'Stopped', projectIds: ['tools'], trigger: interval });
    expect((await f.stub.execute(f.owner, 'put-settings', { crewMaxConcurrentRuns: 2 })).status).toBe(200);
    const spare = await f.machine(f.owner, 'build', CREW_AI);
    expect((await f.stub.execute(f.owner, 'node-crew', { nodeId: spare.nodeId, run: true })).status).toBe(200);
    // Paused for two hours past its next run: resuming makes it due now, and the alarm starts it.
    expect((await f.stub.execute(f.operator, 'crew-enable', { crewId: paused.id, enabled: false })).status).toBe(200);
    await f.due(paused.id, 2 * 3600000);
    await f.alarm();
    expect(await runsOf(f, paused.id)).toEqual([]);
    expect((await f.stub.execute(f.operator, 'crew-enable', { crewId: paused.id, enabled: true })).status).toBe(200);
    await f.alarm();
    expect(await runsOf(f, paused.id)).toMatchObject([{ state: 'queued' }]);
    // Likewise for all crew work stopped past a member's next run, then switched back on.
    expect((await f.stub.execute(f.owner, 'put-settings', { crewStopped: true })).status).toBe(200);
    await f.due(stopped.id, 2 * 3600000);
    await f.alarm();
    expect((await f.stub.execute(f.owner, 'put-settings', { crewStopped: false })).status).toBe(200);
    await f.alarm();
    expect(await runsOf(f, stopped.id)).toMatchObject([{ state: 'queued' }]);
    for (const m of await f.list()) expect(m.nextRunAt).toBeGreaterThan(Date.now() + 3500000);     // one run for all the missed windows
  });

  it('drops a waiting run when its member is paused, so the member can be deleted', async () => {
    const f = await crewSetup();
    expect((await f.stub.execute(f.owner, 'node-crew', { nodeId: f.builder.nodeId, run: false })).status).toBe(200);
    const member = await f.create({ trigger: interval });
    await f.due(member.id);
    await f.alarm();
    expect(await runsOf(f, member.id)).toMatchObject([{ state: 'waiting', waitReason: 'no machine online' }]);
    expect((await f.stub.execute(f.operator, 'crew-delete', { crewId: member.id })).status).toBe(409);
    expect((await f.stub.execute(f.operator, 'crew-enable', { crewId: member.id, enabled: false })).status).toBe(200);
    expect(await runsOf(f, member.id)).toMatchObject([{ state: 'skipped', waitReason: 'disabled' }]);
    expect((await f.stub.execute(f.operator, 'crew-delete', { crewId: member.id })).status).toBe(200);
  });

  it('hands a freed slot to a waiting run at once when a crew run is stopped or its push finishes', async () => {
    const f = await crewSetup(); await f.copied('tools');
    const a = await f.create({ name: 'A', trigger: interval }), b = await f.create({ name: 'B', projectIds: ['tools'], trigger: interval });
    const runA = await (await f.run(a.id)).json() as { sessionId: string };
    await f.due(b.id); await f.alarm();
    expect(await runsOf(f, b.id)).toMatchObject([{ state: 'waiting', waitReason: 'concurrency' }]);
    // A person stops A while it is still queued: B starts in the same request, without waiting for the alarm.
    expect((await f.stub.execute(f.operator, 'crew-run-stop', { sessionId: runA.sessionId })).status).toBe(200);
    expect(await runsOf(f, b.id)).toMatchObject([{ state: 'queued' }]);
    // B's message turn finishes with a commit and its push turn takes the slot; when the push finishes, A's next run starts.
    const turnB = (await f.claim())!;
    expect((await f.finish(turnB, { status: 'completed', message: 'ok', commit: 'c'.repeat(40), baseCommit: commit })).status).toBe(200);
    expect(await errorOf(f.run(a.id))).toMatchObject({ code: 'concurrency' });
    await f.due(a.id);
    await f.alarm();
    expect((await runsOf(f, a.id))[0]).toMatchObject({ state: 'waiting', waitReason: 'concurrency' });
    const push = (await f.claim())!;
    expect(push.kind).toBe('push');
    expect((await f.finish(push, { status: 'completed', message: 'pushed', commit: 'c'.repeat(40) })).status).toBe(200);
    expect((await runsOf(f, a.id))[0]).toMatchObject({ state: 'queued' });
  });

  it('keeps a build completion and a heartbeat even when crew scheduling fails, and leaves an unchanged wait alone', async () => {
    const f = await crewSetup();
    const member = await f.create({ trigger: interval });
    expect((await f.stub.execute(f.owner, 'put-settings', { clearAnthropicApiKey: true })).status).toBe(200);
    await f.due(member.id); await f.alarm();
    const waitRow = () => f.sql(sql => sql.exec<{ wait_reason: string; next_check_at: number; updated_at: number }>("SELECT wait_reason, next_check_at, updated_at FROM crew_runs WHERE state = 'waiting'").one());
    const before = await waitRow();
    expect(before.wait_reason).toBe('no API key');
    await new Promise(resolve => setTimeout(resolve, 5));
    expect((await f.stub.execute(f.builder.node, 'heartbeat', {})).status).toBe(200);
    expect(await waitRow()).toEqual(before);                                   // same reason, recheck not due: not rewritten
    const queued = await (await f.stub.execute(f.owner, 'enqueue', { requestId: 'b', projectId: 'smith', product: 'build' })).json() as { id: string };
    const claim = await (await f.stub.execute(f.builder.node, 'claim', {})).json() as { envelope: { lease: Record<string, unknown> } };
    // A member row promote cannot read (its waiting run makes promote read it): heartbeat and completion still go through.
    await f.sql(sql => { sql.exec("UPDATE crew_members SET budget = 'not json' WHERE id = ?", member.id); });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await f.stub.execute(f.builder.node, 'heartbeat', {})).status).toBe(200);
    expect((await f.stub.execute(f.builder.node, 'complete', { ...claim.envelope.lease, result: { status: 'failed', exitCode: 1, durationMs: 1, message: '' } })).status).toBe(200);
    expect(await (await f.stub.execute(f.owner, 'get', { jobId: queued.id })).json()).toMatchObject({ state: 'failed' });
    expect(errors.mock.calls.filter(call => String(call[0]).includes('crew_promote_failed'))).toHaveLength(2);
    errors.mockRestore();
  });

  it('stops a crew run no machine claimed within 15 minutes and puts it back to wait', async () => {
    const f = await crewSetup(); const member = await f.create();
    const { sessionId } = await (await f.run(member.id)).json() as { sessionId: string };
    await f.sql(sql => { sql.exec('UPDATE ai_turns SET created_at = ? WHERE session_id = ?', Date.now() - 16 * 60000, sessionId); });
    await f.alarm();
    expect(await runsOf(f, member.id)).toMatchObject([{ state: 'waiting', waitReason: 'no machine took the run' }]);
    expect(await (await f.stub.execute(f.operator, 'crew-run-session', { sessionId })).json()).toMatchObject({ working: false, turns: [{ state: 'stopped' }] });
  });

  it('Stop all crew: promotes nothing, stops the running turn, returns queued runs to waiting and ends their run tokens', async () => {
    const f = await crewSetup(); await f.copied('tools'); await f.copied('docs');
    expect((await f.stub.execute(f.owner, 'put-settings', { crewMaxConcurrentRuns: 2 })).status).toBe(200);
    const spare = await f.machine(f.owner, 'build', CREW_AI);
    expect((await f.stub.execute(f.owner, 'node-crew', { nodeId: spare.nodeId, run: true })).status).toBe(200);
    const a = await f.create({ name: 'A' }), b = await f.create({ name: 'B', projectIds: ['tools'] }), c = await f.create({ name: 'C', projectIds: ['docs'], trigger: interval });
    const runA = await (await f.run(a.id)).json() as { sessionId: string };
    const [first, other] = (await runsOf(f, a.id))[0].nodeId === spare.nodeId ? [spare.node, f.builder.node] : [f.builder.node, spare.node];
    const turnA = (await f.claim(first))!;
    expect(turnA.sessionId).toBe(runA.sessionId);
    const runB = await (await f.run(b.id)).json() as { sessionId: string };
    expect(runB.sessionId).toBeTruthy();                                                  // queued on the other machine
    expect((await f.stub.execute(f.owner, 'put-settings', { crewStopped: true })).status).toBe(200);
    // The running turn is asked to stop (as ai-session-stop does), and its run token stops working at once.
    expect(await (await f.stub.execute(f.operator, 'crew-run-session', { sessionId: runA.sessionId })).json()).toMatchObject({ turns: [{ state: 'running', stopRequested: true }] });
    expect((await f.stub.execute({ kind: 'token', token: turnA.mcp.token }, 'summary', {})).status).toBe(401);
    const events = await (await f.stub.execute(first, 'ai-events', { turnId: turnA.turnId, leaseToken: turnA.leaseToken, seq: 0, events: [] })).json() as { stop: boolean };
    expect(events.stop).toBe(true);
    // The queued one never starts: it waits again, and the other machine gets nothing.
    expect(await runsOf(f, b.id)).toMatchObject([{ state: 'waiting', waitReason: 'stopped: workspace' }]);
    expect(await f.claim(other)).toBeNull();
    // A member that falls due meanwhile does not run either.
    await f.due(c.id);
    await f.alarm();
    expect(await runsOf(f, b.id)).toMatchObject([{ state: 'waiting' }]);
    expect((await runsOf(f, c.id)).filter(r => r.state !== 'waiting')).toEqual([]);
    expect(await f.sql(sql => sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM ai_turns t JOIN ai_sessions s ON s.id = t.session_id WHERE s.kind = 'crew' AND t.state = 'queued'").one().n)).toBe(0);
    expect(await errorOf(f.run(c.id))).toMatchObject({ status: 409, code: 'stopped', waitReason: 'stopped: workspace' });
  });

  it('starts every workspace at zero lifetime builds', async () => {
    const f = await crewSetup();
    expect(await (await f.stub.execute(f.operator, 'settings', {})).json()).toMatchObject({ lifetimeBuildsUsed: 0 });
  });
});
