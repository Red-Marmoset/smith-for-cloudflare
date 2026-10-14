'use strict';
import { renderMarkdown } from './markdown.js';
import { createTranscriptRenderers } from './transcript.js';
import { submitBuild } from './build-requests.js';
import { createReview } from './crew-review.js';
import { createMessages } from './crew-messages.js';
import { createEvents, parseMemberPolicy, reasonText } from './crew-events.js';
// "Crew": named AI members that look after the workspace's projects unattended (src/crew.ts). This page lists them,
// creates and edits them, starts, pauses and stops their runs, and shows a run's transcript read-only (with the chat's
// renderers) beside its report. Review (crew-review.js) and Messages (crew-messages.js) list the workspace's proposals and crew messages.

// What a new member starts from: CREW_TEMPLATES in src/crew-model.ts without the charters, which the server fills in
// when the form leaves the charter blank. test/crew-dashboard.test.js keeps the two in step.
export const CREW_TEMPLATE_DEFAULTS = {
  'failure-triage': { label: 'Failure triage', name: 'Failure triage', brain: 'auto', permissionMode: 'plan', trigger: { kind: 'buildFinished', on: 'failed' }, attachSharedProjects: false },
  'dependency-maintenance': { label: 'Dependency maintenance', name: 'Dependency maintenance', brain: 'auto', permissionMode: 'plan', trigger: { kind: 'branchChanged', branch: '', checkMinutes: 5 }, attachSharedProjects: false },
  standards: { label: 'Standards', name: 'Standards', brain: 'auto', permissionMode: 'acceptEdits', trigger: { kind: 'interval', intervalMinutes: 360, skipIfUnchanged: true }, attachSharedProjects: false },
  'bug-hunter': { label: 'Bug hunter', name: 'Bug hunter', brain: 'auto', permissionMode: 'plan', trigger: { kind: 'interval', intervalMinutes: 720, skipIfUnchanged: true }, attachSharedProjects: false },
  'test-proposer': { label: 'Test proposer', name: 'Test proposer', brain: 'auto', permissionMode: 'acceptEdits', trigger: { kind: 'buildFinished', on: 'any' }, attachSharedProjects: false },
  extractor: { label: 'Extractor', name: 'Extractor', brain: 'auto', permissionMode: 'plan', trigger: { kind: 'interval', intervalMinutes: 1440, skipIfUnchanged: false }, attachSharedProjects: true },
  'feature-planner': { label: 'Feature planner', name: 'Feature planner', brain: 'auto', permissionMode: 'plan', trigger: { kind: 'interval', intervalMinutes: 1440, skipIfUnchanged: false }, attachSharedProjects: false },
  implementer: { label: 'Implementer', name: 'Implementer', brain: 'auto', permissionMode: 'acceptEdits', trigger: { kind: 'interval', intervalMinutes: 720, skipIfUnchanged: false }, attachSharedProjects: false },
  'bug-fixer': { label: 'Bug fixer', name: 'Bug fixer', brain: 'auto', permissionMode: 'acceptEdits', trigger: { kind: 'buildFinished', on: 'failed' }, attachSharedProjects: false },
  'pipeline-setup': { label: 'Pipeline setup', name: 'Pipeline setup', brain: 'auto', permissionMode: 'acceptEdits', trigger: { kind: 'interval', intervalMinutes: 1440, skipIfUnchanged: true }, attachSharedProjects: false },
  'standards-reviewer': { label: 'Standards reviewer', name: 'Standards reviewer', brain: 'auto', permissionMode: 'plan', trigger: { kind: 'manual' }, attachSharedProjects: false },
  'cleanup-reviewer': { label: 'Cleanup reviewer', name: 'Cleanup reviewer', brain: 'auto', permissionMode: 'plan', trigger: { kind: 'manual' }, attachSharedProjects: false },
  'test-reviewer': { label: 'Test reviewer', name: 'Test reviewer', brain: 'auto', permissionMode: 'plan', trigger: { kind: 'manual' }, attachSharedProjects: false },
  'security-reviewer': { label: 'Security reviewer', name: 'Security reviewer', brain: 'auto', permissionMode: 'plan', trigger: { kind: 'manual' }, attachSharedProjects: false },
  'architecture-reviewer': { label: 'Architecture reviewer', name: 'Architecture reviewer', brain: 'auto', permissionMode: 'plan', trigger: { kind: 'manual' }, attachSharedProjects: false },
  custom: { label: 'Custom', name: 'New crew member', brain: 'auto', permissionMode: 'plan', trigger: { kind: 'manual' }, attachSharedProjects: false },
};
export const DEFAULT_BUDGET = { usdPerRun: 1, maxMinutes: 20, runsPerDay: 8, buildsPerDay: 4 };   // DEFAULT_CREW_BUDGET in src/crew-model.ts
const MANAGERS = ['owner', 'admin', 'operator'];
const ACTIVE_RUNS = new Set(['waiting', 'queued', 'running', 'pushing']);
const RUNS_MAX_AGE = 30000;            // how stale a card's status may get before its runs are fetched again
const TABS = ['members', 'review', 'messages', 'events'];

// Whether a project builds from Smith's copy: on Smith's own machines or on Cloudflare Artifacts (as hasSmithCopy in
// src/crew.ts). Optional for crew: without it a run checks out with the machine's own Git login, as a chat does.
export function hasSmithCopy(project) {
  return (project?.artifacts?.status === 'done' && project.artifacts.remote === project.repoUrl) || project?.hosted?.status === 'ready';
}
function every(minutes) {
  if (minutes % 1440 === 0) return minutes === 1440 ? 'day' : `${minutes / 1440} days`;
  if (minutes % 60 === 0) return minutes === 60 ? 'hour' : `${minutes / 60} hours`;
  return `${minutes} minutes`;
}
export function triggerSummary(trigger) {
  if (trigger?.kind === 'interval') return `every ${every(trigger.intervalMinutes)}${trigger.skipIfUnchanged ? ' when there are new commits' : ''}`;
  if (trigger?.kind === 'buildFinished') return trigger.on === 'failed' ? 'after a failed build' : 'after every build';
  if (trigger?.kind === 'branchChanged') return `when ${trigger.branch ? `branch ${trigger.branch}` : 'the project branch'} gets new commits`;
  return 'on Run now only';
}
// The card's status from the member and its newest run: the workspace switch first, then a run in flight, then the member.
export function memberStatus(member, run, { crewStopped = false, hostname = '' } = {}) {
  if (crewStopped) return { text: 'stopped: workspace', tone: 'stopped' };
  if (run?.state === 'waiting') return run.waitReason === 'budget' ? { text: 'over budget', tone: 'waiting' } : { text: `waiting: ${reasonText(run.waitReason) || 'for a machine'}`, tone: 'waiting' };
  if (run?.state === 'queued') return { text: 'queued', tone: 'queued' };
  if (run?.state === 'running') return { text: `running on ${hostname || 'a machine'}`, tone: 'running' };
  if (run?.state === 'pushing') return { text: 'pushing', tone: 'pushing' };
  return member.enabled ? { text: 'idle', tone: 'idle' } : { text: 'disabled', tone: 'disabled' };
}
// An open run is fetched again while it can still change: its session is working, its newest turn is queued or running,
// or its run row (fetched every refresh for the open member) says a step is still due, such as a push.
export function runNeedsPolling(session, runState) {
  if (!session) return true;
  return Boolean(session.working) || ['queued', 'running'].includes(session.turns?.at(-1)?.state) || ACTIVE_RUNS.has(runState);
}
// The projects in `selected` that are no longer in the workspace: the server refuses a member that names one.
export function missingProjects(selected, available) {
  return selected.filter(id => !available.some(project => project.id === id));
}
const usd = value => `$${Number(value).toFixed(2)}`;
const runTrigger = trigger => trigger?.kind === 'interval' ? 'scheduled' : trigger?.kind === 'buildFinished' ? 'after a build' : 'Run now';

export function createCrew({ $, api, base, element, action, badge, date, projects, machines, settings, generation, pullOf = () => null, openPull = () => {} }) {
  const { renderEvent, turnFooter, details } = createTranscriptRenderers({ element, renderMarkdown, badge });
  let members = [], names = {}, runsBy = new Map(), runErrors = new Map(), tab = 'members', filter = null, open = null;
  let memberSnapshot = '', detailSnapshot = '', runsSnapshot = '', reportSnapshot = '';
  let openRun = null, runSession = null, runAfter = -1, runBlocks = new Map(), runEpoch = 0;
  let editing = null, template = 'standards', wantEnabled = true, droppedRelated = 0, focusKey = null, dialogKey = null, promptKey = null;
  const crewPath = id => `${base()}/crew/${encodeURIComponent(id)}`;
  const runPath = id => `${base()}/crew/runs/${encodeURIComponent(id)}`;
  const canManage = () => MANAGERS.includes(settings()?.role);
  const isAdmin = () => ['owner', 'admin'].includes(settings()?.role);
  const copyAvailable = () => Boolean(settings()?.artifactsAvailable) || machines().some(machine => machine.hostsOnline);   // Smith can take a copy of a project
  const projectOf = id => projects().find(p => p.id === id);
  const machineOf = id => machines().find(m => m.id === id);
  const memberOf = id => members.find(m => m.id === id);
  const online = node => node.active && Date.now() - node.lastSeenAt < (settings()?.nodeOfflineSeconds || 60) * 1000;
  const runsOf = id => runsBy.get(id)?.runs ?? [];
  const templateLabel = key => CREW_TEMPLATE_DEFAULTS[key]?.label ?? 'Custom';
  const review = createReview({ $, api, base, element, badge, date, action, projects, members: () => members, canManage, generation, pullOf, openPull });
  const messages = createMessages({ $, api, base, element, date, action, renderMarkdown, members: () => members, canManage, generation });
  const events = createEvents({ $, api, base, element, date, action, projects, members: () => members, canManage, generation });
  function statusOf(member) {
    const run = runsOf(member.id)[0];
    return memberStatus(member, run, { crewStopped: Boolean(settings()?.crewStopped), hostname: machineOf(run?.nodeId)?.hostname });
  }
  function option(value, label, disabled = false) { const node = element('option', label); node.value = value; node.disabled = disabled; return node; }
  // Fills a select from [value, label, disabled] rows, keeping `value` when it is still a usable choice.
  function choose(select, rows, value) {
    select.replaceChildren(...rows.map(([v, label, disabled]) => option(v, label, disabled)));
    const usable = rows.filter(row => !row[2]);
    select.value = usable.some(([v]) => v === value) ? value : usable[0]?.[0] ?? '';
  }

  // ---- Focus: lists re-render as their data changes, so the control you used keeps the focus ---------------
  // Nothing usable has the focus: the page itself, or a control that was just removed, hidden or closed in a dialog.
  function focusLost() {
    const active = document.activeElement;
    return !active || active === document.body || !active.isConnected || Boolean(active.closest('[hidden], dialog:not([open])'));
  }
  function restoreFocus(key) {
    if (key && focusLost()) document.querySelector(`[data-focus="${CSS.escape(key)}"]`)?.focus();
  }
  function keepFocus(container, render) {
    const active = document.activeElement;
    const key = container.contains(active) ? active.dataset.focus : focusLost() ? focusKey : null;
    render();
    if (key) container.querySelector(`[data-focus="${CSS.escape(key)}"]`)?.focus();
  }
  // action() disables the button while it works, which drops its focus; press() puts it back on the same control.
  async function press(button, task) {
    focusKey = button.dataset.focus ?? null;
    try { await action(button, task); } finally { const key = focusKey; focusKey = null; restoreFocus(key); }
  }

  // ---- Members ------------------------------------------------------------------------------------------------
  function nextRun(member) {
    if (!member.enabled) return 'paused';
    if (member.trigger.kind === 'interval') return member.nextRunAt ? date(member.nextRunAt) : 'not scheduled';
    if (member.trigger.kind === 'buildFinished') return member.trigger.on === 'failed' ? 'after the next failed build' : 'after the next build';
    if (member.trigger.kind === 'branchChanged') return member.nextRunAt ? `looks for new commits ${date(member.nextRunAt)}` : 'not scheduled';
    return 'when someone presses Run now';
  }
  function aiSummary(member) {
    if (member.brain === 'auto') return `best available AI (${aiOrderText()})`;
    if (member.brain === 'ollama') return `${member.model || 'largest local model'} on machine`;
    if (member.brain === 'api-key') return 'Anthropic API key';
    return member.tool === 'codex' ? 'Codex sign-in' : 'Claude Code sign-in';
  }
  function runResult(run) {
    if (!run.report) return run.state === 'finished' ? 'no report' : run.state;
    const count = run.report.findings.length;
    return `${count} ${count === 1 ? 'finding' : 'findings'}${run.report.proposal ? ' and a proposal' : ''}`;
  }
  function memberView(member) {
    const last = runsOf(member.id).find(run => !ACTIVE_RUNS.has(run.state));
    return { id: member.id, name: member.name, enabled: member.enabled, template: templateLabel(member.template), status: statusOf(member), selected: member.id === open,
      projects: member.projectIds.map((id, index) => ({ name: projectOf(id)?.name || id, primary: index === 0 })),
      how: [aiSummary(member), member.nodeId ? `on ${machineOf(member.nodeId)?.hostname || 'a removed machine'}` : 'on any eligible machine',
        member.permissionMode === 'plan' ? 'reads and reports' : 'edits its branch', triggerSummary(member.trigger)].join(' · '),
      last: last ? `${date(last.createdAt)}, ${runResult(last)}${last.costUsd != null ? `, ${usd(last.costUsd)}` : ''}` : runsBy.has(member.id) ? 'none yet' : 'not loaded', next: nextRun(member),
      runError: runErrors.get(member.id) ?? null };
  }
  function memberCard(view) {
    const id = view.id, card = element('article', undefined, `crew-member${view.selected ? ' selected' : ''}`);
    const top = element('div', undefined, 'crew-member-top');
    const name = element('button', view.name, 'build-link crew-open'); name.type = 'button'; name.dataset.focus = `${id}:open`;
    name.setAttribute('aria-label', `Open ${view.name}: its runs and memory`);
    name.addEventListener('click', () => action(name, () => openMember(id)));
    top.append(name, element('span', view.template, 'badge'), element('span', view.status.text, `badge crew-${view.status.tone}`));
    const chips = element('div', undefined, 'crew-chips');
    for (const project of view.projects) chips.append(element('span', project.name, `crew-chip${project.primary ? ' primary' : ''}`));
    card.append(top, chips, element('p', view.how, 'muted small'), element('p', `Last run: ${view.last}. Next run: ${view.next}.`, 'muted small'));
    if (view.runError) card.append(element('p', `Its runs could not be loaded, so its status may be out of date: ${view.runError}`, 'small crew-warn'));
    const buttons = element('div', undefined, 'crew-actions');
    const add = (text, key, task, className = 'quiet') => {
      const button = element('button', text, className); button.type = 'button'; button.dataset.focus = `${id}:${key}`;
      button.addEventListener('click', () => key === 'edit' ? task() : press(button, task)); buttons.append(button);
    };
    if (canManage()) { add('Run now', 'run', () => run(id, false), ''); add('Dry run', 'dry', () => run(id, true)); }
    add('Preview prompt', 'prompt', () => previewPrompt(id));
    if (canManage()) {
      add(view.enabled ? 'Pause' : 'Resume', 'enable', () => setEnabled(id, !view.enabled));
      add('Edit', 'edit', () => { const member = memberOf(id); if (member) openDialog(member); });
      add('Delete', 'delete', () => remove(id), 'quiet danger');
    }
    card.append(buttons);
    return card;
  }
  function renderMembers() {
    for (const row of document.querySelectorAll('[data-crew-project]')) fillProjectRow(row);
    const manage = canManage(), stopped = Boolean(settings()?.crewStopped);
    const views = (filter ? members.filter(m => m.projectIds.includes(filter)) : members).map(memberView);
    const snapshot = JSON.stringify([views, manage, stopped, filter, filter && projectOf(filter)?.name]);
    if (snapshot === memberSnapshot) return; memberSnapshot = snapshot;
    $('new-crew-member').hidden = !manage;
    $('crew-notice').hidden = !stopped;
    $('crew-notice').textContent = 'All crew work is stopped in workspace settings (Stop all crew). Nothing runs until an owner or admin turns it off.';
    $('crew-filter').hidden = !filter;
    $('crew-filter-text').textContent = filter ? `Showing the crew members that work on ${projectOf(filter)?.name || filter}.` : '';
    keepFocus($('crew-members'), () => {
      $('crew-members').replaceChildren(...views.map(memberCard));
      if (!views.length) $('crew-members').append(element('p', filter ? 'No crew member works on this project.'
        : manage ? 'No crew members yet. Create one with “New crew member”: pick a template such as Bug hunter, the projects it looks after, and when it runs.'
        : 'No crew members yet. Workspace operators can create them.', 'empty small'));
    });
  }
  async function run(id, dryRun) {
    const current = generation();
    const started = await submitBuild(requestId => api(`${crewPath(id)}/run`, { requestId, ...(dryRun ? { dryRun: true } : {}) }), sessionStorage, `${base()}/crew/${id}/${dryRun ? 'dry-run' : 'run'}`);
    if (current !== generation()) return;
    if (open !== id) { open = id; await selectRun(null); }
    runsBy.delete(id); await refresh();
    if (started?.sessionId && current === generation()) await selectRun(started.sessionId);
  }
  async function previewPrompt(id) {
    const current = generation(), member = memberOf(id);
    const { system, prompt } = await api(`${crewPath(id)}/prompt`);
    if (current !== generation()) return;
    $('crew-prompt-title').textContent = `${member?.name ?? 'Crew member'}: prompt preview`;
    $('crew-prompt-system').textContent = system; $('crew-prompt-text').textContent = prompt;
    promptKey = `${id}:prompt`; $('crew-prompt-dialog').showModal();
  }
  async function setEnabled(id, enabled) {
    await api(`${crewPath(id)}/enable`, { enabled }); await refresh();
  }
  async function remove(id) {
    const member = memberOf(id);
    if (!member || !confirm(`Delete ${member.name}? Its runs, reports and messages stay in the workspace’s history. A run in progress must be stopped first.`)) return;
    await api(`${crewPath(id)}/delete`, {});
    if (open === id) { open = null; await selectRun(null); }
    runsBy.delete(id); await refresh();
  }

  // ---- Project cards: who works on each project, linking to the crew filtered to it ----------------------------------
  function fillProjectRow(row) {
    const projectId = row.dataset.crewProject;
    const views = members.filter(m => m.projectIds.includes(projectId)).map(m => ({ id: m.id, name: m.name, status: statusOf(m) }));
    const snapshot = JSON.stringify(views);
    if (row.dataset.snapshot === snapshot) return; row.dataset.snapshot = snapshot;
    row.hidden = !views.length;
    keepFocus(row, () => {
      row.replaceChildren(element('span', 'Crew', 'crew-project-label'));
      for (const view of views) {
        const chip = element('button', undefined, 'crew-chip crew-chip-button'); chip.type = 'button'; chip.dataset.focus = `${projectId}/${view.id}:chip`;
        chip.title = `${view.name}: ${view.status.text}`;
        chip.setAttribute('aria-label', `${view.name}, ${view.status.text}. Show the crew that works on this project`);
        chip.append(element('span', '', `crew-dot crew-${view.status.tone}`), document.createTextNode(view.name));
        chip.addEventListener('click', () => action(chip, () => showProject(projectId, view.id)));
        row.append(chip);
      }
    });
  }
  // The crew row of a project card, appended to the card and returned, so a card that wants it elsewhere can move it.
  function renderProjectCrew(card, project) {
    const row = element('div', undefined, 'crew-project'); row.dataset.crewProject = project.id; row.hidden = true;
    card.append(row); fillProjectRow(row);
    return row;
  }
  // A project a crew member created (src/crew.ts crewCreated): who made it and why, and for owners the Delete that takes it
  // out of Smith while its Cloudflare Artifacts repository stays in the workspace's account.
  function renderCreatedBy(card, project, onDeleted) {
    if (typeof project.createdBy?.crewId !== 'string') return;   // a Git-URL project's createdBy is the person who added it
    const row = element('div', undefined, 'crew-project');
    row.append(element('span', `Created by ${memberOf(project.createdBy.crewId)?.name || 'a crew member'}${project.purpose ? ': ' + project.purpose : ''}`, 'muted small'));
    if (settings()?.role === 'owner') {
      const remove = element('button', 'Delete crew project', 'quiet');
      remove.addEventListener('click', () => action(remove, async () => {
        if (!confirm(`Delete ${project.name || project.id} from Smith? Crew members stop working on it; its Cloudflare Artifacts repository stays in your Cloudflare account.`)) return;
        await api(`${base()}/crew/projects/${encodeURIComponent(project.id)}/delete`, {});
        await onDeleted();
      }));
      row.append(remove);
    }
    card.append(row);
  }
  async function showProject(projectId, memberId) {
    filter = projectId; showTab('members');
    if (open !== memberId) { open = memberId; await selectRun(null); }
    runsBy.delete(memberId); await refresh();
    $('crew').scrollIntoView({ block: 'start' }); $('crew-detail-title').focus();
  }

  // ---- A member opened: charter, memory, runs; a run's transcript and report --------------------------------------
  async function openMember(id) {
    if (open !== id) { open = id; await selectRun(null); }
    runsBy.delete(id); await refresh();
    $('crew-detail').scrollIntoView({ block: 'nearest' }); $('crew-detail-title').focus();
  }
  function textBox(key, summary, text, wasOpen) {
    const box = element('details', undefined, 'chat-tool crew-text'); box.dataset.key = key; box.open = wasOpen.has(key);
    box.append(element('summary', summary), element('pre', text));
    return box;
  }
  function renderDetail() {
    const member = memberOf(open);
    $('crew-detail').hidden = !member;
    if (!member) return;
    const meta = `${templateLabel(member.template)} · goes by ${member.slug} · created by ${names[member.createdBy] || 'a workspace member'} on ${date(member.createdAt)}${member.charterUpdatedAt ? ` · charter changed ${date(member.charterUpdatedAt)}` : ''}`;
    const snapshot = JSON.stringify([member.id, member.name, member.charter, member.memory, meta]);
    if (snapshot !== detailSnapshot) {
      detailSnapshot = snapshot;
      $('crew-detail-title').textContent = member.name; $('crew-detail-meta').textContent = meta;
      const info = $('crew-detail-info'), wasOpen = new Set([...info.querySelectorAll('details[open]')].map(box => box.dataset.key));
      info.replaceChildren(textBox('charter', 'Charter', member.charter, wasOpen),
        textBox('memory', 'Memory', member.memory || 'Nothing remembered yet. Each run leaves notes here for the next one.', wasOpen));
    }
    renderRuns();
  }
  function renderRuns() {
    const views = runsOf(open).map(run => ({ id: run.id, sessionId: run.sessionId, state: run.state, summary: run.report?.summary || run.waitReason || '',
      line: [date(run.createdAt), runTrigger(run.trigger), machineOf(run.nodeId)?.hostname, run.costUsd != null ? usd(run.costUsd) : ''].filter(Boolean).join(' · ') }));
    const failure = runErrors.get(open);
    const snapshot = JSON.stringify([open, runsBy.has(open), views, openRun, failure]);
    if (snapshot === runsSnapshot) return; runsSnapshot = snapshot;
    keepFocus($('crew-runs'), () => {
      $('crew-runs').replaceChildren();
      if (failure) $('crew-runs').append(element('p', `The runs could not be loaded${runsBy.has(open) ? ', so this list may be out of date' : ''}: ${failure}`, 'small crew-warn'));
      if (!runsBy.has(open)) { if (!failure) $('crew-runs').append(element('p', 'Loading runs…', 'empty small')); return; }
      if (!views.length) $('crew-runs').append(element('p', 'No runs yet.', 'empty small'));
      for (const view of views) {
        const row = element(view.sessionId ? 'button' : 'div', undefined, `crew-run-row${view.sessionId && view.sessionId === openRun ? ' selected' : ''}`);
        if (view.sessionId) {
          row.type = 'button'; row.dataset.focus = `run:${view.id}`; row.setAttribute('aria-pressed', String(view.sessionId === openRun));
          row.addEventListener('click', () => press(row, () => selectRun(view.sessionId)));
        }
        const line = element('span', undefined, 'crew-run-line'); line.append(badge(view.state), element('span', view.line));
        row.append(line); if (view.summary) row.append(element('span', view.summary, 'muted small crew-run-summary'));
        $('crew-runs').append(row);
      }
    });
  }
  async function selectRun(id) {
    runEpoch++; openRun = id; runSession = null; runAfter = -1; runBlocks = new Map(); reportSnapshot = '';
    $('crew-run-log').replaceChildren(); $('crew-run-report').replaceChildren(); $('crew-run').hidden = !id; $('crew-run-stop').hidden = true;
    $('crew-run-title').textContent = id ? 'Loading the run…' : ''; $('crew-run-meta').textContent = '';
    renderRuns();
    if (!id) return;
    const epoch = runEpoch;
    await refreshRun();
    if (epoch !== runEpoch) return;
    renderReport(); $('crew-run').scrollIntoView({ block: 'nearest' });
  }
  async function refreshRun() {
    const epoch = runEpoch, current = generation(), id = openRun;
    const session = await api(runPath(id));
    for (;;) {
      const page = await api(`${runPath(id)}/events?after=${runAfter}`);
      if (epoch !== runEpoch || current !== generation()) return;
      runSession = session;
      if (!renderRun(page.events) || page.events.length < 200) break;
    }
  }
  // A crew run never asks a person anything (no ask mode), so a stored question only notes which tool it concerned.
  const asked = event => element('p', `Asked to use ${event.data?.tool ?? 'a tool'}`, 'chat-status');
  function runBlock(turn) {
    if (!runBlocks.has(turn.id)) {
      const el = element('section', undefined, `chat-turn${turn.kind === 'push' ? ' chat-turn-push' : ''}`);
      const head = turn.kind === 'push' ? element('p', 'Push the run’s branch', 'chat-status') : details('What the run was asked', String(turn.prompt ?? ''), 'chat-tool');
      const body = element('div'), footer = element('div', undefined, 'chat-footer');
      el.append(head, body, footer); $('crew-run-log').append(el);
      runBlocks.set(turn.id, { body, footer });
    }
    return runBlocks.get(turn.id);
  }
  // Renders the session's turns and new events; false when an event belongs to a turn this session read did not
  // include yet (it is fetched again next time, with its turn).
  function renderRun(events) {
    const log = $('crew-run-log'), follow = log.scrollHeight - log.scrollTop - log.clientHeight < 120, session = runSession;
    for (const turn of session.turns) turnFooter(runBlock(turn).footer, turn, session.branch, 'The machine stopped responding, so this run was lost.');
    let complete = true;
    for (const event of events) {
      if (event.seq <= runAfter) continue;
      if (!session.turns.some(turn => turn.id === event.turnId)) { complete = false; break; }
      const node = renderEvent(event, { approval: asked }); if (node) runBlock({ id: event.turnId }).body.append(node);
      runAfter = event.seq;
    }
    if (follow) log.scrollTop = log.scrollHeight;
    const from = session.baseCommitActual || session.baseCommit;
    $('crew-run-title').textContent = session.title;
    $('crew-run-meta').textContent = `${machineOf(session.nodeId)?.hostname || 'a removed machine'} · ${projectOf(session.projectId)?.name || session.projectId} · branch ${session.branch}${from ? ` from ${from.slice(0, 12)}` : ''}${session.costUsd != null ? ` · ${usd(session.costUsd)}` : ''}`;
    $('crew-run-stop').hidden = !session.working || !canManage();
    return complete;
  }
  function renderReport() {
    const run = runsOf(open).find(item => item.sessionId === openRun);
    const snapshot = JSON.stringify([openRun, run?.state, run?.report, run?.branch, run?.commit]);
    if (snapshot === reportSnapshot) return; reportSnapshot = snapshot;
    const box = $('crew-run-report'); box.replaceChildren(element('h4', 'Report', 'crew-subheading'));
    const report = run?.report;
    if (!report) { box.append(element('p', run && ACTIVE_RUNS.has(run.state) ? 'The report appears here when the run finishes.' : 'This run filed no report.', 'muted small')); return; }
    box.append(badge(report.status));
    if (report.summary) box.append(element('p', report.summary, 'crew-report-text'));
    if (report.proposal) {
      const proposal = element('div', undefined, 'crew-proposal');
      proposal.append(element('strong', report.proposal.title), element('p', report.proposal.summary, 'crew-report-text small'));
      box.append(proposal);
    }
    if (report.findings.length) {
      box.append(element('h4', `Findings (${report.findings.length})`, 'crew-subheading'));
      const list = element('ul', undefined, 'crew-findings');
      for (const finding of report.findings) {
        const item = element('li');
        item.append(element('span', finding.severity, `badge crew-severity ${finding.severity}`), document.createTextNode(' '), element('strong', finding.title));
        if (finding.file) item.append(element('code', `${finding.file}${finding.line ? `:${finding.line}` : ''}`, 'crew-finding-file'));
        item.append(element('p', finding.detail, 'crew-report-text small'));
        list.append(item);
      }
      box.append(list);
    }
    if (report.files.length) {
      box.append(element('h4', `Files touched (${report.files.length})`, 'crew-subheading'));
      const list = element('ul', undefined, 'crew-files');
      for (const file of report.files) { const item = element('li'); item.append(element('code', file)); list.append(item); }
      box.append(list);
    }
    if (run.branch && run.commit) box.append(element('p', `Branch ${run.branch} at ${run.commit.slice(0, 12)}`, 'muted small'));
  }

  // ---- Review and Messages: the workspace's proposals and crew messages, newest first ------------------------------
  function showTab(name) {
    tab = name;
    for (const key of TABS) {
      const button = $(`crew-tab-${key}`), on = key === name;
      button.setAttribute('aria-selected', String(on)); button.tabIndex = on ? 0 : -1; button.classList.toggle('selected', on);
      $(`crew-${key}-panel`).hidden = !on;
    }
  }
  async function refreshList() {
    if (tab === 'review') return review.refresh();
    if (tab === 'messages') return messages.refresh();
    if (tab === 'events') return events.refresh();
  }

  // ---- New crew member / Edit ---------------------------------------------------------------------------------
  function localModels() {   // models (Ollama underneath) on online machines whose owners allow crew runs (never cloud ones)
    const crewMachines = machines().filter(m => m.runCrew && online(m) && m.ai?.ollama?.up);
    return [...new Set(crewMachines.flatMap(m => m.ai.ollama.models.filter(model => !model.remote).map(model => model.name)))].sort();
  }
  // Why a machine cannot take this member's runs ([reason, blocks choosing it]); others' machines may hide their inventory.
  function machineNote(node, choice, model) {
    const ai = node.ai, codexReady = ai && (ai.features || []).includes('crew-codex') && (!ai.codexSandbox || ai.codexSandbox === 'ready');
    if (!node.runCrew) return ['crew runs are off there', true];
    if (choice === 'api-key' && node.purpose === 'personal') return ['personal computer: the workspace key never goes there', true];
    if (ai && !(ai.features || []).includes('crew')) return ['update Smith there first', true];
    const tool = id => ai?.tools.find(t => t.id === id);
    if (ai && (choice === 'claude-login' || choice === 'api-key') && !tool('claude-code')) return ['Claude Code is not installed', true];
    if (ai && choice === 'claude-login' && tool('claude-code').signedIn !== true) return ['Claude Code is not signed in there', true];
    if (ai && choice === 'codex-login' && !tool('codex')) return ['Codex is not installed', true];
    if (ai && choice === 'codex-login' && !codexReady) return [(ai.features || []).includes('crew-codex') ? 'Codex’s sandbox is not set up there' : 'update Smith there for Codex', true];
    if (ai && choice === 'codex-login' && tool('codex').signedIn !== true) return ['Codex is not signed in there', true];
    if (ai && choice === 'ollama' && !ai.ollama.models.some(m => (!model || m.name === model) && !m.remote)) return [model ? `no ${model} there` : 'no local model there', true];
    if (ai && choice === 'auto' && !autoReady(node)) return ['no AI ready there', false];
    return online(node) ? ['', false] : ['offline now', false];
  }
  // Whether an automatic member could run on a machine now, as chooseCrewAi in src/crew-model.ts decides it.
  function autoReady(node) {
    const ai = node.ai; if (!ai) return true;   // another owner's machine may hide its inventory
    const codexReady = (ai.features || []).includes('crew-codex') && (!ai.codexSandbox || ai.codexSandbox === 'ready');
    const signed = id => ai.tools.some(t => t.id === id && t.signedIn === true);
    return aiOrder().some(kind => kind === 'claude' ? signed('claude-code') || (ai.tools.some(t => t.id === 'claude-code') && node.purpose !== 'personal' && Boolean(settings()?.anthropicApiKeySet))
      : kind === 'gpt' ? codexReady && signed('codex')
      : ai.ollama.models.some(m => !m.remote) && (ai.tools.some(t => t.id === 'claude-code') || (codexReady && ai.tools.some(t => t.id === 'codex'))));
  }
  const AI_NAMES = { claude: 'Claude', gpt: 'GPT', local: 'local model' };
  const aiOrder = () => settings()?.aiOrder || ['claude', 'gpt', 'local'];
  const aiOrderText = () => aiOrder().map(kind => AI_NAMES[kind]).join(', then ');
  function fillPrimary(selected) {
    const rows = projects().map(p => [p.id, p.name || p.id]);
    if (selected && !projectOf(selected)) rows.push([selected, `${selected} (no longer in this workspace)`]);
    choose($('crew-primary'), rows, selected);
  }
  // Read-only projects to tick. One the workspace no longer has is left out (the server refuses it), and the hint says
  // how many the member loses when saved.
  function fillRelated(selected) {
    const primary = $('crew-primary').value, ids = projects().map(p => p.id).filter(id => id !== primary);
    $('crew-related').replaceChildren(...ids.map(id => {
      const label = element('label', undefined, 'check'), box = element('input'); box.type = 'checkbox'; box.value = id; box.checked = selected.includes(id);
      label.append(box, document.createTextNode(` ${projectOf(id)?.name || id}`));
      return label;
    }));
    if (!ids.length) $('crew-related').append(element('p', 'No other projects in this workspace.', 'muted small'));
    if (droppedRelated) $('crew-related').append(element('p', `${droppedRelated} project${droppedRelated === 1 ? '' : 's'} it read ${droppedRelated === 1 ? 'is' : 'are'} no longer in this workspace and will be removed from its list when you save.`, 'small crew-warn'));
  }
  const relatedIds = () => [...$('crew-related').querySelectorAll('input:checked')].map(box => box.value);
  function fillVerify(selected) {
    const project = projectOf($('crew-primary').value);
    // A project added from a Git URL offers the smith.json build actions that can run here instead of products.
    const products = project?.kind === 'repo' ? (project.actions || []).filter(a => a.available).map(a => [a.id, a.label]) : (project?.products || []).map(p => [p.name, p.name]);
    choose($('crew-verify'), [['', 'No Verify builds'], ...products], selected);
  }
  // The AI choice as one list; its value names the brain and, for a sign-in, whose (brainChoice / formBody map it).
  function fillBrain(selected) {
    const keySet = Boolean(settings()?.anthropicApiKeySet), models = localModels().length;
    choose($('crew-brain'), [['auto', `Best available (${aiOrderText()})`], ['claude-login', 'This machine’s Claude Code sign-in'], ['codex-login', 'This machine’s Codex sign-in (GPT)'],
      ['api-key', keySet ? 'Workspace Anthropic API key' : 'Workspace Anthropic API key (none set yet)'],
      ['ollama', models ? 'Model on a machine' : 'Model on a machine (no crew machine has one online)', !models && selected !== 'ollama']], selected);
  }
  const brainChoice = member => member.brain === 'login' ? (member.tool === 'codex' ? 'codex-login' : 'claude-login') : member.brain;
  function fillModel(selected) {
    const models = localModels(), rows = [['', 'The machine’s largest local model'], ...models.map(name => [name, name])];
    if (selected && !models.includes(selected)) rows.push([selected, `${selected} (not on a crew machine online now)`]);
    choose($('crew-model'), rows, selected);
  }
  function fillMachine(selected) {
    const brain = $('crew-brain').value, model = brain === 'ollama' || brain === 'auto' ? $('crew-model').value : null;
    choose($('crew-machine'), [['', 'Any eligible machine'], ...machines().filter(m => m.active).map(m => {
      const [note, blocked] = machineNote(m, brain, model);
      return [m.id, `${m.hostname || 'Machine'}${note ? ` (${note})` : ''}`, blocked && m.id !== selected];
    })], selected);
  }
  function fillTrigger(trigger) {
    $('crew-trigger').value = trigger.kind; $('crew-interval').value = trigger.intervalMinutes ?? 360;
    $('crew-branch').value = trigger.branch ?? ''; $('crew-check').value = trigger.checkMinutes ?? 5;
    $('crew-skip').checked = trigger.skipIfUnchanged ?? true; $('crew-on').value = trigger.on ?? 'failed';
  }
  // Hints, and which fields apply; never rebuilds a list, so typing and ticking keep their place.
  function updateForm() {
    const creating = !editing, key = $('crew-template').value, charter = $('crew-charter');
    charter.required = !creating || key === 'custom';
    charter.placeholder = creating && key !== 'custom' ? `Leave blank to start from the ${templateLabel(key)} charter (you can edit it later), or write your own.`
      : 'For example: you look for unchecked errors in the commits listed in input/changes.md and report each one with its file and line.';
    $('crew-charter-count').textContent = `${charter.value.length.toLocaleString()} of 8,000 characters.`;
    const primaryId = $('crew-primary').value, primary = projectOf(primaryId), copy = hasSmithCopy(primary);
    // A primary project the workspace no longer has stays visible, but the form will not send it (the server refuses it).
    const gone = Boolean(primaryId) && !primary;
    $('crew-primary').setCustomValidity(gone ? `${primaryId} is no longer in this workspace. Choose the project this member works on.` : '');
    $('crew-primary-hint').textContent = !projects().length ? 'Add a project to this workspace first.'
      : gone ? `${primaryId} is no longer in this workspace. Choose another project for this member to work on.`
      : copy ? 'It checks out Smith’s copy of this project and works on its own branch.'
      : 'It checks this project out with the machine’s own Git login, as a chat does, and works on its own branch.';
    $('crew-primary-hint').classList.remove('crew-warn');
    const brain = $('crew-brain').value, ollama = brain === 'ollama', auto = brain === 'auto', usesModel = ollama || auto;
    $('crew-model-field').hidden = !usesModel; $('crew-model').disabled = !usesModel;
    $('crew-model-label').textContent = auto ? 'Local model, if it comes to that' : 'Model on machine';
    const buildMachine = machines().some(m => m.active && m.runCrew && m.purpose !== 'personal');
    const signedIn = id => machines().some(m => m.active && m.runCrew && m.ai?.tools?.some(tool => tool.id === id && tool.signedIn === true));
    const crewMachines = machines().filter(m => m.active && m.runCrew);
    $('crew-brain-hint').textContent = auto
      ? `Each run uses the first AI ready on the machine that takes it, in the workspace’s order: ${aiOrderText()} (owners and admins change it in workspace Settings). A machine with no Claude Code or Codex sign-in still runs it on a local model.${crewMachines.length && !crewMachines.some(autoReady) ? ' No machine that allows crew runs has any of them ready yet: its owner signs in from Work with AI, or starts a local model.' : ''}`
      : brain === 'claude-login'
      ? `Runs Claude Code with the sign-in of the machine it runs on, on machines whose owners allow crew runs and where Claude Code is signed in.${signedIn('claude-code') ? '' : ' No machine that allows crew runs has Claude Code signed in yet: its owner signs in from Work with AI and turns crew runs on in its card under Machines.'}`
      : brain === 'codex-login'
      ? `Runs Codex (GPT) with the sign-in of the machine it runs on, inside Codex’s sandbox with no network.${signedIn('codex') ? '' : ' No machine that allows crew runs has Codex signed in yet: its owner signs in from Work with AI and turns crew runs on in its card under Machines.'}`
      : ollama
      ? (localModels().length ? 'Runs Claude Code (or Codex, if that is all the machine has) with a model running on a machine whose owner allows crew runs. Cloud models are never used.'
        : 'No machine that allows crew runs has a model running on it. A machine’s owner turns crew runs on in its card under Machines.')
      : `Billed to the workspace’s Anthropic API key, on build machines whose owners allow crew runs.${settings()?.anthropicApiKeySet ? '' : ' No key is set yet: an owner or admin adds one in workspace Settings, and runs are refused until then.'}${buildMachine ? '' : ' No build machine allows crew runs yet: its owner turns that on in its card under Machines.'}`;
    $('crew-mode-hint').textContent = $('crew-mode').value === 'plan' ? 'Reads the project and reports findings. It changes nothing.'
      : 'Edits files on its own branch only, with no network (Claude Code: no shell either; Codex: commands only inside its sandbox). A person reviews every change.';
    const kind = $('crew-trigger').value;
    $('crew-interval-field').hidden = kind !== 'interval'; $('crew-interval').disabled = kind !== 'interval'; $('crew-interval').required = kind === 'interval';
    $('crew-skip-field').hidden = kind !== 'interval'; $('crew-on-field').hidden = kind !== 'buildFinished'; $('crew-on').disabled = kind !== 'buildFinished';
    const watch = kind === 'branchChanged';
    for (const id of ['crew-branch-field', 'crew-check-field', 'crew-branch-hint']) $(id).hidden = !watch;
    $('crew-branch').disabled = !watch; $('crew-check').disabled = !watch; $('crew-check').required = watch;
    $('crew-branch').placeholder = primary?.branch || 'the project’s branch';
    const branch = $('crew-branch').value.trim();
    $('crew-branch').setCustomValidity(watch && /^smith\//i.test(branch) ? 'Smith’s own smith/… branches cannot be watched: the crew’s pushes would wake it.' : '');
    $('crew-branch-hint').textContent = `Smith looks at ${branch ? `branch ${branch}` : `${primary?.branch ? `branch ${primary.branch}` : 'the project’s branch'}`} every ${Number($('crew-check').value) || 5} minutes, with a machine’s own Git login, and runs this member when it has commits the member has not seen. A look that finds nothing new is not a run. It starts from that branch’s tip.`;
    const allowed = Boolean(settings()?.crewMayCreateProjects);
    $('crew-may-create-projects').disabled = !allowed || !isAdmin() || !copyAvailable();
    $('crew-may-create-hint').textContent = !copyAvailable() ? 'Not available on this Smith service yet.' : !allowed ? 'An owner or admin must allow this in Workspace settings.' : !isAdmin() ? 'Only workspace owners and admins can grant this.'
      : 'It may then create a Smith project with its own repository, to share a tool with the crew.';
    $('crew-enabled').disabled = false; $('crew-enabled').checked = wantEnabled;
    $('crew-enabled-hint').textContent = '';
    const locked = Boolean(editing?.mayCreateProjects) && !isAdmin();
    $('crew-form-hint').textContent = locked ? 'Only workspace owners and admins can edit a crew member that may create projects.' : !projects().length ? 'Add a project to this workspace first.' : '';
    $('submit-crew').disabled = locked || !projects().length;
  }
  function applyTemplate() {
    const next = CREW_TEMPLATE_DEFAULTS[$('crew-template').value], before = CREW_TEMPLATE_DEFAULTS[template];
    const name = $('crew-name').value.trim();
    if (!name || name === before.name) $('crew-name').value = next.name;
    $('crew-mode').value = next.permissionMode; fillTrigger(next.trigger); $('crew-attach-shared').checked = next.attachSharedProjects;
    const key = $('crew-template').value;
    if (key.endsWith('-reviewer')) { $('crew-event-preset').value = key; applyEventPreset(); }
    else { $('crew-event-preset').value = ''; $('crew-orchestration').value = ''; }
    template = $('crew-template').value; updateForm();
  }
  function openDialog(member) {
    editing = member ?? null; dialogKey = member ? `${member.id}:edit` : 'new';
    const start = CREW_TEMPLATE_DEFAULTS.standards, models = localModels();
    const seed = member ?? { name: start.name, charter: '', projectIds: [projects()[0]?.id ?? ''], attachSharedProjects: start.attachSharedProjects,
      brain: start.brain, model: null, nodeId: null, permissionMode: start.permissionMode,
      trigger: start.trigger, budget: DEFAULT_BUDGET, verifyProduct: null, mayCreateProjects: false, mayMessage: true, enabled: true };
    template = 'standards'; $('crew-template').value = template; $('crew-template-field').hidden = Boolean(member);
    $('crew-dialog-title').textContent = member ? `Edit ${member.name}` : 'New crew member';
    $('submit-crew').textContent = member ? 'Save changes' : 'Create crew member';
    $('crew-name').value = seed.name; $('crew-charter').value = seed.charter;
    droppedRelated = missingProjects(seed.projectIds.slice(1), projects()).length;
    fillPrimary(seed.projectIds[0] ?? ''); fillRelated(seed.projectIds.slice(1)); fillVerify(seed.verifyProduct ?? '');
    $('crew-attach-shared').checked = seed.attachSharedProjects;
    fillBrain(brainChoice(seed)); fillModel(seed.model ?? ''); fillMachine(seed.nodeId ?? '');
    $('crew-mode').value = seed.permissionMode; fillTrigger(seed.trigger);
    $('crew-usd').value = seed.budget.usdPerRun; $('crew-minutes').value = seed.budget.maxMinutes;
    $('crew-runs-per-day').value = seed.budget.runsPerDay; $('crew-builds-per-day').value = seed.budget.buildsPerDay;
    $('crew-may-message').checked = seed.mayMessage; $('crew-may-create-projects').checked = seed.mayCreateProjects;
    $('crew-orchestration').value = seed.orchestration ? JSON.stringify(seed.orchestration, null, 2) : '';
    $('crew-event-preset').value = '';
    wantEnabled = seed.enabled; updateForm();
    $('crew-dialog').showModal(); (member ? $('crew-name') : $('crew-template')).focus();
  }
  function formBody() {
    const kind = $('crew-trigger').value, brain = $('crew-brain').value, charter = $('crew-charter').value;
    const trigger = kind === 'interval' ? { kind, intervalMinutes: Math.round(Number($('crew-interval').value)), skipIfUnchanged: $('crew-skip').checked }
      : kind === 'buildFinished' ? { kind, on: $('crew-on').value }
      : kind === 'branchChanged' ? { kind, branch: $('crew-branch').value.trim(), checkMinutes: Math.round(Number($('crew-check').value)) } : { kind };
    const ai = brain === 'claude-login' ? { tool: 'claude-code', brain: 'login' } : brain === 'codex-login' ? { tool: 'codex', brain: 'login' }
      : brain === 'api-key' ? { tool: 'claude-code', brain } : { tool: 'auto', brain };
    return {
      ...(editing ? { id: editing.id } : { template: $('crew-template').value }),
      name: $('crew-name').value.trim(), ...(charter.trim() ? { charter } : {}),
      projectIds: [$('crew-primary').value, ...relatedIds()], attachSharedProjects: $('crew-attach-shared').checked,
      ...ai, model: brain === 'ollama' || brain === 'auto' ? $('crew-model').value || null : null, nodeId: $('crew-machine').value || null,
      permissionMode: $('crew-mode').value, trigger,
      budget: { usdPerRun: Number($('crew-usd').value), maxMinutes: Math.round(Number($('crew-minutes').value)),
        runsPerDay: Math.round(Number($('crew-runs-per-day').value)), buildsPerDay: Math.round(Number($('crew-builds-per-day').value)) },
      verifyProduct: $('crew-verify').value || null, mayCreateProjects: $('crew-may-create-projects').checked, mayMessage: $('crew-may-message').checked,
      enabled: $('crew-enabled').checked,
      orchestration: parseMemberPolicy($('crew-orchestration').value),
    };
  }

  // ---- Machine cards: the owner's two opt-ins -----------------------------------------------------------------
  function renderMachineToggles(row, node) {
    if (!node.ownedByYou || !node.active) return;
    const personal = node.purpose === 'personal';
    const toggle = (text, checked, className) => {
      const label = element('label', undefined, `muted small share${className ? ` ${className}` : ''}`), box = element('input');
      box.type = 'checkbox'; box.checked = checked; label.append(box, document.createTextNode(` ${text}`)); row.append(label);
      return box;
    };
    const runs = toggle('Run crew members on this machine', node.runCrew);
    // Personal computers never build, so only build machines ask whether crew runs may share the machine with a build.
    const building = personal ? null : toggle('even while a build runs', node.crewWhileBuilding, 'crew-sub');
    // Its visible text continues the line above it; on its own it needs the whole sentence.
    if (building) { building.disabled = !node.runCrew; building.setAttribute('aria-label', 'Run crew members even while a build runs'); }
    row.append(element('p', personal ? 'A crew member runs here with this machine’s Claude Code or Codex sign-in, or a model on this machine; the workspace’s Anthropic key never comes here. Projects without Smith’s copy are checked out and pushed with this computer’s Git login, as chats are. Owners choose which machines run crew.'
      : 'A crew member runs with this machine’s Claude Code or Codex sign-in, the workspace’s Anthropic API key, or a model on this machine. Projects without Smith’s copy are checked out and pushed with this machine’s Git login, as chats are. Owners choose which machines run crew.', 'muted small'));
    const save = box => action(box, async () => {
      const current = generation();
      let saved;
      try { saved = await api(`${base()}/nodes/${encodeURIComponent(node.id)}/crew`, { run: runs.checked, whileBuilding: Boolean(runs.checked && building?.checked) }); }
      catch (error) { box.checked = !box.checked; throw error; }
      if (current !== generation()) return;
      node.runCrew = saved.runCrew; node.crewWhileBuilding = saved.crewWhileBuilding;
      if (building) { building.checked = saved.crewWhileBuilding; building.disabled = !saved.runCrew; }
      memberSnapshot = ''; renderMembers();
    });
    runs.addEventListener('change', () => save(runs));
    building?.addEventListener('change', () => save(building));
  }

  // ---- Refresh and reset ------------------------------------------------------------------------------------------
  // A card's status comes from its member's newest run. Run lists are fetched again when stale, while a run is in
  // flight, once a scheduled run fell due, and always for the member that is open.
  function runsDue(member, now) {
    const known = runsBy.get(member.id);
    return !known || member.id === open || now - known.at > RUNS_MAX_AGE || ACTIVE_RUNS.has(known.runs[0]?.state)
      || (member.nextRunAt !== null && member.nextRunAt <= now && member.nextRunAt > known.at);
  }
  async function refresh() {
    const current = generation();
    const list = await api(`${base()}/crew`);
    if (current !== generation()) return;
    members = list.members; names = { ...names, ...list.names };
    for (const id of runsBy.keys()) if (!memberOf(id)) runsBy.delete(id);
    if (filter && !projectOf(filter)) filter = null;
    if (open && !memberOf(open)) { open = null; await selectRun(null); }
    // Each member's runs on their own: one that fails keeps its last list and says so on its card.
    const now = Date.now(), due = members.filter(m => runsDue(m, now));
    const results = await Promise.allSettled(due.map(m => api(`${crewPath(m.id)}/runs`)));
    if (current !== generation()) return;
    due.forEach((member, index) => {
      const result = results[index];
      if (result.status === 'fulfilled') { runsBy.set(member.id, { runs: result.value.runs, at: now }); runErrors.delete(member.id); }
      else runErrors.set(member.id, result.reason?.message || 'The request failed.');
    });
    for (const id of runErrors.keys()) if (!memberOf(id)) runErrors.delete(id);
    renderMembers(); renderDetail();
    if (openRun && runNeedsPolling(runSession, runsOf(open).find(run => run.sessionId === openRun)?.state)) { await refreshRun(); if (current !== generation()) return; }
    if (openRun) renderReport();
    await refreshList();
  }
  function reset() {
    members = []; names = {}; runsBy = new Map(); runErrors = new Map(); open = null; filter = null; editing = null; focusKey = null;
    memberSnapshot = ''; detailSnapshot = ''; runsSnapshot = '';
    void selectRun(null);
    $('crew-members').replaceChildren(element('p', 'Loading the crew…', 'empty small'));
    $('crew-detail').hidden = true; review.reset(); messages.reset(); events.reset();
    $('crew-notice').hidden = true; $('crew-filter').hidden = true; $('new-crew-member').hidden = true;
    $('crew-dialog').close(); $('crew-prompt-dialog').close();
    showTab('members');
  }

  // ---- Wiring -------------------------------------------------------------------------------------------------
  $('crew-template').replaceChildren(...Object.entries(CREW_TEMPLATE_DEFAULTS).map(([key, value]) => option(key, value.label)));
  $('new-crew-member').dataset.focus = 'new';
  $('new-crew-member').addEventListener('click', () => openDialog(null));
  $('close-crew-dialog').addEventListener('click', () => $('crew-dialog').close());
  $('crew-dialog').addEventListener('close', () => { editing = null; restoreFocus(dialogKey); });
  $('close-crew-prompt').addEventListener('click', () => $('crew-prompt-dialog').close());
  $('crew-prompt-dialog').addEventListener('close', () => restoreFocus(promptKey));
  $('crew-template').addEventListener('change', applyTemplate);
  function applyEventPreset() {
    const key = $('crew-event-preset').value;
    if (!key) return;
    const [unitCost, costClass] = ({ 'standards-reviewer': [1, 'cheap'], 'cleanup-reviewer': [1, 'cheap'], 'bug-hunter': [2, 'medium'], 'test-reviewer': [2, 'medium'], 'security-reviewer': [4, 'expensive'], 'architecture-reviewer': [5, 'expensive'] })[key];
    $('crew-mode').value = 'plan';
    $('crew-orchestration').value = JSON.stringify({ mode: 'read_only', events: ['commit', 'push', 'pr_updated', 'pr_ready', 'test_failure', 'merge', 'release_candidate', 'manual'], costClass, unitCost, writeScopes: [], canRequest: [], cooldownMs: 0, debounceMs: 0, maxDebounceWaitMs: 300000, maxJitterMs: 0, priority: 'normal' }, null, 2);
    updateForm();
  }
  $('crew-event-preset').addEventListener('change', applyEventPreset);
  $('crew-primary').addEventListener('change', () => { fillRelated(relatedIds()); fillVerify($('crew-verify').value); updateForm(); });
  $('crew-brain').addEventListener('change', () => { fillModel($('crew-model').value); fillMachine($('crew-machine').value); updateForm(); });
  $('crew-model').addEventListener('change', () => { fillMachine($('crew-machine').value); updateForm(); });
  for (const id of ['crew-mode', 'crew-trigger']) $(id).addEventListener('change', updateForm);
  $('crew-charter').addEventListener('input', updateForm);
  for (const id of ['crew-branch', 'crew-check']) $(id).addEventListener('input', updateForm);
  $('crew-enabled').addEventListener('change', () => { wantEnabled = $('crew-enabled').checked; });
  $('crew-form').addEventListener('submit', event => {
    event.preventDefault();
    void action($('submit-crew'), async () => {
      const current = generation();
      const saved = await api(`${base()}/crew`, formBody());
      if (current !== generation()) return;
      $('crew-dialog').close();
      runsBy.delete(saved.id); await refresh();
      restoreFocus(dialogKey);   // an Edit button re-rendered while the dialog was open
    });
  });
  $('crew-detail-close').addEventListener('click', () => {
    const id = open; open = null; void selectRun(null); renderDetail(); memberSnapshot = ''; renderMembers();
    restoreFocus(`${id}:open`);
  });
  $('crew-run-stop').addEventListener('click', () => action($('crew-run-stop'), async () => {
    if (!openRun) return;
    await api(`${runPath(openRun)}/stop`, {}); runsBy.delete(open); await refresh();
  }));
  $('crew-filter-clear').addEventListener('click', () => { filter = null; memberSnapshot = ''; renderMembers(); $('crew-tab-members').focus(); });
  for (const key of TABS) {
    const button = $(`crew-tab-${key}`); button.dataset.focus = `tab:${key}`;
    // The panel switches at once; its list loads behind it, and a failure shows the server's message.
    button.addEventListener('click', () => { showTab(key); void press(button, refresh); });
  }
  $('crew-tabs').addEventListener('keydown', event => {
    const index = TABS.indexOf(tab);
    const next = { ArrowRight: (index + 1) % TABS.length, ArrowLeft: (index + TABS.length - 1) % TABS.length, Home: 0, End: TABS.length - 1 }[event.key];
    if (next === undefined) return;
    event.preventDefault(); $(`crew-tab-${TABS[next]}`).focus(); $(`crew-tab-${TABS[next]}`).click();
  });
  return { refresh, reset, renderMachineToggles, renderProjectCrew, renderCreatedBy, getMembers: () => members.map(member => structuredClone(member)) };
}
