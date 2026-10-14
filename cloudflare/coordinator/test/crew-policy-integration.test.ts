import { beforeAll, it, expect } from 'vitest';
import { env } from 'cloudflare:workers';
import identity from '../migrations/0001_identity.sql?raw';
import { crewSetup } from './crew-fixture';
import { CrewEvents } from '../src/crew-events';
import { CrewOrchestration } from '../src/crew-orchestration';
import { validateOrchestrationPolicy } from '../src/crew-orchestration-model';
import type { CrewMember } from '../src/crew-model';
beforeAll(async()=>{await env.DB.exec(identity);});
it('rejects permission edits which contradict retained orchestration',async()=>{
 const f=await crewSetup();const member=await f.create({permissionMode:'plan',orchestration:{}});
 expect((await f.stub.execute(f.operator,'crew-put',{id:member.id,permissionMode:'acceptEdits'})).status).toBe(400);
});
it('includes quarantine expiry and active lease expiry in the next alarm',async()=>{
 const f=await crewSetup();await f.sql(sql=>{
  sql.exec("INSERT INTO crew_scope_leases VALUES('l','r','repo','main','[]',1,1000,'quarantined')");
  expect(new CrewOrchestration(sql).nextDue()).toBe(61000);
  sql.exec("INSERT INTO crew_scope_leases VALUES('l2','r2','repo','main','[]',1,500,'active')");expect(new CrewOrchestration(sql).nextDue()).toBe(500);
 });
});
it('uses declared project module and risk rules and defers missing ownership',async()=>{
 const f=await crewSetup();await f.create({permissionMode:'plan',orchestration:{modules:['payments'],minRisk:'high'}});
 const members=await f.list() as unknown as CrewMember[];
 const response=await f.stub.execute(f.operator,'crew-checkin',{projectId:'smith',branch:'main',baseCommit:'a'.repeat(40),headCommit:'b'.repeat(40),kind:'push',deliveryId:'rules'});const {eventId}=await response.json() as {eventId:string};
 await f.sql(sql=>{
  const events=new CrewEvents(sql);events.ready(eventId,{complete:true,ancestor:true,testState:'unknown',changes:[{path:'services/billing/charge.ts',oldPath:null,added:1,deleted:0}]},1);
  const orchestration=new CrewOrchestration(sql);
  expect(orchestration.evaluate(events.get(eventId),members,validateOrchestrationPolicy({}),2,true)).toMatchObject([{status:'deferred',reason:'modules_unknown'}]);
  const policy=validateOrchestrationPolicy({projectRules:{smith:{modules:{payments:['services/billing/**']},riskRules:[{paths:['services/**'],risk:'normal'},{paths:['**/charge.ts'],risk:'high'}]}}});
  expect(orchestration.evaluate(events.get(eventId),members,policy,2,true)).toMatchObject([{status:'eligible',matched:{modules:['payments'],risk:'high'}}]);
 });
});
it.each(['units','runs'])('settles permanently exhausted %s without retaining a polling alarm',async limit=>{
 const f=await crewSetup();await f.create({permissionMode:'plan',orchestration:{unitCost:1}});const members=await f.list() as unknown as CrewMember[];
 const r=await f.stub.execute(f.operator,'crew-checkin',{projectId:'smith',branch:'main',baseCommit:'a'.repeat(40),headCommit:'b'.repeat(40),kind:'push',deliveryId:'exhausted'});const {eventId}=await r.json() as {eventId:string};
 await f.sql(sql=>{
  const policy=validateOrchestrationPolicy({enabled:true,eventBudgets:{normal:1},maxRuns:limit==='runs'?1:6});
  const events=new CrewEvents(sql);events.ready(eventId,{complete:true,ancestor:true,testState:'unknown',changes:[{path:'src/code.ts',oldPath:null,added:1,deleted:0}]},1);
  const orchestration=new CrewOrchestration(sql);orchestration.enqueueReady(members,policy,2);
  sql.exec("INSERT INTO crew_unit_ledger VALUES('previous',?,1,'reserved',2)",eventId);
  orchestration.enqueueReady(members,policy,3);expect(sql.exec<{state:string}>('SELECT state FROM crew_runs').one().state).toBe('waiting');
  sql.exec("UPDATE crew_unit_ledger SET state='consumed'");orchestration.enqueueReady(members,policy,4);
  expect(sql.exec<{state:string;next_check_at:number|null}>('SELECT state,next_check_at FROM crew_runs').one()).toMatchObject({state:'skipped',next_check_at:null});
  expect(sql.exec<{status:string}>('SELECT status FROM crew_decisions').one().status).toBe('skipped');
 });
});
it('strictly validates configured project rules',()=>{
 for(const projectRules of [{smith:{modules:{core:['../x']}}},{smith:{riskRules:[{paths:['src/**'],risk:'extreme'}]}},{smith:{unknown:true}}])expect(()=>validateOrchestrationPolicy({projectRules})).toThrow();
});
