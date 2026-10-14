import { CHECK_IN_KINDS, validateMemberOrchestration, type CostClass, type MemberOrchestration } from './crew-orchestration-model';
export interface OrchestrationTemplate { name:string; charter:string; permissionMode:'plan'; orchestration:MemberOrchestration }
function template(name:string,charter:string,unitCost:number,costClass:CostClass):OrchestrationTemplate {
 return {name,charter,permissionMode:'plan',orchestration:validateMemberOrchestration({events:[...CHECK_IN_KINDS],unitCost,costClass},'plan')};
}
// Seeds only. Never rewrite existing members or enable the workspace policy.
export const ORCHESTRATION_TEMPLATES:Record<string,OrchestrationTemplate>={
 'standards-reviewer':template('Standards reviewer','Review the pinned changes against repository conventions. Report concrete violations with evidence and affected files. Do not edit files.',1,'cheap'),
 'cleanup-reviewer':template('Cleanup reviewer','Review the pinned changes for dead code and needless duplication. Report bounded cleanup opportunities with evidence. Do not edit files.',1,'cheap'),
 'bug-hunter':template('Bug hunter','Review the pinned changes for concrete regressions in behavior. Report the triggering conditions, affected files, and evidence. Do not edit files.',2,'medium'),
 'test-reviewer':template('Test reviewer','Review the pinned changes for missing regression coverage and failure cases. Report precise test scenarios supported by the changed behavior. Do not edit files.',2,'medium'),
 'security-reviewer':template('Security reviewer','Review the pinned changes for security defects in sensitive code and dependencies. Report evidence, impact, and affected files. Request another reviewer only through an explicitly permitted typed request. Do not edit files.',4,'expensive'),
 'architecture-reviewer':template('Architecture reviewer','Review the pinned changes for module-boundary violations and significant structural risks. Report concrete impacts and affected modules. Do not edit files.',5,'expensive'),
};
