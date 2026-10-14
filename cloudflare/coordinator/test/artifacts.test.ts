import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import worker from '../src/index';
import { hash } from '../src/http';
import schema from '../migrations/0001_identity.sql?raw';
import browserSchema from '../migrations/0002_browser_auth.sql?raw';
import directorySchema from '../migrations/0003_workspace_directory.sql?raw';
const origin = 'https://exp.redmarmosetstudios.com';
beforeAll(async () => { await env.DB.exec(schema); await env.DB.exec(browserSchema); await env.DB.exec(directorySchema); });
const project = { id: 'fork', name: 'Customer fork', repoUrl: 'https://github.com/customer/smith.git', branch: 'custom-smith', commit: 'a'.repeat(40), products: [{ name: 'self-release', commands: {windows:{interpreter:'ps1',script:'build.ps1',args:[]}}, artifacts:{globs:['Build/SelfRelease/smith-release.zip'],package:'none'} }] };
async function setup() {
  const userId=crypto.randomUUID(), token=crypto.randomUUID();
  await env.DB.batch([env.DB.prepare('INSERT INTO users (id, created_at) VALUES (?, ?)').bind(userId,Date.now()),env.DB.prepare('INSERT INTO sessions (token_hash,user_id,expires_at) VALUES (?,?,?)').bind(await hash(token),userId,Date.now()+600000)]);
  async function request(path:string,credential=token,body?:unknown) { return worker.fetch(new Request(origin+path,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${credential}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)}),env); }
  const created=await (await request('/api/v2/workspaces',token,{requestId:'primary'})).json() as {workspaceId:string};
  const base='/api/v2/workspaces/'+created.workspaceId;
  expect((await request(base+'/projects',token,project)).status).toBe(201);
  const code=await (await request(base+'/enrollments',token,{})).json() as {code:string};
  const node=await (await request(base+'/nodes/enroll','',{code:code.code,os:'windows',protocolVersion:2})).json() as {token:string};
  const job=await (await request(base+'/jobs',token,{requestId:crypto.randomUUID(),projectId:'fork',product:'self-release'})).json() as {id:string};
  const assignment=await (await request(base+'/claims',node.token,{})).json() as {envelope:{lease:{jobId:string;attemptId:string;leaseToken:string}}};
  const lease=assignment.envelope.lease;
  async function upload(bytes='release payload',name='smith-release.zip',digest?:string) {
    return worker.fetch(new Request(origin+base+'/artifacts',{method:'POST',headers:{Authorization:`Bearer ${node.token}`,'Content-Type':'application/octet-stream','Content-Length':String(new TextEncoder().encode(bytes).length),'X-Smith-Job-Id':job.id,'X-Smith-Attempt-Id':lease.attemptId,'X-Smith-Lease-Token':lease.leaseToken,'X-Smith-Artifact-Name':name,'X-Smith-SHA256':digest??await hash(bytes)},body:bytes}),env);
  }
  const complete=()=>request(base+'/complete',node.token,{...lease,result:{status:'success',exitCode:0,durationMs:10,message:'Candidate built'}});
  return {request,upload,complete,base,job,token,node,lease,stub:env.WORKSPACES.getByName(created.workspaceId)};
}
describe('immutable build artifacts',()=>{
  it('rejects filenames that the upload transport cannot accept',async()=>{
    const f=await setup();
    for(const name of ['.release.zip','a'.repeat(129)+'.zip','other/../secret.zip','Build/*.zip','release.','Build/CON.zip','LPT1/output.zip']) {
      const invalid={...project,products:[{...project.products[0],artifacts:{globs:[name],package:'none'}}]};
      expect((await f.request(f.base+'/projects',f.token,invalid)).status).toBe(400);
    }
  });
  it('uploads declared files, replays identical bytes and downloads only after successful completion',async()=>{
    const f=await setup();
    expect((await f.complete()).status).toBe(409);
    expect((await f.upload()).status).toBe(201);
    expect((await f.upload()).status).toBe(201);
    expect((await f.upload('different')).status).toBe(409);
    expect((await f.request(f.base+'/jobs/'+f.job.id+'/artifacts/smith-release.zip')).status).toBe(409);
    expect((await f.complete()).status).toBe(200);
    const response=await f.request(f.base+'/jobs/'+f.job.id+'/artifacts/smith-release.zip');
    expect(response.status).toBe(200);expect(new TextDecoder().decode(await response.arrayBuffer())).toBe('release payload');
    expect(response.headers.get('Content-Disposition')).toContain('attachment');
    const job=await (await f.request(f.base+'/jobs/'+f.job.id)).json();
    expect(job).toMatchObject({artifacts:[{name:'smith-release.zip',sha256:await hash('release payload')}]});
    expect((await f.request(f.base+'/jobs/'+f.job.id+'/artifacts/smith-release.zip','')).status).toBe(401);
  });
  it('rejects corrupt bytes, undeclared names and cancelled attempt publication',async()=>{
    const f=await setup();
    expect((await f.upload('release payload','other.zip')).status).toBe(400);
    expect((await f.upload('corrupt','smith-release.zip','b'.repeat(64))).status).toBe(400);
    expect((await f.request(f.base+'/jobs/'+f.job.id+'/cancel',f.token,{})).status).toBe(200);
    expect((await f.upload()).status).toBe(409);
  });
  it('fences finalization when cancellation happens during object upload',async()=>{
    const f=await setup();const principal={kind:'node' as const,token:f.node.token};
    const data={...f.lease,name:'smith-release.zip',sha256:await hash('payload'),size:7};
    expect((await f.stub.execute(principal,'artifact-start',data)).status).toBe(200);
    await f.request(f.base+'/jobs/'+f.job.id+'/cancel',f.token,{});
    expect((await f.stub.execute(principal,'artifact-finish',data)).status).toBe(409);
    expect((await f.request(f.base+'/jobs/'+f.job.id)).status).toBe(200);
  });
});
