// Copies on machines (spec §4) as the dashboard says them. Pure, tested, and pinned to the server's byte formatting (lfs.js).
import { formatBytes } from './lfs.js';

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
export function copiesUsageText(machine) {
  const repos = (machine.hosted || []).length, objects = machine.lfs?.objects || 0;
  const held = repos || objects ? [repos ? plural(repos, 'repository', 'repositories') : '', objects ? plural(objects, 'large file', 'large files') : ''].filter(Boolean).join(', ') : 'nothing yet';
  const free = machine.freeBytes > 0 ? `${formatBytes(machine.freeBytes)} free` : 'free space unknown';
  return `uses ${formatBytes(machine.copyUsageBytes || 0)} of ${formatBytes(machine.copyBudgetEffective || 0)}: ${held} · ${free}`;
}
export function copiesFullText(machine) { return machine.copiesFull === 'budget' ? 'full: budget reached' : machine.copiesFull === 'reserve' ? 'full: reserve reached' : ''; }
export function homeText(project, target) {
  const all = project.hosted?.copies || [], copies = all.filter(c => !c.primary);
  const current = all.filter(c => c.state === 'current').length;
  const where = project.home === 'artifacts' ? 'In Smith’s storage' : `On ${project.hosted?.primaryHost || 'a machine'} (primary)`;
  const list = copies.length ? `copies on ${copies.map(c => c.host).join(', ')}` : 'no copies on machines yet';
  const count = all.length >= target ? (current === all.length ? `(${all.length} of ${target})` : `(${current} of ${target} current)`) : `(${all.length} of ${target}): no machine has room; raise a budget or switch a machine on`;
  return `${where} · ${list} ${count}`;
}
export function underReplicatedText(copies, target) {
  if (!copies || (!copies.repos && !copies.lfs)) return `Every repository and large file has ${plural(target, 'copy', 'copies')}`;
  const parts = [copies.repos ? plural(copies.repos, 'repository', 'repositories') : '', copies.lfs ? plural(copies.lfs, 'large file', 'large files') : ''].filter(Boolean);
  const verb = copies.repos + copies.lfs === 1 ? 'has' : 'have';
  return `${parts.join(' and ')} ${verb} fewer than ${plural(target, 'copy', 'copies')}${copies.fullHosts?.length ? `; full: ${copies.fullHosts.join(', ')}` : ''}`;
}
