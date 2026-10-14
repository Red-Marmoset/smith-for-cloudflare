import { beforeAll, describe, it, expect } from 'vitest';
import { env } from 'cloudflare:workers';
import identity from '../migrations/0001_identity.sql?raw';
import { crewSetup } from './crew-fixture';
import { coalesceCheckIn, retainCheckIns } from '../src/crew-coalescing';
import { CrewEvents, type StoredCheckIn } from '../src/crew-events';
import { validateMemberOrchestration } from '../src/crew-orchestration-model';
beforeAll(async()=>{await env.DB.exec(identity);});
function event(sql:SqlStorage,id:string,base:string,head:string,at:number,state='ready',branch='main'):StoredCheckIn {
 const metadata=JSON.stringify({complete:true,ancestor:true,testState:'unknown',changes:[{path:id+'.ts',oldPath:null,added:1,deleted:0}]});
 sql.exec('INSERT INTO crew_checkins(id,project_id,repo_key,branch,base_commit,head_commit,kind,source,delivery_id,created_at,updated_at,state,metadata,allowance) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',id,'smith','repo',branch,base,head,'push','manual',id,at,at,state,metadata,8);
 sql.exec('INSERT INTO crew_event_members VALUES(?,?)',id,id);return new CrewEvents(sql).get(id);
}
function waiting(sql:SqlStorage,e:StoredCheckIn){
 const config=validateMemberOrchestration({debounceMs:100,maxDebounceWaitMs:1000},'plan');
 const snapshot={event:e,member:{id:'member',charter:'original'},config,depth:0,parentRunId:null};
 sql.exec("INSERT INTO crew_runs(id,crew_id,due_at,state,trigger,created_at,updated_at,event_id,snapshot) VALUES(?,'member',?,'waiting','{}',?,?,?,?)",e.id+'run',e.created_at+100,e.created_at,e.created_at,e.id,JSON.stringify(snapshot));
 sql.exec("INSERT INTO crew_decisions VALUES(?,'member','eligible','filters_matched','{}',?)",e.id,e.id+'run');
}
describe('check-in coalescing and retention',()=>{
 it('coalesces a verified chain while preserving queued configuration and maximum budget',async()=>{
  const f=await crewSetup();await f.sql(sql=>{
   const first=event(sql,'first','a','b',100,'evaluated');waiting(sql,first);
   const second=event(sql,'second','b','c',200);sql.exec('UPDATE crew_checkins SET allowance=15 WHERE id=?',second.id);second.allowance=15;
   const result=coalesceCheckIn(sql,second,200);
   expect(result).toMatchObject({id:'first',base_commit:'a',head_commit:'c',allowance:15});
   const run=sql.exec<{snapshot:string;due_at:number}>('SELECT snapshot,due_at FROM crew_runs').one();
   expect(JSON.parse(run.snapshot)).toMatchObject({member:{charter:'original'},event:{head_commit:'c'}});expect(run.due_at).toBe(300);
   expect(new CrewEvents(sql).get('second').state).toBe('coalesced');
   expect(sql.exec("SELECT * FROM crew_event_members WHERE root_id='first'").toArray()).toHaveLength(2);
  });
 });
 it.each(['branch','diverged','admitted','requested','root-finding','incoming-finding'])('keeps %s work separate',async mode=>{
  const f=await crewSetup();await f.sql(sql=>{
   const first=event(sql,'first','a','b',100,'evaluated');waiting(sql,first);
   const second=event(sql,'second',mode==='diverged'?'z':'b','c',200,'ready',mode==='branch'?'other':'main');
   if(mode==='admitted')sql.exec("INSERT INTO crew_unit_ledger VALUES('firstrun','first',1,'reserved',100)");
   if(mode==='requested')sql.exec("INSERT INTO crew_requests VALUES('q','firstrun','other','first','q','reason','accepted','queued',100)");
   if(mode.endsWith('finding')) {
    const pinned = mode==='root-finding' ? first : second;
    sql.exec("INSERT INTO crew_findings VALUES('finding','smith','fingerprint','{}','human_review',100,100)");
    sql.exec("INSERT INTO crew_finding_occurrences(finding_id,event_id,run_id,head_commit,value,created_at) VALUES('finding',?,'report',?,'{}',100)",pinned.id,pinned.head_commit);
   }
   expect(coalesceCheckIn(sql,second,200).id).toBe('second');
   expect(new CrewEvents(sql).get(first.id).head_commit).toBe('b');
  });
 });
 it('prunes expired terminal aggregates but preserves active, quarantined and unresolved references',async()=>{
  const f=await crewSetup();await f.sql(sql=>{
   event(sql,'old','a','b',1,'evaluated');
   const active=event(sql,'active','c','d',1,'evaluated');waiting(sql,active);
   const quarantine=event(sql,'quarantine','e','f',1,'evaluated');waiting(sql,quarantine);sql.exec("UPDATE crew_runs SET state='lost' WHERE event_id='quarantine'");
   sql.exec("INSERT INTO crew_scope_leases VALUES('lease','quarantinerun','repo','main','[\"\"]',1,10,'quarantined')");
   event(sql,'unresolved','g','h',1,'evaluated');
   sql.exec("INSERT INTO crew_findings VALUES('finding','smith','fingerprint','{}','human_review',1,1)");
   sql.exec("INSERT INTO crew_finding_occurrences(finding_id,event_id,run_id,head_commit,value,created_at) VALUES('finding','unresolved','r','h','{}',1)");
   expect(retainCheckIns(sql,31*86400000).deletedEvents).toBe(1);
   expect(sql.exec<{id:string}>('SELECT id FROM crew_checkins ORDER BY id').toArray().map(r=>r.id)).toEqual(['active','quarantine','unresolved']);
  });
 });
});

it('keeps one waiting snapshot across ten ancestor commits and caps debounce',async()=>{
 const f=await crewSetup();await f.sql(sql=>{
  const root=event(sql,'chain0','sha0','sha1',0,'evaluated');waiting(sql,root);
  for(let i=1;i<10;i++)expect(coalesceCheckIn(sql,event(sql,'chain'+i,'sha'+i,'sha'+(i+1),i*200),i*200).id).toBe('chain0');
  expect(sql.exec('SELECT * FROM crew_runs').toArray()).toHaveLength(1);
  expect(sql.exec<{due_at:number}>('SELECT due_at FROM crew_runs').one().due_at).toBe(1000);
  expect(new CrewEvents(sql).get('chain0')).toMatchObject({base_commit:'sha0',head_commit:'sha10',allowance:8});
  expect(sql.exec("SELECT * FROM crew_event_members WHERE root_id='chain0'").toArray()).toHaveLength(10);
 });
});
it('keeps at most 1000 unprotected completed aggregates and prunes all constituent deliveries',async()=>{
 const f=await crewSetup();await f.sql(sql=>{
  for(let i=0;i<1001;i++)event(sql,'terminal'+i,'a','b',i+1,'completed');
  sql.exec("INSERT INTO crew_event_deliveries VALUES('terminal0','smith','manual','first','{}')");
  expect(retainCheckIns(sql,2000)).toEqual({deletedEvents:1,deletedAggregates:1});
  expect(sql.exec<{n:number}>('SELECT COUNT(*) n FROM crew_checkins').one().n).toBe(1000);
  expect(sql.exec('SELECT * FROM crew_event_deliveries').toArray()).toHaveLength(0);
 });
});

it('opens a coalesced delivery through its root audit record',async()=>{
 const f=await crewSetup();await f.sql(sql=>{const root=event(sql,'root','a','b',100,'evaluated');waiting(sql,root);coalesceCheckIn(sql,event(sql,'child','b','c',200),200);});
 const response=await f.stub.execute(f.operator,'crew-checkin-detail',{eventId:'child'});
 expect(await response.json()).toMatchObject({requestedEventId:'child',event:{id:'root',head_commit:'c'},runs:[{id:'rootrun'}]});
});
