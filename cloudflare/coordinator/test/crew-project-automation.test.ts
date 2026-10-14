import { describe, expect, it } from 'vitest';
import { DEFAULT_ORCHESTRATION_POLICY, DEFAULT_PROJECT_AUTOMATION, projectAutomation, validateOrchestrationPolicy } from '../src/crew-orchestration-model';
import { CREW_TEMPLATES, validateCrewMember } from '../src/crew-model';

const policy = (automation: unknown) => validateOrchestrationPolicy({ projectRules: { app: { automation } } });

describe('project automation policy', () => {
  it('preserves old project rules without opting them into automation', () => {
    const old = validateOrchestrationPolicy({ projectRules: { app: { modules: { api: ['src/**'] }, riskRules: [] } } });
    expect(old.projectRules?.app).toEqual({ modules: { api: ['src/**'] }, riskRules: [] });
    expect(projectAutomation(old, 'app')).toEqual(DEFAULT_PROJECT_AUTOMATION);
    expect(projectAutomation(DEFAULT_ORCHESTRATION_POLICY, 'missing')).toEqual(DEFAULT_PROJECT_AUTOMATION);
  });
  it('fills partial configuration and returns independently mutable defaults', () => {
    const configured = policy({ mode: 'suggest', fixerCrewId: 'fixer-1', verification: { enabled: true } });
    expect(projectAutomation(configured, 'app')).toEqual({ ...DEFAULT_PROJECT_AUTOMATION, mode: 'suggest', fixerCrewId: 'fixer-1', verification: { enabled: true, maxAttempts: 1, timeoutMinutes: 10 } });
    projectAutomation(configured, 'app').verification.timeoutMinutes = 60;
    expect(projectAutomation(configured, 'app').verification.timeoutMinutes).toBe(10);
    expect(DEFAULT_PROJECT_AUTOMATION.verification.timeoutMinutes).toBe(10);
  });
  it('accepts explicit opt-in, null targets and upper bounds', () => {
    const input = { mode: 'automatic_fix', fixerCrewId: null, testCrewId: 'a'.repeat(64), maxFixAttempts: 5, verification: { enabled: true, maxAttempts: 5, timeoutMinutes: 60 } };
    expect(projectAutomation(policy(input), 'app')).toEqual(input);
  });
  it.each([
    null, [], { mode: 'write' }, { fixerCrewId: '' }, { fixerCrewId: 'a'.repeat(65) },
    { testCrewId: '../crew' }, { testCrewId: 123 }, { maxFixAttempts: 0 }, { maxFixAttempts: 6 },
    { maxFixAttempts: 1.5 }, { unknown: true }, { verification: null },
    { verification: { enabled: 'true' } }, { verification: { maxAttempts: 0 } },
    { verification: { maxAttempts: 6 } }, { verification: { timeoutMinutes: 0 } },
    { verification: { timeoutMinutes: 61 } }, { verification: { timeoutMinutes: 2.5 } },
    { verification: { shell: true } },
  ])('rejects invalid automation %j', input => {
    expect(() => policy(input)).toThrow();
  });
});

describe('read-only maintenance presets', () => {
  it.each(['failure-triage', 'dependency-maintenance'] as const)('seeds %s as a read-only member', key => {
    const member = validateCrewMember({ template: key, projectIds: ['app'] }, undefined, 'user', 1);
    expect(member.charter).toEqual(CREW_TEMPLATES[key].charter);
    expect(member.permissionMode).toBe('plan');
    expect(member.charter).toContain('Do not edit files');
    expect(member.trigger).toEqual(key === 'failure-triage' ? { kind: 'buildFinished', on: 'failed' } : { kind: 'branchChanged', branch: '', checkMinutes: 5 });
  });
});
