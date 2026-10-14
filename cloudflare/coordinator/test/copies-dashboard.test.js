import { it, expect } from 'vitest';
import { copiesUsageText, copiesFullText, homeText, underReplicatedText } from '../public/copies.js';

const GB = 1073741824;
it('says what a machine keeps against its budget', () => {
  const machine = { copyBudgetEffective: 50 * GB, copyUsageBytes: 12 * GB, freeBytes: 412 * GB, hosted: Array(8).fill({ repoId: 'x', state: 'current', bytes: 1 }), lfs: { objects: 340, bytes: 1 } };
  expect(copiesUsageText(machine)).toBe('uses 12 GB of 50 GB: 8 repositories, 340 large files · 412 GB free');
  expect(copiesUsageText({ ...machine, hosted: [], lfs: { objects: 0, bytes: 0 }, copyUsageBytes: 0 })).toBe('uses 0 B of 50 GB: nothing yet · 412 GB free');
  expect(copiesFullText({ copiesFull: 'budget' })).toBe('full: budget reached');
  expect(copiesFullText({ copiesFull: 'reserve' })).toBe('full: reserve reached');
  expect(copiesFullText({ copiesFull: '' })).toBe('');
});
it('says where a project lives and how many copies it has', () => {
  const copies = [{ host: 'DESKTOP-SEM', primary: false, state: 'current' }, { host: 'MAC-MINI', primary: false, state: 'current' }];
  expect(homeText({ home: 'artifacts', hosted: { copies } }, 2)).toBe('In Smith’s storage · copies on DESKTOP-SEM, MAC-MINI (2 of 2)');
  expect(homeText({ home: 'machines', hosted: { primaryHost: 'DESKTOP-SEM', copies: [{ host: 'DESKTOP-SEM', primary: true, state: 'current' }, { host: 'MAC-MINI', primary: false, state: 'stale' }] } }, 2)).toBe('On DESKTOP-SEM (primary) · copies on MAC-MINI (1 of 2 current)');
  expect(homeText({ home: 'artifacts', hosted: { copies: [copies[0]] } }, 2)).toBe('In Smith’s storage · copies on DESKTOP-SEM (1 of 2): no machine has room; raise a budget or switch a machine on');
  expect(homeText({ home: 'artifacts', hosted: { copies: [] } }, 2)).toBe('In Smith’s storage · no copies on machines yet (0 of 2): no machine has room; raise a budget or switch a machine on');
});
it('summarises what is under-replicated for Settings', () => {
  expect(underReplicatedText({ repos: 3, lfs: 12, fullHosts: ['MAC-MINI'] }, 2)).toBe('3 repositories and 12 large files have fewer than 2 copies; full: MAC-MINI');
  expect(underReplicatedText({ repos: 0, lfs: 0, fullHosts: [] }, 2)).toBe('Every repository and large file has 2 copies');
  expect(underReplicatedText({ repos: 1, lfs: 0, fullHosts: [] }, 1)).toBe('1 repository has fewer than 1 copy');
});
