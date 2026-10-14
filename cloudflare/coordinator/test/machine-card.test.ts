import { describe, expect, it } from 'vitest';
// @ts-expect-error the dashboard's machine module is plain browser JavaScript without declarations
import { machineSummary } from '../public/machines.js';

const date = () => '3 Oct, 14:02';
const machine = (extra: Record<string, unknown> = {}) => ({ os: 'windows', purpose: 'build', ownedByYou: true, active: true, draining: false, activeJobId: null,
  lastSeenAt: 0, agentVersion: 'hosted-aaaaaaaaaaaa', published: 'hosted-aaaaaaaaaaaa', updateTo: null, ...extra });

describe('machine card summary line', () => {
  it('names the OS, kind and owner of an idle, current machine', () => {
    expect(machineSummary(machine(), { online: true, date })).toBe('Windows · build machine · yours');
  });
  it('says when it is building and when it needs an update', () => {
    expect(machineSummary(machine({ activeJobId: 'j', published: 'hosted-bbbbbbbbbbbb' }), { online: true, date })).toBe('Windows · build machine · yours · building · needs an update');
  });
  it('says when an offline machine was last seen', () => {
    expect(machineSummary(machine({ os: 'mac', purpose: 'personal', ownedByYou: false }), { online: false, date })).toBe('macOS · personal computer · another member’s · last seen 3 Oct, 14:02');
  });
});
