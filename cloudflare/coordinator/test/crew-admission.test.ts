import { beforeAll, describe, it, expect } from 'vitest';
import { env } from 'cloudflare:workers';
import identity from '../migrations/0001_identity.sql?raw';
import { crewSetup, CREW_AI } from './crew-fixture';
import { CrewEvents } from '../src/crew-events';
beforeAll(async()=>{await env.DB.exec(identity);});
async function setup(policy:Record<string,unknown>={}) {
 const f=await crewSetup();expect((await f.stub.execute(f.owner,'put-settings',{orchestration:{enabled:true,...policy},crewMaxConcurrentRuns:10,crewDailyUsdLimit:100})).status).toBe(200);
 const machines=[];for(let i=0;i<3;i++){const m=await f.machine(f.owner,'build',{...CREW_AI,features:[...CREW_AI.features,'crew-orchestration-v1']});await f.stub.execute(f.owner,'node-crew',{nodeId:m.nodeId,run:true});machines.push(m);}
 return {...f,machines};
}
async function checkin(f:Awaited<ReturnType<typeof setup>>,branch='main',deliveryId='event') {
 const r=await f.stub.execute(f.operator,'crew-checkin',{projectId:'smith',branch,baseCommit:'a'.repeat(40),headCommit:'b'.repeat(40),kind:'push',deliveryId});expect(r.status).toBe(201);
 const {eventId}=await r.json() as {eventId:string};await f.sql(sql=>new CrewEvents(sql).ready(eventId,{complete:true,ancestor:true,testState:'unknown',changes:[{path:'src/code.ts',oldPath:null,added:1,deleted:0}]},Date.now()));await f.alarm();return eventId;
}
describe('check-in admission',()=>{
 it.each([
  ['budget',{eventBudgets:{normal:1}},'event budget'],
  ['class',{concurrency:{cheap:1}},'cost class concurrency'],
  ['rate',{globalStartsPerHour:1},'global start rate'],
 ] as const)('enforces %s limits before reserving work',async(_label,policy,reason)=>{
  const f=await setup(policy);for(const name of ['One','Two'])await f.create({name,permissionMode:'plan',orchestration:{events:['push']}});await checkin(f);
  const rows=await f.sql(sql=>sql.exec<{state:string;wait_reason:string}>('SELECT state,wait_reason FROM crew_runs').toArray());
  expect(rows.filter(r=>r.state==='queued')).toHaveLength(1);expect(rows.find(r=>r.state==='waiting')?.wait_reason).toContain(reason);
  expect(await f.sql(sql=>sql.exec('SELECT * FROM crew_unit_ledger').toArray())).toHaveLength(1);
 });
 it('admits disjoint writers and a reader together but excludes overlapping prefixes',async()=>{
  const f=await setup();
  for(const [name,scope] of [['Writer A','src/a/'],['Writer B','src/b/'],['Overlapping','SRC/A/child/']])await f.create({name,permissionMode:'acceptEdits',orchestration:{mode:'write',writeScopes:[scope],events:['push']}});
  await f.create({name:'Reader',permissionMode:'plan',orchestration:{events:['push']}});await checkin(f);
  const rows=await f.sql(sql=>sql.exec<{state:string;wait_reason:string}>('SELECT state,wait_reason FROM crew_runs').toArray());
  expect(rows.filter(r=>r.state==='queued')).toHaveLength(3);expect(rows.find(r=>r.state==='waiting')?.wait_reason).toContain('write scope leased');
  expect(await f.sql(sql=>sql.exec("SELECT * FROM crew_scope_leases WHERE state='active'").toArray())).toHaveLength(2);
 });
 it('allows only one active run for a member across branches',async()=>{
  const f=await setup();const member=await f.create({permissionMode:'plan',orchestration:{events:['push']}});await checkin(f);await checkin(f,'release','second');
  const runs=await f.runs(member.id);expect(runs.filter(r=>r.state==='queued')).toHaveLength(1);expect(runs.filter(r=>r.state==='waiting')).toHaveLength(1);
 });
 it('rejects stale writer reports and stop-all revokes live tools without freeing an unsafe writer',async()=>{
  const f=await setup();await f.create({permissionMode:'acceptEdits',orchestration:{mode:'write',writeScopes:['src/'],events:['push']}});await checkin(f);
  const turns=await Promise.all(f.machines.map(m=>f.claim(m.node)));const turn=turns.find(Boolean)!;expect(turn).toBeTruthy();
  const actor={kind:'token' as const,token:turn.mcp.token};
  await f.sql(sql=>sql.exec("UPDATE crew_scope_leases SET expires_at=?",Date.now()-1));
  const stale=await f.stub.execute(actor,'crew-tool-report',{report:{summary:'late',findings:[]}});expect(stale.status).toBe(409);
  expect((await f.stub.execute(f.owner,'put-settings',{crewStopped:true})).status).toBe(200);
  expect((await f.stub.execute(actor,'crew-tool-report',{report:{summary:'late',findings:[]}})).status).toBe(401);
  const leases=await f.sql(sql=>sql.exec<{state:string}>('SELECT state FROM crew_scope_leases').toArray());expect(leases.every(l=>l.state!=='released')).toBe(true);
 });
});
