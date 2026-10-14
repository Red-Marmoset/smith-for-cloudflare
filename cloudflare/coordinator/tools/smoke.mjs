// Operator-only cloud verification. Credentials stay in memory, never argv or files.
// Requires the same Cloudflare management token used by Wrangler.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const config = JSON.parse(await readFile(path.join(root, 'wrangler.jsonc'), 'utf8'));
const managementToken = process.env.CLOUDFLARE_API_TOKEN;
if (!managementToken) throw new Error('CLOUDFLARE_API_TOKEN is required');
const account = config.account_id;
const database = config.d1_databases[0].database_id;
if (!account || database.startsWith('00000000')) throw new Error('Provision the experiment account and D1 database first');
const origin = config.vars.ORIGIN;
assert.equal(origin, 'https://exp.redmarmosetstudios.com');
const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
if (revision.status !== 0) throw new Error('Cannot identify source revision');

async function sql(query, params = []) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${database}/query`, {
    method: 'POST', redirect: 'error',
    headers: { Authorization: `Bearer ${managementToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql: query, params }),
  });
  const result = await response.json();
  if (!response.ok || !result.success) throw new Error(`Cloudflare database operation failed (${response.status})`);
}
async function api(route, token, body, status = 200) {
  const response = await fetch(origin + route, {
    method: body === undefined ? 'GET' : 'POST', redirect: 'error',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status !== status) throw new Error(`Smoke request ${route} returned ${response.status}; expected ${status}`);
  return response.json();
}
const userId = `smoke-${randomUUID()}`;
const session = randomBytes(32).toString('hex');
const sessionHash = createHash('sha256').update(session).digest('hex');
let base;
const nodes = [];
try {
  await sql('INSERT INTO users (id, created_at) VALUES (?, ?)', [userId, Date.now()]);
  await sql('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)', [sessionHash, userId, Date.now() + 15 * 60000]);
  const before = await api('/health', '');
  assert.equal(before.runtime, 'cloudflare-workers');
  const { workspaceId } = await api('/api/v2/workspaces', session, { requestId: randomUUID() }, 201);
  base = `/api/v2/workspaces/${workspaceId}`;
  await api(base + '/jobs', '', undefined, 401);
  for (let i = 0; i < 2; i++) {
    const { code } = await api(base + '/enrollments', session, {}, 201);
    nodes.push(await api(base + '/nodes/enroll', '', { code, protocolVersion: 2, os: 'linux' }, 201));
    await api(base + '/nodes/enroll', '', { code, protocolVersion: 2, os: 'linux' }, 401);
  }
  const requestId = randomUUID();
  const job = await api(base + '/jobs', session, { requestId, projectId: 'smoke' }, 201);
  assert.equal((await api(base + '/jobs', session, { requestId, projectId: 'smoke' }, 201)).id, job.id);
  const assignments = await Promise.all(nodes.map(node => api(base + '/claims', node.token, {})));
  assert.equal(assignments.filter(x => x.hasJob).length, 1);
  const winner = assignments.findIndex(x => x.hasJob);
  const assignment = assignments[winner];
  const credential = nodes[winner].token;
  assert.deepEqual(await api(base + '/claims', credential, {}), assignment);
  assert.equal(assignment.envelope.lease.jobId, job.id);
  assert.deepEqual(assignment.envelope.spec.command.args, ['Smith Cloudflare smoke']);
  await api(base + '/renew', credential, assignment.envelope.lease);
  const completion = { ...assignment.envelope.lease, result: { status: 'success', exitCode: 0, durationMs: 1, message: 'Authenticated cloud API fixture; no native build executed' } };
  await api(base + '/complete', credential, completion);
  await api(base + '/complete', credential, completion);
  await api(base + '/complete', credential, { ...completion, result: { ...completion.result, status: 'failed' } }, 409);
  if (process.argv.includes('--redeploy')) {
    console.log('Job completed; redeploying the Cloudflare Worker to verify persistence.');
    const deployed = spawnSync(process.execPath, [path.join(root, 'node_modules/wrangler/bin/wrangler.js'), 'deploy', '--tag', revision.stdout.trim().slice(0, 40)], { cwd: root, stdio: 'inherit', env: process.env });
    if (deployed.status !== 0) throw new Error('Redeployment failed');
  }
  const after = await api('/health', '');
  if (process.argv.includes('--redeploy')) assert.notEqual(after.deployment, before.deployment);
  const persisted = await api(base + '/jobs/' + job.id, session);
  assert.equal(persisted.state, 'success');
  for (const node of nodes) {
    await api(base + '/nodes/' + node.nodeId + '/revoke', session, {});
    await api(base + '/claims', node.token, {}, 401);
  }
  const evidence = {
    verifiedAt: new Date().toISOString(), origin, sourceRevision: revision.stdout.trim(),
    deploymentBefore: before.deployment, deploymentAfter: after.deployment,
    workspaceId, jobId: job.id, finalState: persisted.state,
    checks: ['unauthenticated rejection', 'one-use enrollment', 'enqueue deduplication', 'concurrent claim', 'lost-response replay', 'lease renewal', 'idempotent completion', 'conflicting-result rejection', 'node revocation', ...(process.argv.includes('--redeploy') ? ['state survives cloud redeployment'] : [])],
    execution: 'HTTPS fixture client; coordinator and authoritative job state execute on Cloudflare. No native build was executed.',
  };
  const outputIndex = process.argv.indexOf('--evidence');
  if (outputIndex !== -1) {
    if (!process.argv[outputIndex + 1]) throw new Error('--evidence requires an output path');
    await writeFile(process.argv[outputIndex + 1], JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' });
  }
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  // Revoke temporary capabilities even on failure. Do not print credentials in errors.
  if (base) for (const node of nodes) {
    try { await api(base + '/nodes/' + node.nodeId + '/revoke', session, {}); }
    catch { console.error('Could not revoke a smoke node; revoke it with a workspace owner session.'); }
  }
  await sql('DELETE FROM sessions WHERE user_id = ?', [userId]);
  await sql('DELETE FROM users WHERE id = ?', [userId]);
}
