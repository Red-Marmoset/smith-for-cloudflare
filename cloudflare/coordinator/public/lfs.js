// Large files (Git LFS) on the dashboard: the .lfsconfig snippet, usage and mode texts. Pure, so the tests cover them
// and pin them to the server's own formatting (src/lfs.ts).
export function formatBytes(n) {
  const units = ['B', 'kB', 'MB', 'GB', 'TB'];
  let value = n, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  const rounded = Math.round(value * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)} ${units[unit]}`;
}
export function lfsConfigSnippet(origin, projectId) { return `[lfs]\n\turl = ${origin}/git/${projectId}.git/info/lfs\n`; }
export function lfsSummary(lfs) {
  if (!lfs || !lfs.objects) return 'No large files yet';
  return `${lfs.objects} ${lfs.objects === 1 ? 'object' : 'objects'} · ${formatBytes(lfs.bytes)}`;
}
// A machine's card: free space, what it holds, and whether the reserve stops further copies.
export function lfsMachineText(machine) {
  const free = machine.freeBytes > 0 ? `${formatBytes(machine.freeBytes)} free` : 'free space unknown';
  const held = machine.lfs && machine.lfs.objects ? `holds ${formatBytes(machine.lfs.bytes)} of large files` : 'holds nothing yet';
  return `${free} · ${held}${machine.copiesFull ? ' · full: ' + machine.copiesFull + ' reached' : ''}`;
}
// A project's card: which machines hold copies and how many of them are complete.
export function lfsCopiesText(copies) {
  if (!copies || !copies.length) return '';
  const current = copies.filter(c => c.current).length;
  return `copies on ${copies.map(c => c.hostname).join(', ')} (${current} of ${copies.length} current)`;
}
export function lfsModeText(lfs) {
  return lfs && lfs.mode === 'direct' ? 'Large files go straight to R2, up to 5 GB each.' : `Large files move through Smith, up to ${formatBytes((lfs && lfs.proxyMaxBytes) || 104857600)} each.`;
}
