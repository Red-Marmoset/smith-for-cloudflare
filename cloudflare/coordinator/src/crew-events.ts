// Durable check-in inbox. Only metadata returned by the registered repository reader is accepted.
import { fail, fields, json, string } from './http';
import type { Project } from './projects';
import type { RepoProject } from './repo-projects';
import type { CheckInMetadata } from './checkin-metadata';
import { CrewFindings } from './crew-findings';

export const CHECKIN_SCHEMA = `
CREATE TABLE IF NOT EXISTS crew_checkins (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL, repo_key TEXT NOT NULL, branch TEXT NOT NULL,
 base_commit TEXT NOT NULL, head_commit TEXT NOT NULL, kind TEXT NOT NULL, source TEXT NOT NULL,
 delivery_id TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 state TEXT NOT NULL, metadata TEXT, reason TEXT, next_at INTEGER, job_id TEXT, attempts INTEGER NOT NULL DEFAULT 0,
 allowance INTEGER NOT NULL DEFAULT 0, UNIQUE(project_id, source, delivery_id));
CREATE TABLE IF NOT EXISTS crew_event_deliveries (event_id TEXT NOT NULL, project_id TEXT NOT NULL, source TEXT NOT NULL, delivery_id TEXT NOT NULL,
 payload TEXT NOT NULL, PRIMARY KEY(project_id,source,delivery_id));
CREATE TABLE IF NOT EXISTS crew_decisions (event_id TEXT NOT NULL, crew_id TEXT NOT NULL, status TEXT NOT NULL, reason TEXT NOT NULL,
 facts TEXT NOT NULL, run_id TEXT, PRIMARY KEY(event_id,crew_id));
CREATE TABLE IF NOT EXISTS crew_event_members (root_id TEXT NOT NULL, event_id TEXT NOT NULL, PRIMARY KEY(root_id,event_id));
CREATE TABLE IF NOT EXISTS crew_unit_ledger (run_id TEXT PRIMARY KEY, event_id TEXT NOT NULL, units INTEGER NOT NULL, state TEXT NOT NULL, started_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS crew_scope_leases (id TEXT PRIMARY KEY, run_id TEXT NOT NULL UNIQUE, repo_key TEXT NOT NULL, branch TEXT NOT NULL,
 scopes TEXT NOT NULL, generation INTEGER NOT NULL, expires_at INTEGER NOT NULL, state TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS crew_findings (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, fingerprint TEXT NOT NULL, value TEXT NOT NULL,
 disposition TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(project_id,fingerprint));
CREATE TABLE IF NOT EXISTS crew_finding_occurrences (finding_id TEXT NOT NULL, event_id TEXT NOT NULL, run_id TEXT NOT NULL,
 head_commit TEXT NOT NULL, value TEXT, created_at INTEGER NOT NULL, PRIMARY KEY(finding_id,run_id));
CREATE TABLE IF NOT EXISTS crew_finding_history (id INTEGER PRIMARY KEY AUTOINCREMENT, finding_id TEXT NOT NULL, actor TEXT NOT NULL,
 disposition TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS crew_requests (id TEXT PRIMARY KEY, source_run_id TEXT NOT NULL, target_crew_id TEXT NOT NULL,
 event_id TEXT NOT NULL, request_id TEXT NOT NULL, reason TEXT NOT NULL, state TEXT NOT NULL, detail TEXT NOT NULL,
 created_at INTEGER NOT NULL, UNIQUE(source_run_id,request_id));
CREATE INDEX IF NOT EXISTS crew_checkins_pending ON crew_checkins(state,next_at);
CREATE TABLE IF NOT EXISTS crew_actions (id TEXT PRIMARY KEY, finding_id TEXT NOT NULL, event_id TEXT NOT NULL,
 kind TEXT NOT NULL, target_crew_id TEXT NOT NULL, run_id TEXT, state TEXT NOT NULL, reason TEXT NOT NULL,
 request_id TEXT NOT NULL UNIQUE, actor TEXT NOT NULL, head_commit TEXT NOT NULL, created_at INTEGER NOT NULL,
 evidence TEXT NOT NULL, automatic INTEGER NOT NULL DEFAULT 0, UNIQUE(finding_id,head_commit,kind));
CREATE INDEX IF NOT EXISTS crew_actions_run ON crew_actions(run_id);
`;
export type StoredCheckIn = {
 id: string; project_id: string; repo_key: string; branch: string; base_commit: string; head_commit: string;
 kind: string; source: string; delivery_id: string; created_at: number; updated_at: number; state: string;
 metadata: string | null; reason: string | null; next_at: number | null; job_id: string | null; attempts: number; allowance: number;
}
export function repositoryKey(url: string): string {
 const github = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(url);
 if (github) return 'github:' + github[1].toLowerCase() + '/' + github[2].toLowerCase();
 return url.replace(/\.git\/?$/, '').replace(/\/$/, '').toLowerCase();
}
export class CrewEvents {
 constructor(private sql: SqlStorage) {}
 get(id: string): StoredCheckIn { return this.sql.exec<StoredCheckIn>('SELECT * FROM crew_checkins WHERE id = ?', id).toArray()[0] ?? fail(404,'not_found','Check-in not found'); }
 accept(body: Record<string, unknown>, projects: (Project | RepoProject)[], now: number, source = 'manual'): Response {
  fields(body,['projectId','branch','baseCommit','headCommit','kind','deliveryId']);
  const projectId = string(body,'projectId',64), project = projects.find(p=>p.id===projectId) ?? fail(404,'not_found','Project not found');
  const branch = string(body,'branch',240), base = string(body,'baseCommit',40), head = string(body,'headCommit',40);
  if (!/^[a-f0-9]{40}$/.test(base) || !/^[a-f0-9]{40}$/.test(head) || /^0+$/.test(head) || /^0+$/.test(base)) fail(400,'invalid_field','Use exact, nonzero 40-hex base/head commits');
  if (/[^\x20-\x7e]|[~^:?*\[\\]|\.\.|@\{|\s/.test(branch) || branch.startsWith('-') || branch.endsWith('/') || branch.endsWith('.')) fail(400,'invalid_field','Invalid branch');
  const kind = string(body,'kind',32), delivery = string(body,'deliveryId',128);
  if (!['commit','push','pr_updated','pr_ready','test_failure','merge','release_candidate','manual'].includes(kind)) fail(400,'invalid_field','Unsupported event kind');
  const payload = JSON.stringify({projectId,branch,baseCommit:base,headCommit:head,kind});
  const previous = this.sql.exec<{event_id:string;payload:string}>('SELECT event_id,payload FROM crew_event_deliveries WHERE project_id=? AND source=? AND delivery_id=?',projectId,source,delivery).toArray()[0];
  if (previous) { if(previous.payload!==payload) fail(409,'delivery_conflict','This delivery ID already names a different check-in'); return json({eventId:previous.event_id,duplicate:true},200); }
  // Different delivery IDs for the same semantic event share its queue/budget.
  const same = this.sql.exec<{id:string}>(`SELECT id FROM crew_checkins WHERE project_id=? AND branch=? AND base_commit=? AND head_commit=? AND kind=? LIMIT 1`,projectId,branch,base,head,kind).toArray()[0];
  const id = same?.id ?? crypto.randomUUID();
  if (!same) {
   if (this.sql.exec<{n:number}>("SELECT COUNT(*) n FROM crew_checkins WHERE state IN ('pending','loading','ready','blocked','evaluated')").one().n>=1000) fail(429,'checkin_capacity','Check-in queue is full; resolve blocked events or retry after runs finish');
   if (this.sql.exec<{n:number}>("SELECT COUNT(*) n FROM crew_findings WHERE disposition NOT IN ('no_action','dismissed','resolved')").one().n>=5000) fail(429,'finding_capacity','Review unresolved findings before adding more check-ins');
   const ignored = branch.startsWith('smith/crew-');
   this.sql.exec(`INSERT INTO crew_checkins(id,project_id,repo_key,branch,base_commit,head_commit,kind,source,delivery_id,created_at,updated_at,state,next_at,reason)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,id,projectId,repositoryKey(project.repoUrl),branch,base,head,kind,source,delivery,now,now,ignored?'ignored':'pending',ignored?null:now,ignored?'Crew output does not trigger another swarm':null);
   this.sql.exec('INSERT INTO crew_event_members VALUES(?,?)',id,id);
  }
  this.sql.exec('INSERT INTO crew_event_deliveries VALUES(?,?,?,?,?)',id,projectId,source,delivery,payload);
  return json({eventId:id,duplicate:!!same},same?200:201);
 }
 // Only ordinary failed builds create events. Use the checkout reported by the worker,
 // and an already verified range for that commit when available. A first failed build
 // without a prior range is explicitly a zero-width review of the failed checkout.
 failedBuild(job:{id:string;kind:string;request_id:string;project_id:string;state:string;secretless:number;result?:string|null;specs?:string},projects:(Project|RepoProject)[],now:number):void {
  if(job.kind!=='build'||job.secretless||/^(ai-verify-|crew-)/.test(job.request_id)||!['failed','error'].includes(job.state))return;
  const project=projects.find(p=>p.id===job.project_id);if(!project||project.createdBy)return;
  const result=job.result?JSON.parse(job.result):{}, specs=job.specs?Object.values(JSON.parse(job.specs)) as {repos?:{url:string;branch:string;commit:string}[]}[]:[];
  const repo=specs.map(s=>s.repos?.[0]).find(r=>r&&repositoryKey(r.url)===repositoryKey(project.repoUrl));
  const head=result.commit||repo?.commit;if(typeof head!=='string'||!/^[a-f0-9]{40}$/.test(head)||/^0+$/.test(head))return;
  const branch=repo?.branch||project.branch;if(!branch)return;
  const earlier=this.sql.exec<{base_commit:string}>('SELECT base_commit FROM crew_checkins WHERE project_id=? AND repo_key=? AND branch=? AND head_commit=? ORDER BY created_at DESC LIMIT 1',project.id,repositoryKey(project.repoUrl),branch,head).toArray()[0];
  this.accept({projectId:project.id,branch,baseCommit:earlier?.base_commit??head,headCommit:head,kind:'test_failure',deliveryId:job.id},projects,now,'smith-build');
 }
 ready(id:string, metadata:CheckInMetadata, now:number):void {
  const event=this.get(id);
  if (!['pending','loading','blocked'].includes(event.state)) return;
  if (typeof metadata.complete!=='boolean'||typeof metadata.ancestor!=='boolean') fail(400,'invalid_metadata','Missing completeness flags');
  if (!Array.isArray(metadata.changes)||metadata.changes.length>20000) fail(400,'invalid_metadata','Invalid changed paths');
  for (const c of metadata.changes) {
   for (const p of [c.path,c.oldPath].filter(p=>p!==null)) if(typeof p!=='string'||!p||new TextEncoder().encode(p).length>512||/[\x00-\x1f\x7f\\]/.test(p)||p.includes(':')||p.startsWith('/')||p.split('/').some(x=>x==='..'||x==='.'||!x)) fail(400,'invalid_metadata','Unsafe changed path');
   for (const n of [c.added,c.deleted]) if(n!==null&&(!Number.isSafeInteger(n)||n<0)) fail(400,'invalid_metadata','Invalid diff count');
  }
  metadata={...metadata,testState:event.kind==='test_failure'&&event.source==='smith-build'?'failed':'unknown',...(event.kind==='test_failure'&&event.source==='smith-build'?{testSource:{kind:'smith-build' as const,jobId:event.delivery_id}}:{})};
  const good=metadata.complete&&metadata.ancestor;
  this.sql.exec('UPDATE crew_checkins SET state=?,metadata=?,reason=?,next_at=NULL,updated_at=? WHERE id=?',good?'ready':'blocked',JSON.stringify(metadata),good?null:metadata.reason??'Change metadata is incomplete or histories diverged',now,id);
  if (good && metadata.testSource?.kind === 'smith-build') {
   new CrewFindings(this.sql).ingest(`build:${metadata.testSource.jobId}`, id, event.project_id, event.head_commit, {
    summary: 'Failed Smith build', findings: [{ severity: 'high', category: 'test_failure', title: 'Failed Smith build',
     detail: `Smith build ${metadata.testSource.jobId} failed at ${event.head_commit}. Read its log with get_build/read_build_log, distinguish code failures from infrastructure or flaky tests, and never weaken tests to make them pass.` }],
   }, now);
  }
 }
 list(body:Record<string,unknown>):Response {
  fields(body,['before']); const before=body.before??Number.MAX_SAFE_INTEGER;
  if(!Number.isSafeInteger(before)||(before as number)<1) fail(400,'invalid_field','Invalid cursor');
  const events=this.sql.exec<StoredCheckIn & {cursor:number}>('SELECT rowid AS cursor,* FROM crew_checkins WHERE rowid<? ORDER BY rowid DESC LIMIT 50',before as number).toArray();
  return json({events:events.map(e=>({...e,metadata:undefined})),nextCursor:events.length===50?events.at(-1)!.cursor:null});
 }
 detail(body:Record<string,unknown>):Response {
  fields(body,['eventId']);const requestedId=string(body,'eventId',64);this.get(requestedId);
  const id=this.sql.exec<{root_id:string}>('SELECT root_id FROM crew_event_members WHERE event_id=?',requestedId).toArray()[0]?.root_id??requestedId,event=this.get(id);
  const runs=this.sql.exec('SELECT id,crew_id,state,wait_reason,session_id,started_at,cost_usd,snapshot FROM crew_runs WHERE event_id=? ORDER BY created_at,id',id).toArray().map(r=>({...r,snapshot:undefined}));
  const findings=this.sql.exec<{id:string;value:string;disposition:string}>(`SELECT f.id,o.value,f.disposition FROM crew_findings f
   JOIN crew_finding_occurrences o ON o.finding_id=f.id WHERE o.event_id=? AND o.head_commit=?
   AND o.rowid=(SELECT latest.rowid FROM crew_finding_occurrences latest WHERE latest.finding_id=f.id AND latest.event_id=o.event_id
    AND latest.head_commit=o.head_commit ORDER BY latest.created_at DESC,latest.rowid DESC LIMIT 1)`,id,event.head_commit).toArray().map(f=>({...f,value:JSON.parse(f.value)}));
  return json({requestedEventId:requestedId,event:{...event,metadata:event.metadata?JSON.parse(event.metadata):null},runs,findings,
   actions:this.sql.exec(`SELECT a.*,COALESCE(r.state,a.state) AS state,COALESCE(r.wait_reason,a.reason) AS reason,
    c.session_id,c.verify_job_id,j.state AS verification_state FROM crew_actions a LEFT JOIN crew_runs r ON r.id=a.run_id
    LEFT JOIN crew_reports c ON c.session_id=r.session_id LEFT JOIN jobs j ON j.id=c.verify_job_id WHERE a.event_id=? ORDER BY a.created_at,a.id`,id).toArray().map(a=>({...a,evidence:undefined})),
   decisions:this.sql.exec('SELECT * FROM crew_decisions WHERE event_id=?',id).toArray().map(d=>({...d,facts:JSON.parse(String(d.facts))})),
   requests:this.sql.exec('SELECT * FROM crew_requests WHERE event_id=? ORDER BY created_at,id',id).toArray(),
   budget:this.sql.exec('SELECT units,state,run_id FROM crew_unit_ledger WHERE event_id=?',id).toArray(),
   leases:this.sql.exec('SELECT l.* FROM crew_scope_leases l JOIN crew_runs r ON r.id=l.run_id WHERE r.event_id=?',id).toArray(),
   deliveries:this.sql.exec('SELECT source,delivery_id FROM crew_event_deliveries WHERE event_id IN (SELECT event_id FROM crew_event_members WHERE root_id=?)',id).toArray()});
 }
}
