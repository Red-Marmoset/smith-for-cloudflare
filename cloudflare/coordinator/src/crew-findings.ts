import { fail, fields, json, string } from './http';
import { validateCrewReport, type CrewReport } from './crew-model';
export const FINDING_DISPOSITIONS=['no_action','second_review','fixer_requested','merge_blocking','human_review','resolved','dismissed'] as const;
export type FindingDisposition=typeof FINDING_DISPOSITIONS[number];
function normalize(finding:CrewReport['findings'][number]) {
 const files=[...new Set([...(finding.files??[]),...(finding.file?[finding.file]:[])])].sort();
 return {...finding,files,category:finding.category??'uncategorized',confidence:finding.confidence??null,blocking:finding.blocking??false};
}
// The canonical tuple itself is collision-free; no lossy short hash is needed.
export function findingFingerprint(finding:CrewReport['findings'][number]):string {
 const value=normalize(finding);
 return JSON.stringify([value.category,value.files,value.title.trim().replace(/\s+/g,' ').toLowerCase()]);
}
export class CrewFindings {
 constructor(private sql:SqlStorage) {}
 // Caller supplies authenticated run identity and wraps mutations in the workspace transaction.
 ingest(runId:string,eventId:string,projectId:string,headCommit:string,report:CrewReport,now:number):void {
  const checked=validateCrewReport(report);
  for(const raw of checked.findings) {
   const value=normalize(raw),fingerprint=findingFingerprint(raw);
   const existing=this.sql.exec<{id:string}>('SELECT id FROM crew_findings WHERE project_id=? AND fingerprint=?',projectId,fingerprint).toArray()[0];
   const id=existing?.id??crypto.randomUUID();
   const encoded=JSON.stringify(value);
   const occurrence=this.sql.exec<{value:string}>('SELECT value FROM crew_finding_occurrences WHERE finding_id=? AND run_id=?',id,runId).toArray()[0];
   if(occurrence?.value===encoded)continue;
   if(existing)this.sql.exec('UPDATE crew_findings SET value=?,updated_at=? WHERE id=?',encoded,now,id);
   else this.sql.exec('INSERT INTO crew_findings(id,project_id,fingerprint,value,disposition,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',id,projectId,fingerprint,encoded,value.severity==='high'||value.blocking?'human_review':'no_action',now,now);
   this.sql.exec('INSERT INTO crew_finding_occurrences(finding_id,event_id,run_id,head_commit,created_at,value) VALUES(?,?,?,?,?,?) ON CONFLICT(finding_id,run_id) DO UPDATE SET value=excluded.value',id,eventId,runId,headCommit,now,encoded);
  }
 }
 // Authorization is enforced by the workspace action before this audit mutation.
 decide(actor:string,body:Record<string,unknown>,now:number):Response {
  fields(body,['findingId','disposition']);
  const id=string(body,'findingId',64),disposition=string(body,'disposition',32);
  if(!FINDING_DISPOSITIONS.includes(disposition as FindingDisposition))fail(400,'invalid_field','Invalid finding disposition');
  const previous=this.sql.exec<{disposition:string}>('SELECT disposition FROM crew_findings WHERE id=?',id).toArray()[0]??fail(404,'not_found','Finding not found');
  if(previous.disposition!==disposition){
   this.sql.exec('UPDATE crew_findings SET disposition=?,updated_at=? WHERE id=?',disposition,now,id);
   this.sql.exec('INSERT INTO crew_finding_history(finding_id,actor,disposition,created_at) VALUES(?,?,?,?)',id,actor,disposition,now);
  }
  return json({findingId:id,disposition});
 }
}
