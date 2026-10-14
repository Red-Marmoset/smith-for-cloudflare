import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

const project = {
  id: 'smith', name: 'Smith', repoUrl: 'git@github.com:Red-Marmoset/smith.git', branch: 'feature/cloudflare-experiment', commit: 'd45d5d166ff384710a2f63cfa24271395b689c41',
  products: [{ name: 'build', description: 'Build Smith', labels: ['una-engine'], timeoutSeconds: 1800,
    commands: { windows: { interpreter: 'ps1', script: 'Build.ps1', args: ['-Project', 'Smith', '-Config', 'Release'] } } }],
};
async function setup() {
  const id = crypto.randomUUID(); const userId = crypto.randomUUID();
  const stub = env.WORKSPACES.getByName(id);
  await stub.initialize(id, userId);
  const human = { kind: 'human' as const, userId };
  async function node(labels: string[] = ['una-engine'], os = 'windows') {
    const { code } = await (await stub.execute(human, 'enrollments', {})).json() as { code: string };
    const response = await stub.execute({ kind: 'enrollment' }, 'enroll', { code, protocolVersion: 2, os, hostname: 'test-runner', arch: 'x64', labels, agentVersion: '0.1.0' });
    expect(response.status).toBe(201);
    const { token } = await response.json() as { token: string };
    return { kind: 'node' as const, token };
  }
  return { stub, human, node };
}
type Assignment = { hasJob: boolean; envelope: { lease: {jobId:string; attemptId:string; leaseToken:string}; spec: {projectId:string;repos:{commit:string}[];command:{script:string}} } };
describe('real hosted build loop', () => {
  it('drains a node without interrupting its current lease and blocks subsequent assignments', async () => {
    const f=await setup(); const node=await f.node();
    await f.stub.execute(f.human,'enqueue',{requestId:'before-drain',projectId:'smoke'});
    await f.stub.execute(f.human,'enqueue',{requestId:'after-drain',projectId:'smoke'});
    const current=await (await f.stub.execute(node,'claim',{})).json() as Assignment;
    const nodes=await (await f.stub.execute(f.human,'nodes',{})).json() as {nodes:{id:string;activeJobId:string|null;draining:boolean}[]};
    const nodeId=nodes.nodes[0].id;
    expect(nodes.nodes[0].activeJobId).toBe(current.envelope.lease.jobId);
    expect((await f.stub.execute(f.human,'drain',{nodeId,draining:true})).status).toBe(200);
    expect(await (await f.stub.execute(node,'claim',{})).json()).toEqual(current);
    expect((await f.stub.execute(node,'renew',current.envelope.lease)).status).toBe(200);
    expect((await f.stub.execute(node,'complete',{...current.envelope.lease,result:{status:'success',exitCode:0,durationMs:10,message:''}})).status).toBe(200);
    expect(await (await f.stub.execute(node,'claim',{})).json()).toEqual({hasJob:false});
    expect(await (await f.stub.execute(f.human,'nodes',{})).json()).toMatchObject({nodes:[{draining:true,activeJobId:null}]});
    await runInDurableObject(f.stub,(_object,state)=>{state.storage.sql.exec("UPDATE members SET role='operator'");});
    expect((await f.stub.execute(f.human,'drain',{nodeId,draining:false})).status).toBe(403);
    await runInDurableObject(f.stub,(_object,state)=>{state.storage.sql.exec("UPDATE members SET role='owner'");});
    expect((await f.stub.execute(f.human,'drain',{nodeId,draining:false})).status).toBe(200);
    expect(await (await f.stub.execute(node,'claim',{})).json()).toMatchObject({hasJob:true});
  });
  it('freezes a pinned project build and matches only eligible native nodes', async () => {
    const f = await setup();
    expect((await f.stub.execute(f.human, 'put-project', project)).status).toBe(201);
    const queued = await f.stub.execute(f.human, 'enqueue', { requestId: 'first-build', projectId: 'smith', product: 'build' });
    expect(queued.status).toBe(201);
    expect((await f.stub.execute(f.human, 'put-project', { ...project, commit: '1'.repeat(40) })).status).toBe(201);
    const wrongLabels = await f.node([]); const wrongOS = await f.node(['una-engine'], 'linux'); const eligible = await f.node();
    expect(await (await f.stub.execute(wrongLabels, 'claim', {})).json()).toEqual({ hasJob: false });
    expect(await (await f.stub.execute(wrongOS, 'claim', {})).json()).toEqual({ hasJob: false });
    const claimed = await (await f.stub.execute(eligible, 'claim', {})).json() as Assignment;
    expect(claimed.envelope.spec.repos[0].commit).toBe(project.commit);
    expect(claimed.envelope.spec.command.script).toBe('Build.ps1');
    expect(claimed.envelope.spec.projectId).toBe('smith');
    expect(claimed.envelope.spec).toMatchObject({ kind: 'build' });
    expect(claimed.envelope.spec).not.toHaveProperty('mirror');
  });
  it('accepts bounded sequenced logs, rejects conflicts and fences cancelled builds', async () => {
    const f = await setup(); const node = await f.node();
    await f.stub.execute(f.human, 'enqueue', { requestId: 'smoke-logs', projectId: 'smoke' });
    const claimed = await (await f.stub.execute(node, 'claim', {})).json() as Assignment;
    const log = { ...claimed.envelope.lease, seq: 0, stream: 'stdout', lines: ['Compiler completed.'] };
    expect((await f.stub.execute(node, 'logs', log)).status).toBe(200);
    expect((await f.stub.execute(node, 'logs', log)).status).toBe(200);
    expect((await f.stub.execute(node, 'logs', { ...log, lines: ['Changed'] })).status).toBe(409);
    expect((await f.stub.execute(node, 'logs', { ...log, seq: 2 })).status).toBe(409);
    const read = await (await f.stub.execute(f.human, 'read-logs', { jobId: log.jobId, after: -1 })).json();
    expect(read).toMatchObject({ chunks: [{ seq: 0, stream: 'stdout', lines: ['Compiler completed.'] }], nextSeq: 1 });
    expect((await f.stub.execute(f.human, 'cancel', { jobId: log.jobId })).status).toBe(200);
    expect((await f.stub.execute(node, 'renew', claimed.envelope.lease)).status).toBe(409);
    expect((await f.stub.execute(node, 'logs', { ...log, seq: 1 })).status).toBe(409);
    expect((await f.stub.execute(node, 'complete', { ...claimed.envelope.lease, result: { status: 'success', exitCode: 0, durationMs: 1, message: '' } })).status).toBe(409);
  });
  it('reports heartbeat liveness and denies configuration changes by operators', async () => {
    const f = await setup(); const node = await f.node();
    expect((await f.stub.execute(node, 'heartbeat', { hostname: 'test-runner', os: 'windows', arch: 'x64', labels: ['una-engine'], agentVersion: '0.1.0' })).status).toBe(200);
    const nodes = await (await f.stub.execute(f.human, 'nodes', {})).json() as {nodes:{hostname:string;lastSeenAt:number}[]};
    expect(nodes.nodes[0].hostname).toBe('test-runner'); expect(nodes.nodes[0].lastSeenAt).toBeGreaterThan(0);
    await runInDurableObject(f.stub, (_object, state) => { state.storage.sql.exec('UPDATE members SET role = ?', 'operator'); });
    expect((await f.stub.execute(f.human, 'put-project', project)).status).toBe(403);
  });
  it('rejects unpinned repos and paths outside the job workspace', async () => {
    const f = await setup();
    expect((await f.stub.execute(f.human, 'put-project', { ...project, commit: 'main' })).status).toBe(400);
    expect((await f.stub.execute(f.human, 'put-project', { ...project, repoUrl: 'https://secret@github.com/Red-Marmoset/smith.git' })).status).toBe(400);
    const bad = { ...project, products: [{ ...project.products[0], workingDir: '../outside' }] };
    expect((await f.stub.execute(f.human, 'put-project', bad)).status).toBe(400);
  });
});
