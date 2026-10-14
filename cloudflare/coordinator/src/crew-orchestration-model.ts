import { fail, fields, object } from './http';
import { normalizeScope } from './crew-leases';
export const CHECK_IN_KINDS=['commit','push','pr_updated','pr_ready','test_failure','merge','release_candidate','manual'] as const;
export type CheckInKind=typeof CHECK_IN_KINDS[number];
export type Risk='low'|'normal'|'high';
export type CostClass='cheap'|'medium'|'expensive';
export type Priority='high'|'normal'|'low';
export interface MemberOrchestration {
 mode:'read_only'|'write'; events?:CheckInKind[]; branches?:string[]; paths?:string[]; languages?:string[]; modules?:string[];
 minChangedLines?:number; maxChangedLines?:number; minRisk?:Risk; dependencies?:string[]; previousFindingCategories?:string[];
 cooldownMs:number; debounceMs:number; maxDebounceWaitMs:number; maxJitterMs:number; priority:Priority; costClass:CostClass; unitCost:number; writeScopes:string[]; canRequest:string[];
}
export interface ProjectAutomation {
 mode:'report_only'|'suggest'|'automatic_fix'; fixerCrewId:string|null; testCrewId:string|null; maxFixAttempts:number;
 verification:{enabled:boolean;maxAttempts:number;timeoutMinutes:number};
}
export const DEFAULT_PROJECT_AUTOMATION:ProjectAutomation={mode:'report_only',fixerCrewId:null,testCrewId:null,maxFixAttempts:1,verification:{enabled:false,maxAttempts:1,timeoutMinutes:10}};
export interface ProjectOrchestrationRules { modules:Record<string,string[]>; riskRules:{paths:string[];risk:Risk}[]; automation?:ProjectAutomation }
export interface OrchestrationPolicy {
 enabled:boolean; concurrency:Record<CostClass,number>; eventBudgets:Record<Risk|'pr_ready'|'release_candidate',number>;
 globalStartsPerHour:number; maxDepth:number; maxRuns:number; projectRules?:Record<string,ProjectOrchestrationRules>;
}
export const DEFAULT_ORCHESTRATION_POLICY:OrchestrationPolicy={enabled:false,concurrency:{cheap:8,medium:3,expensive:1},eventBudgets:{low:3,normal:8,high:15,pr_ready:25,release_candidate:50},globalStartsPerHour:60,maxDepth:2,maxRuns:6,projectRules:{}};
export function projectAutomation(policy:OrchestrationPolicy,projectId:string):ProjectAutomation {
 const configured=policy.projectRules?.[projectId]?.automation;
 return {...DEFAULT_PROJECT_AUTOMATION,...configured,verification:{...DEFAULT_PROJECT_AUTOMATION.verification,...configured?.verification}};
}
function validateProjectAutomation(value:unknown):ProjectAutomation {
 const b=object(value);fields(b,['mode','fixerCrewId','testCrewId','maxFixAttempts','verification']);
 const result=projectAutomation(DEFAULT_ORCHESTRATION_POLICY,'');
 if('mode' in b)result.mode=enumeration(b.mode,['report_only','suggest','automatic_fix'] as const,'automation.mode');
 for(const key of ['fixerCrewId','testCrewId'] as const)if(key in b){
  const id=b[key];if(id!==null&&(typeof id!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(id)))fail(400,'invalid_field',`Invalid automation.${key}`);
  result[key]=id as string|null;
 }
 if('maxFixAttempts' in b)result.maxFixAttempts=numeric(b.maxFixAttempts,'automation.maxFixAttempts',1,5);
 if('verification' in b){
  const v=object(b.verification);fields(v,['enabled','maxAttempts','timeoutMinutes']);
  if('enabled' in v){if(typeof v.enabled!=='boolean')fail(400,'invalid_field','Invalid automation.verification.enabled');result.verification.enabled=v.enabled;}
  if('maxAttempts' in v)result.verification.maxAttempts=numeric(v.maxAttempts,'automation.verification.maxAttempts',1,5);
  if('timeoutMinutes' in v)result.verification.timeoutMinutes=numeric(v.timeoutMinutes,'automation.verification.timeoutMinutes',1,60);
 }
 return result;
}
function numeric(value:unknown,key:string,min=0,max=Number.MAX_SAFE_INTEGER):number {
 if(typeof value!=='number'||!Number.isSafeInteger(value)||value<min||value>max) fail(400,'invalid_field',`Invalid ${key}`);
 return value;
}
function enumeration<T extends string>(value:unknown,values:readonly T[],key:string):T {
 if(typeof value!=='string'||!values.includes(value as T)) fail(400,'invalid_field',`Invalid ${key}`);
 return value as T;
}
function strings(value:unknown,key:string):string[] {
 if(!Array.isArray(value)||value.length>100||value.some(v=>typeof v!=='string'||!v||new TextEncoder().encode(v).length>512||/[\x00-\x1f\x7f]/.test(v))||new Set(value).size!==value.length) fail(400,'invalid_field',`Invalid ${key}`);
 return [...value];
}
export function validateOrchestrationPolicy(value:unknown,current:OrchestrationPolicy=DEFAULT_ORCHESTRATION_POLICY):OrchestrationPolicy {
 const b=object(value); fields(b,Object.keys(DEFAULT_ORCHESTRATION_POLICY));
 const result:OrchestrationPolicy={...current,concurrency:{...current.concurrency},eventBudgets:{...current.eventBudgets}};
 if('enabled' in b) {if(typeof b.enabled!=='boolean') fail(400,'invalid_field','Invalid enabled'); result.enabled=b.enabled;}
 for(const key of ['concurrency','eventBudgets'] as const) if(key in b){ const nested=object(b[key]); fields(nested,Object.keys(result[key])); for(const name of Object.keys(nested)) (result[key] as Record<string,number>)[name]=numeric(nested[name],`${key}.${name}`,0,10000); }
 for(const key of ['globalStartsPerHour','maxDepth','maxRuns'] as const) if(key in b) result[key]=numeric(b[key],key, key==='maxDepth'?0:1,10000);
 if ('projectRules' in b) {
  const projects=object(b.projectRules); if(Object.keys(projects).length>100)fail(400,'invalid_field','Too many project rules');
  const rules:Record<string,ProjectOrchestrationRules>={};
  const globs=(v:unknown):string[]=>strings(v,'paths').map(p=>{if(p.startsWith('/')||p.includes('\\')||p.includes(':')||/[\[\]{}]/.test(p)||p.split('/').some(part=>!part||part==='.'||part==='..'))fail(400,'invalid_field','Invalid project rule path');return p;});
  for(const [id,value] of Object.entries(projects)) {
   if(!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id))fail(400,'invalid_field','Invalid project rule ID');
   const rule=object(value);fields(rule,['modules','riskRules','automation']);const modules:Record<string,string[]>={};
   for(const [name,paths] of Object.entries(rule.modules===undefined?{}:object(rule.modules))) {
    if(!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name)||Object.keys(modules).length>=100)fail(400,'invalid_field','Invalid module name');
    modules[name]=globs(paths);
   }
   const riskRules:ProjectOrchestrationRules['riskRules']=[];
   if('riskRules' in rule){if(!Array.isArray(rule.riskRules)||rule.riskRules.length>100)fail(400,'invalid_field','Invalid risk rules');
    for(const raw of rule.riskRules){const r=object(raw);fields(r,['paths','risk']);riskRules.push({paths:globs(r.paths),risk:enumeration(r.risk,['low','normal','high'] as const,'risk')});}}
   rules[id]={modules,riskRules};
   if('automation' in rule)rules[id].automation=validateProjectAutomation(rule.automation);
  }
  result.projectRules=rules;
 }
 return result;
}
export function validateMemberOrchestration(value:unknown,permissionMode:'plan'|'acceptEdits'):MemberOrchestration {
 const b=object(value); fields(b,['mode','events','branches','paths','languages','modules','minChangedLines','maxChangedLines','minRisk','dependencies','previousFindingCategories','cooldownMs','debounceMs','maxDebounceWaitMs','maxJitterMs','priority','costClass','unitCost','writeScopes','canRequest']);
 const mode=enumeration('mode' in b ? b.mode : 'read_only',['read_only','write'] as const,'mode');
 if((mode==='read_only')!==(permissionMode==='plan')) fail(400,'invalid_field','Orchestration mode contradicts permissionMode');
 const r:MemberOrchestration={mode,cooldownMs:0,debounceMs:0,maxDebounceWaitMs:300000,maxJitterMs:0,priority:'normal',costClass:'cheap',unitCost:1,writeScopes:[],canRequest:[]};
 for(const k of ['branches','paths','languages','modules','dependencies','previousFindingCategories','canRequest'] as const) if(k in b) r[k]=strings(b[k],k);
 if('events' in b) r.events=strings(b.events,'events').map(v=>enumeration(v,CHECK_IN_KINDS,'events'));
 for(const k of ['branches','paths','dependencies'] as const) for(const glob of r[k]??[]) if(glob.startsWith('/')||glob.includes('\\')||glob.includes(':')||glob.split('/').some(p=>p==='.'||p==='..')||/[\[\]{}]/.test(glob)) fail(400,'invalid_field',`Invalid ${k} glob`);
 for(const k of ['cooldownMs','debounceMs','maxDebounceWaitMs','maxJitterMs'] as const) if(k in b) r[k]=numeric(b[k],k,0,30*86400000);
 for(const k of ['minChangedLines','maxChangedLines'] as const) if(k in b) r[k]=numeric(b[k],k);
 if(r.minChangedLines!==undefined&&r.maxChangedLines!==undefined&&r.minChangedLines>r.maxChangedLines) fail(400,'invalid_field','minChangedLines exceeds maxChangedLines');
 if('priority'in b) r.priority=enumeration(b.priority,['high','normal','low'],'priority');
 if('costClass'in b) r.costClass=enumeration(b.costClass,['cheap','medium','expensive'],'costClass');
 if('minRisk'in b) r.minRisk=enumeration(b.minRisk,['low','normal','high'] as const,'minRisk');
 if('unitCost'in b) r.unitCost=numeric(b.unitCost,'unitCost',1,10000);
 if('writeScopes'in b){if(!Array.isArray(b.writeScopes)||b.writeScopes.length>32) fail(400,'invalid_field','Invalid writeScopes');r.writeScopes=[...new Set(b.writeScopes.map(v=>normalizeScope(v as string)))].sort();}
 if(mode==='write'&&!r.writeScopes.length) fail(400,'invalid_field','Writers require explicit writeScopes');
 if(mode==='read_only'&&r.writeScopes.length) fail(400,'invalid_field','Readers cannot declare write scopes');
 return r;
}
