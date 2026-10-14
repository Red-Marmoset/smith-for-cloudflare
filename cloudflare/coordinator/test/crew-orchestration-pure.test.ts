import { describe, it, expect } from 'vitest';
import { validateMemberOrchestration, validateOrchestrationPolicy } from '../src/crew-orchestration-model';
import { evaluateEligibility, matchRepoGlob } from '../src/crew-eligibility';
import { computeDue, stableJitter, compareCandidates } from '../src/crew-scheduling';
import { normalizeScope, scopesOverlap } from '../src/crew-leases';
describe('orchestration pure policy', () => {
 it('defaults safely and rejects contradictory privileges and unknown fields', () => {
  expect(validateMemberOrchestration({}, 'plan').mode).toBe('read_only');
  expect(validateOrchestrationPolicy({}).enabled).toBe(false);
  expect(() => validateMemberOrchestration({}, 'acceptEdits')).toThrow();
  expect(() => validateMemberOrchestration({mode:'write'}, 'acceptEdits')).toThrow();
  expect(() => validateMemberOrchestration({events:['bad']}, 'plan')).toThrow();
  expect(() => validateOrchestrationPolicy({surprise:true})).toThrow();
  expect(() => validateOrchestrationPolicy({eventBudgets:{low:-1}})).toThrow();
 });
 it('retains nested policy settings and rejects invalid bounds', () => {
  const current=validateOrchestrationPolicy({enabled:true,concurrency:{cheap:2}});
  expect(validateOrchestrationPolicy({concurrency:{medium:1}},current).concurrency).toEqual({cheap:2,medium:1,expensive:1});
  expect(() => validateMemberOrchestration({minChangedLines:20,maxChangedLines:2},'plan')).toThrow();
  expect(() => validateMemberOrchestration({paths:['../*']},'plan')).toThrow();
 });
 it('matches repository globs with case and slash semantics', () => {
  expect(matchRepoGlob('**/*.ts','a.ts')).toBe(true);
  expect(matchRepoGlob('a'.repeat(513),'a'.repeat(513))).toBe(false);
  expect(matchRepoGlob('**/**/a?.ts','a1.ts')).toBe(true);
  expect(matchRepoGlob('src/**/a?.ts','src/deep/a1.ts')).toBe(true);
  expect(matchRepoGlob('src/*.ts','src/deep/a.ts')).toBe(false);
  expect(matchRepoGlob('src/*.ts','Src/a.ts')).toBe(false);
  expect(matchRepoGlob('**/*.ts','../a.ts')).toBe(false);
 });
 it('ANDs dimensions, ORs filters, defers unknowns and prevents incomplete writers', () => {
  const config=validateMemberOrchestration({paths:['old/**','src/**'],languages:['typescript']},'plan');
  const facts={kind:'push' as const,branch:'main',metadataState:'complete' as const,paths:['old/a.ts'],languages:['typescript']};
  expect(evaluateEligibility(config,facts).status).toBe('eligible');
  expect(evaluateEligibility(config,{...facts,languages:['cpp']}).status).toBe('skipped');
  expect(evaluateEligibility(config,{...facts,languages:undefined}).status).toBe('deferred');
  expect(evaluateEligibility(config,{...facts,metadataState:'incomplete'}).status).toBe('deferred');
  const writer=validateMemberOrchestration({mode:'write',writeScopes:['src/']},'acceptEdits');
  expect(evaluateEligibility(writer,{...facts,metadataState:'pending'}).status).toBe('deferred');
 });
 it('caps debounce, honors cooldown and orders ties deterministically', () => {
  expect(computeDue({firstReceived:0,lastReceived:900,lastStarted:800,cooldownMs:500,debounceMs:500,maxDebounceWaitMs:1000,jitterMs:7})).toBe(1307);
  expect(stableJitter('event/member',100)).toBe(stableJitter('event/member',100));
  expect(stableJitter('key',0)).toBe(0);
  expect(stableJitter('key',100)).toBeLessThanOrEqual(100);
  expect(compareCandidates({priority:'normal',dueAt:10,sequence:1},{priority:'normal',dueAt:10,sequence:2},100)).toBeLessThan(0);
 });
 it('normalizes literal leases and treats parents/case variants conservatively', () => {
  expect(normalizeScope('Modules/SmithAgent')).toBe('Modules/SmithAgent/');
  expect(scopesOverlap('Modules/','modules/SmithAgent/')).toBe(true);
  expect(scopesOverlap('src/','src2/')).toBe(false);
  expect(scopesOverlap('', 'anything/')).toBe(true);
  for(const path of ['../src','/src','C:/src','src/**','src\\x','.git/','src/../lib']) expect(()=>normalizeScope(path)).toThrow();
 });
});


import { ORCHESTRATION_TEMPLATES } from '../src/crew-orchestration-templates';
import { rankCandidate } from '../src/crew-scheduling';
describe('orchestration policy edge cases',()=>{
 it('ships six explicit read-only templates with bounded costs',()=>{
  expect(Object.keys(ORCHESTRATION_TEMPLATES)).toHaveLength(6);
  for(const template of Object.values(ORCHESTRATION_TEMPLATES)){
   expect(template.permissionMode).toBe('plan');
   expect(template.orchestration.mode).toBe('read_only');
   expect(template.orchestration.writeScopes).toEqual([]);
   expect(template.orchestration.canRequest).toEqual([]);
   expect(validateMemberOrchestration(template.orchestration,'plan')).toEqual(template.orchestration);
  }
  expect(ORCHESTRATION_TEMPLATES['security-reviewer'].orchestration.unitCost).toBe(4);
 });
 it.each([
  [{mode:null},'plan'],[{unitCost:0},'plan'],[{cooldownMs:-1},'plan'],[{debounceMs:0.1},'plan'],[{maxJitterMs:Infinity},'plan'],[{events:['push','push']},'plan'],[{priority:'urgent'},'plan'],[{costClass:'free'},'plan'],[{writeScopes:['src/']},'plan'],[{mode:'write',writeScopes:['../']},'acceptEdits'],
 ] as const)('refuses invalid member configuration %j',(value,mode)=>expect(()=>validateMemberOrchestration(value,mode)).toThrow());
 it.each([{enabled:1},{globalStartsPerHour:0},{maxDepth:-1},{maxRuns:1.5},{concurrency:{cheap:-1}},{concurrency:{unknown:1}}])('refuses invalid workspace policy %j',value=>expect(()=>validateOrchestrationPolicy(value)).toThrow());
 it.each(['../**','/src/**','C:/src/*','src\\*','src/{a,b}','src/[a]','src//a'])('refuses malformed glob %s',pattern=>expect(matchRepoGlob(pattern,'src/a')).toBe(false));
 it('leaves unfiltered readers eligible with pending metadata, and filters renamed old paths',()=>{
  const base={kind:'push' as const,branch:'main',metadataState:'pending' as const};
  expect(evaluateEligibility(validateMemberOrchestration({},'plan'),base).status).toBe('eligible');
  expect(evaluateEligibility(validateMemberOrchestration({paths:['legacy/**']},'plan'),{...base,metadataState:'complete',paths:['legacy/old.ts','src/new.ts']}).status).toBe('eligible');
  expect(evaluateEligibility(validateMemberOrchestration({maxChangedLines:20},'plan'),{...base,metadataState:'complete'}).reason).toBe('changed_lines_unknown');
 });
 it('combines module, dependency, risk and previous-finding dimensions',()=>{
  const config=validateMemberOrchestration({events:['push'],branches:['release/*'],modules:['core'],dependencies:['**/package.json'],minRisk:'normal',previousFindingCategories:['security'],minChangedLines:1,maxChangedLines:10},'plan');
  const facts={kind:'push' as const,branch:'release/v1',metadataState:'complete' as const,modules:['core'],dependencies:['package.json'],risk:'high' as const,previousFindingCategories:['security'],changedLines:5};
  expect(evaluateEligibility(config,facts).status).toBe('eligible');
  expect(evaluateEligibility(config,{...facts,risk:'low'}).reason).toBe('risk_mismatch');
  expect(evaluateEligibility(config,{...facts,kind:'manual'}).reason).toBe('event_mismatch');
  expect(evaluateEligibility(config,{...facts,branch:'main'}).reason).toBe('branch_mismatch');
  expect(evaluateEligibility(config,{...facts,previousFindingCategories:undefined}).status).toBe('deferred');
  expect(evaluateEligibility(config,{...facts,changedLines:11}).status).toBe('skipped');
 });
 it('caps debounce independently, never invents a cooldown before a first run, and caps age bonus',()=>{
  expect(computeDue({firstReceived:100,lastReceived:1000,lastStarted:null,debounceMs:500,maxDebounceWaitMs:1000,cooldownMs:5000,jitterMs:3})).toBe(1103);
  expect(rankCandidate({priority:'low',dueAt:0,sequence:0},999999999)).toBe(100);
  expect(rankCandidate({priority:'normal',dueAt:100,sequence:0},0)).toBe(50);
  expect(compareCandidates({priority:'high',dueAt:20,sequence:9},{priority:'normal',dueAt:10,sequence:1},100)).toBeLessThan(0);
  expect(compareCandidates({priority:'normal',dueAt:20,sequence:1},{priority:'normal',dueAt:10,sequence:9},100)).toBeGreaterThan(0);
 });
});


it('bounds write scopes to native limits and rejects control and device paths',()=>{
 for(const scope of ['src/(x)/','src/"x/','.claude/','CLAUDE.md/','x/AGENTS.md/','CON/','x/lpt9.txt/','a'.repeat(508)])expect(()=>normalizeScope(scope)).toThrow();
 expect(()=>validateMemberOrchestration({mode:'write',writeScopes:Array.from({length:33},(_,i)=>'scope'+i+'/')},'acceptEdits')).toThrow();
 expect(validateMemberOrchestration({mode:'write',writeScopes:['Modules/SmithAgent/']},'acceptEdits').writeScopes).toEqual(['Modules/SmithAgent/']);
});
