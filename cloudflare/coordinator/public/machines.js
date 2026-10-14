'use strict';
// A machine card folds to its heading and one line; the line says what you would open it to check.

const OS_NAMES = { windows: 'Windows', mac: 'macOS', linux: 'Linux' };

// "Windows · build machine · yours · building · up to date", or "… · last seen 3 Oct, 14:02" once it went quiet.
export function machineSummary(machine, { online, date }) {
  const parts = [OS_NAMES[machine.os] || machine.os || 'Unknown OS', machine.purpose === 'personal' ? 'personal computer' : 'build machine',
    machine.ownedByYou ? 'yours' : 'another member’s'];
  if (!machine.active) return parts.join(' · ');
  if (machine.draining) parts.push(machine.activeJobId ? 'finishing a build, then updating' : 'paused for an update');
  else if (machine.activeJobId) parts.push('building');
  if (!online) parts.push(`last seen ${date(machine.lastSeenAt)}`);
  else if (machine.updateTo) parts.push(`updating to ${machine.updateTo}`);
  else if (machine.published && machine.agentVersion !== machine.published) parts.push('needs an update');
  return parts.join(' · ');
}

// Whether a machine card was left open is remembered in this browser only, so a refresh keeps it as it was.
const openKey = machine => `smith.machine.${machine.id}`;
export function machineCard(machine, { element, badge, status, line }) {
  const details = element('details', undefined, 'machine'); const summary = element('summary');
  const top = element('div', undefined, 'machine-top'); const right = element('span', undefined, 'machine-state');
  right.append(badge(status), element('span', 'Show', 'toggle'));
  top.append(element('strong', machine.hostname || machine.os || 'Machine'), right);
  summary.append(top, element('p', line, 'muted small')); details.append(summary);
  const body = element('div', undefined, 'machine-body'); details.append(body);
  const toggle = summary.querySelector('.toggle');
  try { details.open = localStorage.getItem(openKey(machine)) === 'open'; } catch { /* storage blocked: start folded */ }
  if (details.open) toggle.textContent = 'Hide';
  details.addEventListener('toggle', () => {
    toggle.textContent = details.open ? 'Hide' : 'Show';
    try { localStorage.setItem(openKey(machine), details.open ? 'open' : 'closed'); } catch { /* nothing to remember */ }
  });
  return { card: details, body };
}
