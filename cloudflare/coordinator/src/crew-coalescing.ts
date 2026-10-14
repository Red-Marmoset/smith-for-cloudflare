import { CrewEvents, type StoredCheckIn } from './crew-events';
import type { CheckInMetadata } from './checkin-metadata';
import type { EventSnapshot } from './crew-orchestration';
import { computeDue, stableJitter } from './crew-scheduling';
const ACTIVE="('waiting','queued','running','pushing')";
// All mutations run inside the caller's workspace transaction.
export function coalesceCheckIn(sql:SqlStorage,event:StoredCheckIn,now:number):StoredCheckIn {
 if(event.state!=='ready'||!event.metadata)return event;
 const incoming:CheckInMetadata=JSON.parse(event.metadata);
 if(incoming.complete!==true||incoming.ancestor!==true)return event;
 if(sql.exec('SELECT 1 FROM crew_runs WHERE event_id=? LIMIT 1',event.id).toArray().length
  ||sql.exec('SELECT 1 FROM crew_finding_occurrences WHERE event_id=? LIMIT 1',event.id).toArray().length)return event;
 const roots=sql.exec<StoredCheckIn>(`SELECT e.* FROM crew_checkins e WHERE e.id!=? AND e.project_id=? AND e.repo_key=? AND e.branch=? AND e.kind=? AND e.head_commit=? AND e.state='evaluated'
 AND NOT EXISTS(SELECT 1 FROM crew_runs r WHERE r.event_id=e.id AND r.state!='waiting')
 AND NOT EXISTS(SELECT 1 FROM crew_unit_ledger l WHERE l.event_id=e.id)
 AND NOT EXISTS(SELECT 1 FROM crew_finding_occurrences o WHERE o.event_id=e.id)
 AND NOT EXISTS(SELECT 1 FROM crew_actions a WHERE a.event_id=e.id)
 AND NOT EXISTS(SELECT 1 FROM crew_requests q WHERE q.event_id=e.id AND q.state='accepted') ORDER BY e.created_at,e.id`,event.id,event.project_id,event.repo_key,event.branch,event.kind,event.base_commit).toArray();
 for(const root of roots) {
  if(!root.metadata)continue;
  const previous:CheckInMetadata=JSON.parse(root.metadata);
  if(previous.complete!==true||previous.ancestor!==true)continue;
  const changes=[...previous.changes,...incoming.changes];
  if(changes.length>20000)continue;
  const merged:CheckInMetadata={...incoming,changes};
  // Counts are conservative cumulative churn over the covered commits. Both sides
  // of every rename remain available for path eligibility and audit.
  const encoded=JSON.stringify(merged);if(new TextEncoder().encode(encoded).length>10*1024*1024)continue;
  sql.exec('UPDATE crew_checkins SET head_commit=?,metadata=?,allowance=MAX(allowance,?),updated_at=? WHERE id=?',event.head_commit,encoded,event.allowance,now,root.id);
  sql.exec('INSERT OR IGNORE INTO crew_event_members(root_id,event_id) SELECT ?,event_id FROM crew_event_members WHERE root_id=?',root.id,event.id);
  sql.exec('INSERT OR IGNORE INTO crew_event_members VALUES(?,?)',root.id,event.id);
  sql.exec('DELETE FROM crew_event_members WHERE root_id=?',event.id);
  sql.exec("UPDATE crew_checkins SET state='coalesced',next_at=NULL,updated_at=? WHERE id=?",now,event.id);
  const aggregate=new CrewEvents(sql).get(root.id);
  for(const run of sql.exec<{id:string;crew_id:string;snapshot:string}>('SELECT id,crew_id,snapshot FROM crew_runs WHERE event_id=?',root.id).toArray()){
   const snapshot:EventSnapshot=JSON.parse(run.snapshot);snapshot.event=aggregate;
   const last=sql.exec<{at:number|null}>('SELECT MAX(started_at) at FROM crew_runs WHERE crew_id=?',run.crew_id).one().at;
   const due=computeDue({firstReceived:root.created_at,lastReceived:event.created_at,lastStarted:last,...snapshot.config,jitterMs:stableJitter(root.id+run.crew_id,snapshot.config.maxJitterMs)});
   sql.exec('UPDATE crew_runs SET snapshot=?,due_at=?,next_check_at=?,updated_at=? WHERE id=? AND state=\'waiting\'',JSON.stringify(snapshot),due,due,now,run.id);
  }
  // Candidates which had no run can now match newly covered paths. Existing queued
  // members keep their original configuration and permissions snapshot.
  sql.exec('DELETE FROM crew_decisions WHERE event_id=? AND run_id IS NULL',root.id);
  return aggregate;
 }
 return event;
}
export function retainCheckIns(sql:SqlStorage,now:number):{deletedEvents:number;deletedAggregates:number} {
 sql.exec(`UPDATE crew_checkins SET state='completed' WHERE state='evaluated' AND NOT EXISTS(SELECT 1 FROM crew_runs r WHERE r.event_id=crew_checkins.id AND r.state IN ${ACTIVE})`);
 const roots=sql.exec<StoredCheckIn>("SELECT * FROM crew_checkins WHERE state IN ('completed','ignored') ORDER BY updated_at DESC,id DESC").toArray();
 let deletedEvents=0,deletedAggregates=0;
 for(let index=0;index<roots.length;index++) {
  const root=roots[index];if(index<1000&&root.updated_at>=now-30*86400000)continue;
  const ids=sql.exec<{event_id:string}>('SELECT event_id FROM crew_event_members WHERE root_id=?',root.id).toArray().map(r=>r.event_id);
  if(!ids.includes(root.id))ids.push(root.id);
  let protectedReference=false;
  for(const id of ids) {
   if(sql.exec(`SELECT 1 FROM crew_runs WHERE event_id=? AND state IN ${ACTIVE} LIMIT 1`,id).toArray().length
    ||sql.exec("SELECT 1 FROM crew_scope_leases l JOIN crew_runs r ON r.id=l.run_id WHERE r.event_id=? AND l.state!='released' LIMIT 1",id).toArray().length
    ||sql.exec("SELECT 1 FROM crew_finding_occurrences o JOIN crew_findings f ON f.id=o.finding_id WHERE o.event_id=? AND f.disposition NOT IN ('resolved','dismissed','no_action') LIMIT 1",id).toArray().length
    ||sql.exec("SELECT 1 FROM crew_reports p JOIN crew_runs r ON r.session_id=p.session_id WHERE r.event_id=? AND p.status IN ('pending','pushing','verifying') LIMIT 1",id).toArray().length) {protectedReference=true;break;}
  }
  if(protectedReference)continue;
  for(const id of ids) {
   sql.exec('DELETE FROM crew_scope_leases WHERE run_id IN (SELECT id FROM crew_runs WHERE event_id=?)',id);
   sql.exec('DELETE FROM crew_finding_occurrences WHERE event_id=?',id);
   sql.exec('DELETE FROM crew_requests WHERE event_id=?',id);
   sql.exec('DELETE FROM crew_actions WHERE event_id=?',id);
   sql.exec('DELETE FROM crew_unit_ledger WHERE event_id=?',id);
   sql.exec('DELETE FROM crew_decisions WHERE event_id=?',id);
   sql.exec('DELETE FROM crew_event_deliveries WHERE event_id=?',id);
   // Existing run/session history stays readable after event audit retention expires.
   sql.exec('UPDATE crew_runs SET event_id=NULL,snapshot=NULL WHERE event_id=?',id);
   sql.exec('DELETE FROM crew_event_members WHERE event_id=? OR root_id=?',id,id);
   sql.exec('DELETE FROM crew_checkins WHERE id=?',id);deletedEvents++;
  }
  deletedAggregates++;
 }
 // Never remove a finding still referenced by any retained event.
 sql.exec("DELETE FROM crew_finding_history WHERE finding_id IN (SELECT f.id FROM crew_findings f WHERE f.disposition IN ('resolved','dismissed','no_action') AND NOT EXISTS(SELECT 1 FROM crew_finding_occurrences o WHERE o.finding_id=f.id))");
 sql.exec("DELETE FROM crew_findings WHERE disposition IN ('resolved','dismissed','no_action') AND NOT EXISTS(SELECT 1 FROM crew_finding_occurrences o WHERE o.finding_id=crew_findings.id)");
 return {deletedEvents,deletedAggregates};
}
