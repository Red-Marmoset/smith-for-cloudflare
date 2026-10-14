import { beforeAll, describe, it, expect } from 'vitest';
import { env } from 'cloudflare:workers';
import identity from '../migrations/0001_identity.sql?raw';
import { crewSetup } from './crew-fixture';
import { CrewFindings } from '../src/crew-findings';
import { validateCrewReport } from '../src/crew-model';
beforeAll(async()=>{await env.DB.exec(identity);});
const report={summary:'Review',findings:[{severity:'high',title:' Missing authorization ',detail:'Require an access check',file:'src/a.ts',files:['src/b.ts','src/a.ts'],category:'security',confidence:0.9,blocking:true}]};
describe('normalized crew findings',()=>{
 it('accepts additive report fields and preserves legacy absence',()=>{
  expect(validateCrewReport(report).findings[0]).toMatchObject({confidence:0.9,category:'security',files:['src/b.ts','src/a.ts'],blocking:true});
  expect(validateCrewReport({summary:'x',findings:[{severity:'low',title:'x',detail:'x'}]}).findings[0]).not.toHaveProperty('confidence');
 });
 it.each([{confidence:1.01},{confidence:-1},{confidence:'1'},{category:''},{files:['../a']},{files:['/a']},{files:['C:/a']},{files:['src\\a']},{blocking:'true'}])('rejects malformed evidence %j',extra=>expect(()=>validateCrewReport({summary:'x',findings:[{...report.findings[0],...extra}]})).toThrow());
 it('deduplicates repeated finishes while preserving disposition and occurrence evidence',async()=>{
  const f=await crewSetup();
  await f.sql(sql=>{
   const findings=new CrewFindings(sql);
   findings.ingest('r1','e1','smith','a'.repeat(40),validateCrewReport(report),1);
   findings.ingest('r1','e1','smith','a'.repeat(40),validateCrewReport(report),2);
   const first=sql.exec<{id:string;disposition:string}>('SELECT id,disposition FROM crew_findings').one();
   expect(first.disposition).toBe('human_review');
   expect(findings.decide('operator',{findingId:first.id,disposition:'dismissed'},3).status).toBe(200);
   const next=validateCrewReport({...report,findings:[{...report.findings[0],title:'missing   authorization',files:['src/a.ts','src/b.ts'],detail:'New commit evidence'}]});
   findings.ingest('r2','e2','smith','b'.repeat(40),next,4);
   expect(sql.exec('SELECT * FROM crew_findings').toArray()).toHaveLength(1);
   expect(sql.exec<{disposition:string}>('SELECT disposition FROM crew_findings').one().disposition).toBe('dismissed');
   const occurrences=sql.exec<{value:string}>('SELECT value FROM crew_finding_occurrences ORDER BY created_at').toArray();
   expect(occurrences).toHaveLength(2);
   expect(JSON.parse(occurrences[0].value).detail).toBe('Require an access check');
   expect(JSON.parse(occurrences[1].value).detail).toBe('New commit evidence');
   expect(sql.exec('SELECT * FROM crew_finding_history').toArray()).toHaveLength(1);
   findings.ingest('r2','e2','smith','b'.repeat(40),validateCrewReport({...report,findings:[{...report.findings[0],confidence:0.8}]}),5);
   expect(JSON.parse(sql.exec<{value:string}>("SELECT value FROM crew_finding_occurrences WHERE run_id='r2'").one().value).confidence).toBe(0.8);
  });
 });
 it('keeps projects distinct and does not invent confidence or erase findings on clean reports',async()=>{
  const f=await crewSetup();await f.sql(sql=>{
   const findings=new CrewFindings(sql),legacy=validateCrewReport({summary:'x',findings:[{severity:'low',title:'x',detail:'x'}]});
   findings.ingest('r1','e1','one','a'.repeat(40),legacy,1);findings.ingest('r2','e2','two','b'.repeat(40),legacy,2);
   findings.ingest('r3','e3','one','c'.repeat(40),{summary:'clean',findings:[]},3);
   const rows=sql.exec<{value:string;disposition:string}>('SELECT value,disposition FROM crew_findings').toArray();expect(rows).toHaveLength(2);
   expect(JSON.parse(rows[0].value).confidence).toBeNull();expect(rows[0].disposition).toBe('no_action');
   expect(()=>findings.decide('op',{findingId:'missing',disposition:'resolved'},4)).toThrow();
   expect(()=>findings.decide('op',{findingId:'missing',disposition:'publish'},4)).toThrow();
  });
 });
});
