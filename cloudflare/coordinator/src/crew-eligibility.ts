import type { CheckInKind, MemberOrchestration, Risk } from './crew-orchestration-model';
export interface EligibilityFacts {
 kind:CheckInKind; branch:string; metadataState:'pending'|'complete'|'incomplete'|'blocked';
 paths?:string[]; languages?:string[]; modules?:string[]; dependencies?:string[]; previousFindingCategories?:string[]; changedLines?:number; risk?:Risk;
}
export interface EligibilityDecision { status:'eligible'|'deferred'|'skipped'; reason:string; matched:Record<string,unknown> }
// Only *, ? and ** are special; matching is anchored and case-sensitive.
export function matchRepoGlob(pattern:string,path:string):boolean {
 if(new TextEncoder().encode(pattern).length>512 || new TextEncoder().encode(path).length>512 || path.startsWith('/')||path.includes('\\')||path.includes(':')||/[\x00-\x1f\x7f]/.test(path)||path.split('/').some(p=>p==='..'||p==='.'||!p)) return false;
 if(pattern.startsWith('/')||pattern.includes('\\')||pattern.includes(':')||/[\[\]{}\x00-\x1f\x7f]/.test(pattern)||pattern.split('/').some(p=>p==='..'||p==='.'||!p))return false;
 // Memoized wildcard matching bounds work by pattern length times path length;
 // repeated stars cannot cause regex backtracking on untrusted repository names.
 const memo=new Map<string,boolean>();
 const match=(p:number,s:number):boolean=>{
  const key=p+':'+s;const cached=memo.get(key);if(cached!==undefined)return cached;
  let result=false;
  if(p===pattern.length)result=s===path.length;
  else if(pattern[p]==='*') {
   if(pattern[p+1]==='*') {
    if(pattern[p+2]==='/') {
     result=match(p+3,s);
     for(let i=s;!result&&i<path.length;i++)if(path[i]==='/')result=match(p+3,i+1);
    } else result=match(p+2,s)||(s<path.length&&match(p,s+1));
   } else result=match(p+1,s)||(s<path.length&&path[s]!=='/'&&match(p,s+1));
  } else if(s<path.length)result=(pattern[p]==='?'?path[s]!=='/':pattern[p]===path[s])&&match(p+1,s+1);
  memo.set(key,result);return result;
 };
 return match(0,0);
}
export function evaluateEligibility(config:MemberOrchestration,facts:EligibilityFacts):EligibilityDecision {
 const matched:Record<string,unknown>={};
 const decision=(status:EligibilityDecision['status'],reason:string):EligibilityDecision=>({status,reason,matched});
 if(config.events&&!config.events.includes(facts.kind)) return decision('skipped','event_mismatch');
 if(config.branches&&!config.branches.some(g=>matchRepoGlob(g,facts.branch))) return decision('skipped','branch_mismatch');
 const metadataRequired=config.mode==='write'||['paths','languages','modules','dependencies','minChangedLines','maxChangedLines','minRisk'].some(k=>config[k as keyof MemberOrchestration]!==undefined);
 if(metadataRequired&&facts.metadataState!=='complete') return decision('deferred','metadata_incomplete');
 for(const k of ['paths','languages','modules','dependencies','previousFindingCategories'] as const) {
  const filters=config[k]; if(!filters)continue;
  const values=facts[k];if(values===undefined)return decision('deferred',`${k}_unknown`);
  const hits=values.filter(v=>filters.some(f=>(k==='paths'||k==='dependencies')?matchRepoGlob(f,v):f===v));
  if(!hits.length)return decision('skipped',`${k}_mismatch`); matched[k]=hits;
 }
 if(config.minChangedLines!==undefined||config.maxChangedLines!==undefined) {
  if(facts.changedLines===undefined)return decision('deferred','changed_lines_unknown');
  if(facts.changedLines<(config.minChangedLines??0)||facts.changedLines>(config.maxChangedLines??Infinity))return decision('skipped','changed_lines_mismatch');
  matched.changedLines=facts.changedLines;
 }
 if(config.minRisk!==undefined){if(facts.risk===undefined)return decision('deferred','risk_unknown');if(['low','normal','high'].indexOf(facts.risk)<['low','normal','high'].indexOf(config.minRisk))return decision('skipped','risk_mismatch');matched.risk=facts.risk;}
 return decision('eligible','filters_matched');
}
