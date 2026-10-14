import { coalesceCheckIn } from './crew-coalescing';
import { fail, fields, json, string } from './http';
import { CrewEvents, type StoredCheckIn } from './crew-events';
import { evaluateEligibility, matchRepoGlob, type EligibilityFacts } from './crew-eligibility';
import { computeDue, stableJitter, compareCandidates } from './crew-scheduling';
import { scopesOverlap } from './crew-leases';
import type { CrewMember } from './crew-model';
import type { MemberOrchestration, OrchestrationPolicy, CheckInKind } from './crew-orchestration-model';
import type { CheckInMetadata } from './checkin-metadata';

export interface EventSnapshot { event: StoredCheckIn; member: CrewMember; config: MemberOrchestration; depth: number; parentRunId: string | null; }
type EventRun = { id:string; crew_id:string; event_id:string; state:string; snapshot:string; session_id:string|null; due_at:number; started_at:number|null; }
type ScopeLease = { id:string; run_id:string; repo_key:string; branch:string; scopes:string; generation:number; expires_at:number; state:string; }
export class CrewOrchestration {
 constructor(private sql:SqlStorage) {}
 actionEligibility(event:StoredCheckIn,member:CrewMember,policy:OrchestrationPolicy) {
  // An explicit finding action replaces the event-kind trigger; all repository, path,
  // risk and scope filters still apply to the captured evidence.
  return evaluateEligibility({...member.orchestration!,events:undefined},this.facts(event,policy));
 }
 snapshot(runId:string):EventSnapshot|null { const s=this.sql.exec<{snapshot:string|null}>('SELECT snapshot FROM crew_runs WHERE id=?',runId).toArray()[0]?.snapshot;return s?JSON.parse(s):null; }
 forSession(sessionId:string):EventSnapshot|null { const s=this.sql.exec<{snapshot:string|null}>('SELECT snapshot FROM crew_runs WHERE session_id=?',sessionId).toArray()[0]?.snapshot;return s?JSON.parse(s):null; }
 private facts(event:StoredCheckIn,policy:OrchestrationPolicy):EligibilityFacts {
  const metadata:CheckInMetadata=JSON.parse(event.metadata!);
  const paths=[...new Set(metadata.changes.flatMap(c=>c.oldPath?[c.path,c.oldPath]:[c.path]))];
  const lines=metadata.changes.every(c=>c.added!==null&&c.deleted!==null)?metadata.changes.reduce((n,c)=>n+c.added!+c.deleted!,0):undefined;
  const dependencies=paths.filter(p=>/(^|\/)(package(-lock)?\.json|Cargo\.(lock|toml)|requirements[^/]*|go\.(mod|sum)|.*\.csproj)$/.test(p));
  const projectRules=policy.projectRules&&Object.hasOwn(policy.projectRules,event.project_id)?policy.projectRules[event.project_id]:undefined;
  const matchedRisks=projectRules?.riskRules.filter(r=>paths.some(p=>r.paths.some(g=>matchRepoGlob(g,p)))).map(r=>r.risk)??[];
  const configuredRisk=matchedRisks.includes('high')?'high':matchedRisks.includes('normal')?'normal':matchedRisks.includes('low')?'low':'normal';
  const modules=projectRules?Object.entries(projectRules.modules).filter(([,patterns])=>paths.some(p=>patterns.some(g=>matchRepoGlob(g,p)))).map(([name])=>name):undefined;
  const risk=projectRules?configuredRisk:dependencies.length||paths.some(p=>/(^|\/)(auth|security|migrations?)(\/|\.)/.test(p))?'high':paths.every(p=>/\.(md|txt|rst)$/.test(p))?'low':'normal';
  const previous=this.sql.exec<{value:string}>("SELECT value FROM crew_findings WHERE project_id=? AND disposition NOT IN ('resolved','dismissed','no_action')",event.project_id).toArray();
  return {kind:event.kind as CheckInKind,branch:event.branch,metadataState:metadata.complete?'complete':'incomplete',paths,
   languages:[...new Set(paths.map(p=>{const ext=p.includes('.')?p.split('.').at(-1)!:'unknown';return ({ts:'typescript',tsx:'typescript',js:'javascript',jsx:'javascript',py:'python',cpp:'cpp',h:'cpp',hpp:'cpp',cs:'csharp',rs:'rust',go:'go',md:'markdown'} as Record<string,string>)[ext]??ext;}))],modules,
   dependencies,changedLines:lines,risk,previousFindingCategories:previous.map(f=>JSON.parse(f.value).category??'uncategorized')};
 }
 evaluate(event:StoredCheckIn,members:CrewMember[],policy:OrchestrationPolicy,now:number,dryRun=false):unknown[] {
  const decisions:unknown[]=[]; if(!event.metadata) return decisions;
  const facts=this.facts(event,policy), allowance=policy.eventBudgets[event.kind==='pr_ready'?'pr_ready':event.kind==='release_candidate'?'release_candidate':facts.risk??'normal'];
  if(!dryRun)this.sql.exec('UPDATE crew_checkins SET allowance=? WHERE id=? AND allowance=0',allowance,event.id);
  for(const member of members.filter(m=>m.orchestration&&m.projectIds[0]===event.project_id)){
   if(!dryRun&&this.sql.exec('SELECT 1 FROM crew_decisions WHERE event_id=? AND crew_id=?',event.id,member.id).toArray().length)continue;
   const config=member.orchestration!, automation=policy.projectRules?.[event.project_id]?.automation;
   const actionTarget=automation&&(automation.fixerCrewId===member.id||automation.testCrewId===member.id);
   const writerWait=config.mode==='write'&&automation&&(automation.mode!=='automatic_fix'||actionTarget);
   const decision=!member.enabled?{status:'skipped',reason:'member_disabled',matched:{}}
    :writerWait?{status:'skipped',reason:automation.mode==='report_only'?'project_report_only':'awaiting_finding_action',matched:{}}
    :evaluateEligibility(config,facts);
   decisions.push({crewId:member.id,...decision});
   if(dryRun)continue;
   this.sql.exec('INSERT INTO crew_decisions VALUES(?,?,?,?,?,NULL)',event.id,member.id,decision.status,decision.reason,JSON.stringify({matched:decision.matched,config,policy}));
   if(decision.status==='eligible')this.enqueue(event,member,now,0,null);
  }
  if(!dryRun)this.sql.exec("UPDATE crew_checkins SET state='evaluated',next_at=NULL,updated_at=? WHERE id=?",now,event.id);
  return decisions;
 }
 enqueue(event:StoredCheckIn,member:CrewMember,now:number,depth:number,parentRunId:string|null):string {
  const existing=this.sql.exec<{id:string}>('SELECT id FROM crew_runs WHERE event_id=? AND crew_id=? LIMIT 1',event.id,member.id).toArray()[0];if(existing)return existing.id;
  const config=member.orchestration!,id=crypto.randomUUID();
  const last=this.sql.exec<{at:number|null}>('SELECT MAX(started_at) at FROM crew_runs WHERE crew_id=?',member.id).one().at;
  const due=computeDue({firstReceived:event.created_at,lastReceived:now,lastStarted:last,...config,jitterMs:stableJitter(event.id+member.id,config.maxJitterMs)});
  const snapshot:EventSnapshot={event,member:JSON.parse(JSON.stringify(member)),config,depth,parentRunId};
  this.sql.exec("INSERT INTO crew_runs(id,crew_id,due_at,next_check_at,state,trigger,created_at,updated_at,event_id,snapshot) VALUES(?,?,?,?,'waiting',?,?,?,?,?)",
   id,member.id,due,due,JSON.stringify({kind:'checkin',eventId:event.id}),now,now,event.id,JSON.stringify(snapshot));
  this.sql.exec('UPDATE crew_decisions SET run_id=? WHERE event_id=? AND crew_id=?',id,event.id,member.id);
  return id;
 }
 enqueueReady(members:CrewMember[],policy:OrchestrationPolicy,now:number):void {
  if(!policy.enabled)return;
  for(const e of this.sql.exec<StoredCheckIn>("SELECT * FROM crew_checkins WHERE state='ready' ORDER BY created_at,id LIMIT 50").toArray()) {
   const facts=this.facts(e,policy), allowance=policy.eventBudgets[e.kind==='pr_ready'?'pr_ready':e.kind==='release_candidate'?'release_candidate':facts.risk??'normal'];
   this.sql.exec('UPDATE crew_checkins SET allowance=MAX(allowance,?) WHERE id=?',allowance,e.id);
   const root=coalesceCheckIn(this.sql,{...e,allowance},now);this.evaluate(root,members,policy,now);
  }
  // Claimed units never refund; unclaimed work may still restore capacity.
  for(const run of this.sql.exec<EventRun>("SELECT * FROM crew_runs WHERE state='waiting' AND event_id IS NOT NULL").toArray()) {
   const s:EventSnapshot=JSON.parse(run.snapshot),root=new CrewEvents(this.sql).get(run.event_id);
   const consumed=this.sql.exec<{n:number;units:number|null}>("SELECT COUNT(*) n,SUM(units) units FROM crew_unit_ledger WHERE event_id=? AND state='consumed'",run.event_id).one();
   const reason=s.depth>policy.maxDepth||consumed.n>=policy.maxRuns?'event_run_limit_exhausted':(consumed.units??0)+s.config.unitCost>root.allowance?'event_budget_exhausted':null;
   if(!reason)continue;
   this.sql.exec("UPDATE crew_runs SET state='skipped',wait_reason=?,next_check_at=NULL,updated_at=? WHERE id=?",reason,now,run.id);
   this.sql.exec("UPDATE crew_decisions SET status='skipped',reason=? WHERE event_id=? AND crew_id=?",reason,run.event_id,run.crew_id);
  }
 }
 order<T extends {id:string;due_at:number}>(runs:T[],now:number):T[] {
  return runs.map((r,i)=>({r,i,s:this.snapshot(r.id)})).sort((a,b)=>compareCandidates({priority:a.s?.config.priority??'normal',dueAt:a.r.due_at,sequence:a.i},{priority:b.s?.config.priority??'normal',dueAt:b.r.due_at,sequence:b.i},now)).map(v=>v.r);
 }
 refusal(runId:string,policy:OrchestrationPolicy,now:number):string|null {
  const snapshot=this.snapshot(runId);if(!snapshot)return null;
  if(!policy.enabled)return 'check-in orchestration disabled';
  const {event,config,member}=snapshot;
  const last=this.sql.exec<{at:number|null}>('SELECT MAX(started_at) at FROM crew_runs WHERE crew_id=? AND id!=?',member.id,runId).one().at;
  if(last!==null&&last+config.cooldownMs>now)return 'cooldown';
  const rates=this.sql.exec<{n:number}>("SELECT COUNT(*) n FROM crew_runs WHERE started_at>?",now-3600000).one().n;
  if(rates>=policy.globalStartsPerHour)return 'global start rate';
  const root=new CrewEvents(this.sql).get(event.id);
  const charged=this.sql.exec<{n:number;units:number|null}>("SELECT COUNT(*) n,SUM(units) units FROM crew_unit_ledger WHERE event_id=? AND state!='refunded'",event.id).one();
  if(charged.n>=policy.maxRuns||snapshot.depth>policy.maxDepth)return 'event run limit';
  if((charged.units??0)+config.unitCost>root.allowance)return 'event budget';
  const active=this.sql.exec<{snapshot:string|null;crew_id:string}>(`SELECT snapshot,crew_id FROM crew_runs WHERE state IN ('queued','running','pushing') AND id!=?`,runId).toArray();
  if(active.some(r=>r.crew_id===member.id))return 'member busy';
  const classCount=active.filter(r=>r.snapshot&&(JSON.parse(r.snapshot) as EventSnapshot).config.costClass===config.costClass).length;
  if(classCount>=policy.concurrency[config.costClass])return 'cost class concurrency';
  const leases=this.sql.exec<ScopeLease>("SELECT * FROM crew_scope_leases WHERE repo_key=? AND branch=? AND state!='released'",event.repo_key,event.branch).toArray();
  if(config.mode==='write'&&leases.some(l=>JSON.parse(l.scopes).some((a:string)=>config.writeScopes.some(b=>scopesOverlap(a,b)))))return 'write scope leased';
  return null;
 }
 reserve(runId:string,now:number):void {
  const s=this.snapshot(runId);if(!s)return;
  this.sql.exec("INSERT INTO crew_unit_ledger VALUES(?,?,?,'reserved',?) ON CONFLICT(run_id) DO UPDATE SET state='reserved',started_at=excluded.started_at",runId,s.event.id,s.config.unitCost,now);
  if(s.config.mode==='write'){
   const expiry=now+(s.member.budget.maxMinutes+30)*60000;
   this.sql.exec("INSERT INTO crew_scope_leases VALUES(?,?,?,?,?,1,?,'active') ON CONFLICT(run_id) DO UPDATE SET generation=generation+1,expires_at=excluded.expires_at,state='active'",crypto.randomUUID(),runId,s.event.repo_key,s.event.branch,JSON.stringify(s.config.writeScopes),expiry);
  }
 }
 claim(sessionId:string,now:number):Record<string,unknown>|null {
  const s=this.forSession(sessionId);if(!s)return null;
  const run=this.sql.exec<EventRun>('SELECT * FROM crew_runs WHERE session_id=?',sessionId).one();
  const lease=this.sql.exec<ScopeLease>("SELECT * FROM crew_scope_leases WHERE run_id=?",run.id).toArray()[0];
  if(s.config.mode==='write'&&(!lease||lease.state!=='active'||lease.expires_at<=now))fail(409,'stale_scope_lease','Writer lease is not current');
  this.sql.exec("UPDATE crew_unit_ledger SET state='consumed' WHERE run_id=? AND state='reserved'",run.id);
  return {version:1,eventId:s.event.id,baseCommit:s.event.base_commit,headCommit:s.event.head_commit,mode:s.config.mode,writeScopes:s.config.writeScopes,
   lease:lease?{id:lease.id,generation:lease.generation,expiresAt:lease.expires_at}:null};
 }
 assertCurrent(sessionId:string,now:number):void {
  const s=this.forSession(sessionId);if(!s)return;
  if(s.config.mode==='write'){
   const lease=this.sql.exec<ScopeLease>('SELECT l.* FROM crew_scope_leases l JOIN crew_runs r ON r.id=l.run_id WHERE r.session_id=?',sessionId).toArray()[0];
   if(!lease||lease.state!=='active'||lease.expires_at<=now)fail(409,'stale_scope_lease','This writer lease expired');
  }
 }
 settle(now:number):void {
  const entries=this.sql.exec<{run_id:string;ledger_state:string;state:string;session_id:string|null}>("SELECT l.run_id,l.state ledger_state,r.state,r.session_id FROM crew_unit_ledger l JOIN crew_runs r ON r.id=l.run_id WHERE l.state!='refunded'").toArray();
  for(const r of entries){
   if(['queued','running','pushing'].includes(r.state))continue;
   if(r.ledger_state==='reserved')this.sql.exec("UPDATE crew_unit_ledger SET state='refunded' WHERE run_id=?",r.run_id);
   const unsafe=r.state==='lost'||(r.state==='stopped'&&r.ledger_state==='consumed');
   this.sql.exec("UPDATE crew_scope_leases SET state=? WHERE run_id=? AND state='active'",unsafe?'quarantined':'released',r.run_id);
  }
  this.sql.exec("UPDATE crew_scope_leases SET state='quarantined' WHERE state='active' AND expires_at<=?",now);
  this.sql.exec("UPDATE crew_scope_leases SET state='released' WHERE state='quarantined' AND expires_at+60000<=?",now);
 }
 nextDue():number|null {return this.sql.exec<{at:number|null}>("SELECT MIN(at) at FROM (SELECT next_at at FROM crew_checkins WHERE next_at IS NOT NULL UNION ALL SELECT expires_at at FROM crew_scope_leases WHERE state='active' UNION ALL SELECT expires_at+60000 at FROM crew_scope_leases WHERE state='quarantined')").one().at;}
 request(sessionId:string,body:Record<string,unknown>,members:CrewMember[],policy:OrchestrationPolicy,now:number):Response {
  fields(body,['targetCrewId','findingIds','reason','requestId']);this.assertCurrent(sessionId,now);
  const source=this.sql.exec<EventRun>("SELECT * FROM crew_runs WHERE session_id=? AND state='running'",sessionId).toArray()[0]??fail(409,'run_over','Run is no longer active');
  const s=this.snapshot(source.id)??fail(409,'not_checkin','Only check-in runs request another reviewer');
  const target=string(body,'targetCrewId',64),requestId=string(body,'requestId',128),reason=string(body,'reason',2000);
  const previous=this.sql.exec<{id:string;state:string;detail:string}>('SELECT id,state,detail FROM crew_requests WHERE source_run_id=? AND request_id=?',source.id,requestId).toArray()[0];if(previous)return json(previous);
  const ids=body.findingIds;if(!Array.isArray(ids)||ids.length>50||ids.some(x=>typeof x!=='string'))fail(400,'invalid_field','findingIds must be at most 50 finding IDs');
  for(const id of ids)if(!this.sql.exec('SELECT 1 FROM crew_finding_occurrences WHERE finding_id=? AND event_id=?',id,s.event.id).toArray().length)fail(403,'forbidden','Finding does not belong to this check-in');
  const member=members.find(m=>m.id===target), count=this.sql.exec<{n:number}>('SELECT COUNT(*) n FROM crew_requests WHERE source_run_id=?',source.id).one().n;
  if(count>=20)fail(429,'request_cap','This run has made its 20 requests');
  let detail=!policy.enabled?'orchestration_disabled':!s.config.canRequest.includes(target)?'not_allowed':target===source.crew_id?'cycle':
   !member?.enabled||!member.orchestration?'target_disabled':member.projectIds[0]!==s.event.project_id?'project_mismatch':
   s.depth>=policy.maxDepth?'depth_limit':this.sql.exec('SELECT 1 FROM crew_runs WHERE event_id=? AND crew_id=?',s.event.id,target).toArray().length?'already_requested':'';
  if(!detail&&member?.orchestration){const decision=evaluateEligibility(member.orchestration,this.facts(s.event,policy));if(decision.status!=='eligible')detail=decision.reason;}
  const charge=this.sql.exec<{units:number|null}>("SELECT SUM(units) units FROM crew_unit_ledger WHERE event_id=? AND state!='refunded'",s.event.id).one().units??0;
  const root=new CrewEvents(this.sql).get(s.event.id);
  if(!detail&&this.sql.exec<{n:number}>("SELECT COUNT(*) n FROM crew_runs WHERE event_id=? AND state NOT IN ('stopped','skipped')",s.event.id).one().n>=policy.maxRuns)detail='event_run_limit';
  if(!detail&&charge+member!.orchestration!.unitCost>root.allowance)detail='event_budget';
  const id=crypto.randomUUID(),state=detail?'refused':'accepted';
  this.sql.exec('INSERT INTO crew_requests VALUES(?,?,?,?,?,?,?,?,?)',id,source.id,target,s.event.id,requestId,reason,state,detail||'queued',now);
  if(!detail){
   this.sql.exec("INSERT INTO crew_decisions VALUES(?,?,'eligible','requested_review','{}',NULL) ON CONFLICT(event_id,crew_id) DO UPDATE SET status='eligible',reason='requested_review'",s.event.id,target);
   this.enqueue(root,member!,now,s.depth+1,source.id);
  }
  return json({id,state,detail:detail||'queued'},201);
 }
}
