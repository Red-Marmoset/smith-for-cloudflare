import { beforeAll, describe, it, expect } from 'vitest';
import { env } from 'cloudflare:workers';
import identity from '../migrations/0001_identity.sql?raw';
beforeAll(async () => { await env.DB.exec(identity); });
import { CrewEvents } from '../src/crew-events';
import { crewSetup, CREW_AI, errorOf } from './crew-fixture';

describe('check-in orchestration integration', () => {
  it('persists opt-in member configuration and leaves legacy members alone', async () => {
    const f = await crewSetup();
    const old = await f.create();
    expect((await f.list()).find(m => m.id === old.id)).toHaveProperty('orchestration', null);
    const next = await f.create({ name: 'Event reviewer', permissionMode: 'plan', orchestration: { events: ['push'] } });
    expect((await f.list()).find(m => m.id === next.id)).toMatchObject({ orchestration: { mode: 'read_only', events: ['push'] } });
  });
  it('stores duplicate check-in deliveries once without trusting supplied metadata', async () => {
    const f = await crewSetup();
    const input = { projectId: 'smith', branch: 'main', baseCommit: 'a'.repeat(40), headCommit: 'b'.repeat(40), kind: 'push', deliveryId: 'delivery-1' };
    const a = await f.stub.execute(f.operator, 'crew-checkin', input);
    expect(a.status).toBe(201);
    const first = await a.json() as { eventId: string };
    const b = await f.stub.execute(f.operator, 'crew-checkin', input);
    expect(b.status).toBe(200);
    expect(await b.json()).toMatchObject({ eventId: first.eventId, duplicate: true });
    expect(await errorOf(f.stub.execute(await f.member('viewer'), 'crew-checkin', input))).toMatchObject({ status: 403 });
    const changed = await f.stub.execute(f.operator, 'crew-checkin', { ...input, headCommit: 'c'.repeat(40) });
    expect(changed.status).toBe(409);
    const forged = await f.stub.execute(f.operator, 'crew-checkin', { ...input, deliveryId: 'two', metadata: { complete: true, changes: [] } });
    expect(forged.status).toBe(400);
  });
});


it('runs eligible check-ins pinned to their commit and charges shared units once', async () => {
 const f=await crewSetup();
 await f.stub.execute(f.owner,'put-settings',{orchestration:{enabled:true},crewMaxConcurrentRuns:3});
 const machine=await f.machine(f.owner,'build',{...CREW_AI,features:[...CREW_AI.features,'crew-orchestration-v1']});
 await f.stub.execute(f.owner,'node-crew',{nodeId:machine.nodeId,run:true});
 const member=await f.create({name:'Auth review',permissionMode:'plan',orchestration:{events:['push'],paths:['src/auth/**'],unitCost:2}});
 const other=await f.create({name:'Docs review',permissionMode:'plan',orchestration:{events:['push'],paths:['docs/**']}});
 const input={projectId:'smith',branch:'main',baseCommit:'a'.repeat(40),headCommit:'b'.repeat(40),kind:'push',deliveryId:'pinned'};
 const response=await f.stub.execute(f.operator,'crew-checkin',input);
 const {eventId}=await response.json() as {eventId:string};
 await f.sql(sql=>new CrewEvents(sql).ready(eventId,{changes:[{path:'src/auth/user.ts',oldPath:null,added:1,deleted:0}],complete:true,ancestor:true,testState:'unknown'},Date.now()));
 await f.alarm();
 const turn=await f.claim(machine.node);
 expect(turn).toMatchObject({orchestration:{version:1,eventId,baseCommit:input.baseCommit,headCommit:input.headCommit,mode:'read_only'}});
 expect(await f.runs(other.id)).toHaveLength(0);
 expect(await f.runs(member.id)).toHaveLength(1);
 expect((await f.finish(turn!,{status:'completed',message:'Reviewed',baseCommit:input.headCommit,costUsd:0.1,files:[],filesTotal:0,report:{summary:'No regression',findings:[]}},machine.node)).status).toBe(200);
 const detail=await (await f.stub.execute(f.operator,'crew-checkin-detail',{eventId})).json() as {budget:{units:number,state:string}[]};
 expect(detail.budget).toEqual([expect.objectContaining({units:2,state:'consumed'})]);
});

it('normalizes ordinary failed builds once and excludes autonomous build loops', async()=>{
 const f=await crewSetup();
 await f.sql(sql=>{
  const projects=sql.exec<{definition:string}>('SELECT definition FROM projects').toArray().map(r=>JSON.parse(r.definition));
  const events=new CrewEvents(sql),job={id:'failed-build',kind:'build',request_id:'ordinary',project_id:'smith',state:'failed',secretless:0,result:JSON.stringify({commit:'a'.repeat(40)})};
  events.failedBuild(job,projects,1);events.failedBuild(job,projects,2);
  for(const patch of [{id:'verify',request_id:'ai-verify-x'},{id:'created',request_id:'crew-x'},{id:'secretless',secretless:1},{id:'success',state:'success'}])events.failedBuild({...job,...patch},projects,3);
  const rows=sql.exec('SELECT * FROM crew_checkins').toArray();expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({kind:'test_failure',source:'smith-build',base_commit:'a'.repeat(40),head_commit:'a'.repeat(40)});
  events.ready(String(rows[0].id),{changes:[],complete:true,ancestor:true,testState:'unknown'},4);
  expect(JSON.parse(events.get(String(rows[0].id)).metadata!)).toMatchObject({testState:'failed',testSource:{kind:'smith-build',jobId:'failed-build'}});
  const finding=sql.exec<{value:string}>('SELECT value FROM crew_findings').one();
  expect(JSON.parse(finding.value)).toMatchObject({category:'test_failure',title:'Failed Smith build'});
  expect(JSON.parse(finding.value).detail).toContain('failed-build');
  expect(sql.exec('SELECT event_id,head_commit FROM crew_finding_occurrences').one()).toMatchObject({event_id:rows[0].id,head_commit:'a'.repeat(40)});
 });
});
it('dispatches a metadata-only native job with an empty environment and accepts its pinned report',async()=>{
 const f=await crewSetup();
 await f.sql(sql=>sql.exec('UPDATE nodes SET labels=? WHERE id=?',JSON.stringify(['checkin-metadata-v1']),f.builder.nodeId).toArray());
 const baseCommit='a'.repeat(40),headCommit='b'.repeat(40);
 const submitted=await f.stub.execute(f.operator,'crew-checkin',{projectId:'smith',branch:'main',baseCommit,headCommit,kind:'push',deliveryId:'native-metadata'});
 const {eventId}=await submitted.json() as {eventId:string};await f.alarm();
 const response=await f.stub.execute(f.builder.node,'claim',{});
 const assigned=await response.json() as {hasJob:boolean;envelope:{lease:{jobId:string;attemptId:string;leaseToken:string};spec:{kind:string;env:Record<string,string>;checkIn:unknown;repos:{commit:string}[]}}};
 expect(assigned.hasJob).toBe(true);expect(assigned.envelope.spec).toMatchObject({kind:'checkin',env:{},checkIn:{eventId,baseCommit,headCommit}});
 expect(Object.keys(assigned.envelope.spec.env)).toHaveLength(0);expect(assigned.envelope.spec.repos[0].commit).toBe(headCommit);
 const {jobId,attemptId,leaseToken}=assigned.envelope.lease;
 const completion=await f.stub.execute(f.builder.node,'complete',{jobId,attemptId,leaseToken,result:{status:'success',exitCode:0,durationMs:1,message:'Metadata read',checkIn:{eventId,baseCommit,headCommit,complete:true,ancestor:true,testState:'unknown',changes:[{path:'src/file.ts',added:2,deleted:0}]}}});
 expect(completion.status,await completion.clone().text()).toBe(200);
 expect(await f.sql(sql=>new CrewEvents(sql).get(eventId))).toMatchObject({state:'ready'});
});

it('completes all six starter reviewers as findings-only runs on a PR-ready check-in',async()=>{
 const {ORCHESTRATION_TEMPLATES}=await import('../src/crew-orchestration-templates');
 const f=await crewSetup();
 await f.stub.execute(f.owner,'put-settings',{orchestration:{enabled:true},crewDailyUsdLimit:20});
 const machine=await f.machine(f.owner,'build',{...CREW_AI,features:[...CREW_AI.features,'crew-orchestration-v1']});
 await f.stub.execute(f.owner,'node-crew',{nodeId:machine.nodeId,run:true});
 for(const seed of Object.values(ORCHESTRATION_TEMPLATES))await f.create({...seed});
 const headCommit='c'.repeat(40);
 const response=await f.stub.execute(f.operator,'crew-checkin',{projectId:'smith',branch:'main',baseCommit:'a'.repeat(40),headCommit,kind:'pr_ready',deliveryId:'six-reviewers'});
 const {eventId}=await response.json() as {eventId:string};
 await f.sql(sql=>new CrewEvents(sql).ready(eventId,{changes:[{path:'src/auth/user.ts',oldPath:null,added:20,deleted:2}],complete:true,ancestor:true,testState:'unknown'},Date.now()));
 for(let i=0;i<6;i++){
  await f.sql(sql=>sql.exec("UPDATE crew_runs SET next_check_at=0 WHERE state='waiting'").toArray());await f.alarm();
  const turn=await f.claim(machine.node);expect(turn).not.toBeNull();
  expect(turn).toMatchObject({orchestration:{headCommit,mode:'read_only'}});
  const done=await f.finish(turn!,{status:'completed',message:'Reviewed',baseCommit:headCommit,costUsd:0.01,files:[],filesTotal:0,report:{summary:'Reviewed range',findings:[{severity:'low',title:`Reviewer ${i}`,detail:'Evidence at the pinned commit',file:'src/auth/user.ts',line:1}]}},machine.node);
  expect(done.status,await done.clone().text()).toBe(200);
 }
 const detail=await (await f.stub.execute(f.operator,'crew-checkin-detail',{eventId})).json() as {runs:{state:string}[];findings:unknown[];budget:{units:number;state:string}[]};
 expect(detail.runs).toHaveLength(6);expect(detail.findings).toHaveLength(6);expect(detail.budget.reduce((sum,b)=>sum+b.units,0)).toBe(15);expect(detail.budget.every(b=>b.state==='consumed')).toBe(true);
},20000);
