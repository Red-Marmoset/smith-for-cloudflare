import { beforeAll, describe, it, expect } from 'vitest';
import { env } from 'cloudflare:workers';
import identity from '../migrations/0001_identity.sql?raw';
import { crewSetup, CREW_AI } from './crew-fixture';
import { CrewEvents } from '../src/crew-events';
beforeAll(async()=>{await env.DB.exec(identity);});
async function setup(policy:Record<string,unknown>={}) {
 const f=await crewSetup();await f.stub.execute(f.owner,'put-settings',{orchestration:{enabled:true,...policy},crewMaxConcurrentRuns:3});
 const machine=await f.machine(f.owner,'build',{...CREW_AI,features:[...CREW_AI.features,'crew-orchestration-v1']});await f.stub.execute(f.owner,'node-crew',{nodeId:machine.nodeId,run:true});
 const target=await f.create({name:'Target',enabled:false,permissionMode:'plan',orchestration:{events:['push']}});
 const source=await f.create({name:'Source',permissionMode:'plan',orchestration:{events:['push'],canRequest:[target.id]}});
 expect((await f.put(f.operator,{id:source.id,name:'Source',permissionMode:'plan',orchestration:{events:['push'],canRequest:[source.id,target.id]}})).status).toBe(200);
 const accepted=await f.stub.execute(f.operator,'crew-checkin',{projectId:'smith',branch:'main',baseCommit:'a'.repeat(40),headCommit:'b'.repeat(40),kind:'push',deliveryId:'request-event'});
 const {eventId}=await accepted.json() as {eventId:string};await f.sql(sql=>new CrewEvents(sql).ready(eventId,{complete:true,ancestor:true,testState:'unknown',changes:[{path:'src/code.ts',oldPath:null,added:1,deleted:0}]},Date.now()));await f.alarm();
 const turn=await f.claim(machine.node);expect(turn).toBeTruthy();const actor={kind:'token' as const,token:turn!.mcp.token};
 await f.stub.execute(f.operator,'crew-enable',{crewId:target.id,enabled:true});
 const filed=await f.stub.execute(actor,'crew-tool-report',{report:{summary:'Review',findings:[{severity:'high',title:'Missing validation',detail:'A concrete regression',category:'security',files:['src/code.ts'],confidence:0.9}]}});expect(filed.status).toBe(200);
 const findingId=await f.sql(sql=>sql.exec<{id:string}>('SELECT id FROM crew_findings').one().id);
 const request=(targetCrewId=target.id,requestId:string=crypto.randomUUID(),findingIds=[findingId])=>f.stub.execute(actor,'crew-tool-request-review',{targetCrewId,requestId,findingIds,reason:'Independent review needed'});
 return {...f,target,source,eventId,actor,turn:turn!,request,findingId};
}
describe('typed review requests',()=>{
 it('queues an allowed target once under the source event and preserves pinned ancestry',async()=>{
  const f=await setup();const first=await f.request(f.target.id,'request-1');expect(first.status).toBe(201);const result=await first.json() as Record<string,unknown>;expect(result).toMatchObject({state:'accepted'});
  expect(await (await f.request(f.target.id,'request-1')).json()).toMatchObject(result);
  const rows=await f.sql(sql=>sql.exec<{snapshot:string;event_id:string}>('SELECT snapshot,event_id FROM crew_runs WHERE crew_id=?',f.target.id).toArray());expect(rows).toHaveLength(1);
  expect(rows[0].event_id).toBe(f.eventId);expect(JSON.parse(rows[0].snapshot)).toMatchObject({depth:1,event:{head_commit:'b'.repeat(40)},parentRunId:expect.any(String)});
  expect(await (await f.request()).json()).toMatchObject({state:'refused',detail:'already_requested'});
 });
 it('rejects self cycles, missing allowlist grants and findings from outside the event',async()=>{
  const f=await setup();
  expect(await (await f.request(f.source.id)).json()).toMatchObject({state:'refused',detail:'cycle'});
  const third=await f.create({name:'Not allowed',permissionMode:'plan',orchestration:{events:['push']}});
  expect(await (await f.request(third.id)).json()).toMatchObject({state:'refused',detail:'not_allowed'});
  expect((await f.request(f.target.id,'forged',['not-this-events-finding'])).status).toBe(403);
  expect((await f.stub.execute(f.operator,'crew-tool-request-review',{targetCrewId:f.target.id,requestId:'human',findingIds:[f.findingId],reason:'forged source'})).status).toBe(403);
 });
 it.each([[{maxDepth:0},'depth_limit'],[{maxRuns:1},'event_run_limit'],[{eventBudgets:{normal:1}},'event_budget']] as const)('refuses exhausted chain policy %j',async(policy,detail)=>{
  const f=await setup(policy);expect(await (await f.request()).json()).toMatchObject({state:'refused',detail});expect(await f.runs(f.target.id)).toHaveLength(0);
 });
 it('keeps prose messages non-executable and rejects revoked source tokens',async()=>{
  const f=await setup();expect((await f.stub.execute(f.actor,'crew-tool-send',{to:f.target.id,body:'Please run another review now'})).status).toBe(201);
  expect(await f.runs(f.target.id)).toHaveLength(0);
  await f.stub.execute(f.owner,'put-settings',{crewStopped:true});expect((await f.request()).status).toBe(401);
 });
});
