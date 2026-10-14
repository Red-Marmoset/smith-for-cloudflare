import { it, expect } from 'vitest';
import { repoRowText, importSummaryText } from '../public/imports.js';

const MiB = 1048576;
it('says what will happen to each repository', () => {
  expect(repoRowText({ defaultBranch: 'main', inSmith: null, large: { count: 3, largest: 20 * MiB, over32: 0, truncated: false } }, 10 * MiB)).toBe('3 files over 10 MB on main: history will be rewritten');
  expect(repoRowText({ defaultBranch: 'main', inSmith: null, large: { count: 2, largest: 40 * MiB, over32: 1, truncated: false } }, 10 * MiB)).toBe('must be rewritten for Smith’s storage (1 file over 32 MB)');
  expect(repoRowText({ defaultBranch: 'main', inSmith: null, large: { count: 0, largest: 1, over32: 0, truncated: false } }, 10 * MiB)).toBe('no large files on main');
  expect(repoRowText({ defaultBranch: 'main', inSmith: null, large: { count: 0, largest: 0, over32: 0, truncated: true } }, 10 * MiB)).toBe('no large files seen on main (listing cut short; history may hold more)');
  expect(repoRowText({ defaultBranch: 'main', inSmith: null, large: null }, 10 * MiB)).toBe('could not check');
  expect(repoRowText({ defaultBranch: 'main', inSmith: 'senet', large: null }, 10 * MiB)).toBe('already in Smith as senet');
});
it('summarises an import', () => {
  expect(importSummaryText({ total: 55, done: 23, failed: 2, machine: 1, running: 4, queued: 25 })).toBe('23 of 55 done · 2 failed · 1 on a machine instead · 4 running');
  expect(importSummaryText({ total: 3, done: 3, failed: 0, machine: 0, running: 0, queued: 0 })).toBe('3 of 3 done');
});
