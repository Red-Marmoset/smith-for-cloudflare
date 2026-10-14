import { it, expect } from 'vitest';
import { lfsConfigSnippet, lfsSummary, lfsModeText, formatBytes, lfsMachineText, lfsCopiesText } from '../public/lfs.js';
import { lfsConfigSnippet as serverSnippet, formatBytes as serverFormat } from '../src/lfs';

it('shows the same snippet and byte formatting as the server', () => {
  expect(lfsConfigSnippet('https://exp.redmarmosetstudios.com', 'senet')).toBe(serverSnippet('https://exp.redmarmosetstudios.com', 'senet'));
  for (const n of [0, 12288, 356515840, 5368709120, 5798205849]) expect(formatBytes(n)).toBe(serverFormat(n));
});
it('summarises usage and mode in plain words', () => {
  expect(lfsSummary({ objects: 0, bytes: 0 })).toBe('No large files yet');
  expect(lfsSummary({ objects: 1, bytes: 3 })).toBe('1 object · 3 B');
  expect(lfsSummary({ objects: 12, bytes: 356515840 })).toBe('12 objects · 340 MB');
  expect(lfsSummary(undefined)).toBe('No large files yet');
  expect(lfsModeText({ mode: 'proxy', proxyMaxBytes: 104857600 })).toBe('Large files move through Smith, up to 100 MB each.');
  expect(lfsModeText({ mode: 'direct', proxyMaxBytes: 104857600 })).toBe('Large files go straight to R2, up to 5 GB each.');
});
it('describes a machine’s large-file store and a project’s copies', () => {
  expect(lfsMachineText({ freeBytes: 412 * 1073741824, lfs: { objects: 12, bytes: 356515840 } })).toBe('412 GB free · holds 340 MB of large files');
  expect(lfsMachineText({ freeBytes: 412 * 1073741824, lfs: { objects: 0, bytes: 0 } })).toBe('412 GB free · holds nothing yet');
  expect(lfsMachineText({ freeBytes: 9 * 1073741824, lfs: { objects: 1, bytes: 10 }, copiesFull: 'reserve' })).toBe('9 GB free · holds 10 B of large files · full: reserve reached');
  expect(lfsMachineText({ freeBytes: 9 * 1073741824, lfs: { objects: 1, bytes: 10 }, copiesFull: 'budget' })).toBe('9 GB free · holds 10 B of large files · full: budget reached');
  expect(lfsMachineText({ freeBytes: 0, lfs: { objects: 0, bytes: 0 } })).toBe('free space unknown · holds nothing yet');
  expect(lfsCopiesText([])).toBe('');
  expect(lfsCopiesText([{ hostname: 'DESKTOP-SEM', held: 3, current: true }, { hostname: 'MAC-MINI', held: 2, current: false }])).toBe('copies on DESKTOP-SEM, MAC-MINI (1 of 2 current)');
});
