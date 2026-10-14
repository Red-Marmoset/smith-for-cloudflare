'use strict';

const REASONS = {
  github_file_limit: 'GitHub’s changed-file list reached its limit. Metadata is incomplete.',
  unverified_ancestor: 'The commit history diverged or could not be verified.',
  metadata_timeout: 'Reading change metadata timed out. Retry when the provider is available.',
  metadata_size_limit: 'Change metadata exceeded the size limit.',
  agent_update_required: 'Update the Smith agent to support pinned check-in runs.',
  lease_conflict: 'Another writer holds an overlapping scope on this branch.',
  lease_quarantined: 'A disconnected writer must finish before its scope can be reused.',
  metadata_incomplete: 'Change metadata is incomplete; automatic work is blocked.',
};
export const reasonText = reason => REASONS[reason] || reason || '';
export function eventView(event, projectName = '') {
  return { id: event.id, title: `${projectName || event.project_id} · ${event.kind} · ${event.branch}`, state: event.state,
    range: `${event.base_commit} → ${event.head_commit}`, reason: reasonText(event.reason), delivery: `${event.source} · ${event.delivery_id}` };
}
export function findingView(finding) {
  const value = finding.value || finding;
  return { title: value.title || 'Finding', detail: value.detail || '', files: value.files || (value.file ? [value.file] : []),
    confidence: typeof value.confidence === 'number' ? `Confidence ${Math.round(value.confidence * 100)}%` : 'Confidence unknown',
    hold: finding.disposition === 'merge_blocking' ? 'Internal review hold only; GitHub merge checks are unchanged.' : '' };
}
export function parseMemberPolicy(text) {
  if (!text.trim()) return null;
  let value;
  try { value = JSON.parse(text); } catch { throw new Error('Enter valid JSON for the check-in policy.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The check-in policy must be a JSON object. Leave it blank to turn it off.');
  return value;
}
export function parseWorkspacePolicy(text, enabled, limits, projectAutomation) {
  const policy = { ...(parseMemberPolicy(text) || {}), enabled };
  if (limits) {
    const limit = (key, minimum) => {
      const raw = limits[key], value = Number(raw);
      if (raw === null || raw === undefined || String(raw).trim() === '' || !Number.isSafeInteger(value) || value < minimum || value > 10000)
        throw new Error(`Invalid ${key} limit: enter a whole number from ${minimum} to 10000.`);
      return value;
    };
    policy.concurrency = { cheap: limit('cheap', 0), medium: limit('medium', 0), expensive: limit('expensive', 0) };
    policy.globalStartsPerHour = limit('startsPerHour', 1);
  }
  if (projectAutomation) {
    policy.projectRules = { ...policy.projectRules };
    for (const [id, automation] of Object.entries(projectAutomation)) {
      policy.projectRules[id] = { ...policy.projectRules[id] };
      if (automation === null) delete policy.projectRules[id].automation;
      else policy.projectRules[id].automation = automation;
    }
  }
  return policy;
}

export function renderProjectAutomation({ container, projects, policy, members = [], element, editable }) {
  const readers = [];
  container.replaceChildren();
  for (const [index, project] of projects.entries()) {
    const configured = policy?.projectRules?.[project.id]?.automation || {};
    const hasPolicy = Boolean(policy?.projectRules?.[project.id]?.automation);
    const inputs = [];
    const box = element('fieldset', undefined, 'crew-setting');
    box.append(element('legend', project.name || project.id));
    const field = (key, label, value, options) => {
      const wrap = element('div', undefined, 'field'), id = `project-automation-${index}-${key}`;
      const caption = element('label', label); caption.setAttribute('for', id);
      const input = element(options ? 'select' : 'input'); input.id = id; input.disabled = !editable || !hasPolicy; inputs.push(input);
      if (options) for (const [value, text] of options) { const option = element('option', text); option.value = value; input.append(option); }
      else input.type = 'text';
      input.value = value; wrap.append(caption, input); box.append(wrap); return input;
    };
    const apply = field('apply', 'Use project finding policy', ''); apply.type = 'checkbox'; apply.checked = hasPolicy; apply.disabled = !editable;
    box.append(element('p', 'Unchecked preserves existing member scheduling. Enable to configure this project; new policies start in Report only. Turning it off removes this project’s automation policy.', 'muted small'));
    const mode = field('mode', 'Finding automation', configured.mode || 'report_only', [['report_only', 'Report only'], ['suggest', 'Suggest — allow requested actions'], ['automatic_fix', 'Automatically request fixes']]);
    const eligible = members.filter(member => member.enabled && member.projectIds?.[0] === project.id && member.permissionMode === 'acceptEdits' && member.orchestration?.mode === 'write' && member.orchestration.writeScopes?.length);
    const target = (key, label, selected) => {
      const input = field(key, label, selected || '', [['', 'Not configured'], ...eligible.map(member => [member.id, member.name || member.id])]);
      if (selected && !eligible.some(member => member.id === selected)) {
        const option = element('option', `${members.find(member => member.id === selected)?.name || selected} (unavailable)`); option.value = selected; option.disabled = true; input.append(option);
      }
      input.value = selected || ''; return input;
    };
    const fixer = target('fixer', 'Fixer crew member', configured.fixerCrewId);
    const tester = target('tester', 'Regression test crew member', configured.testCrewId);
    const help = element('p', 'Targets must be enabled writers whose primary project is this project, with explicit write permissions and directory scopes. Configure eligible members in Crew. Unavailable saved targets are retained until you choose a replacement.', 'muted small');
    help.id = `project-automation-${index}-targets-help`; box.append(help);
    fixer.setAttribute('aria-describedby', help.id); tester.setAttribute('aria-describedby', help.id);
    const number = (key, label, value, max) => { const input = field(key, label, value); input.type = 'number'; input.min = '1'; input.max = String(max); input.step = '1'; input.required = true; return input; };
    const fixes = number('fixes', 'Maximum fix attempts', configured.maxFixAttempts ?? 1, 5);
    const verify = field('verify', 'Automatically verify proposals', ''); verify.type = 'checkbox'; verify.checked = configured.verification?.enabled === true;
    const attempts = number('attempts', 'Maximum verification attempts', configured.verification?.maxAttempts ?? 1, 5);
    const timeout = number('timeout', 'Verification timeout (minutes)', configured.verification?.timeoutMinutes ?? 10, 60);
    const verifyHelp = element('p', 'Verification requires an approved Verify product and a machine labelled crew-verify-isolated. The label is an operator assertion of isolation; it does not create a sandbox.', 'muted small');
    verifyHelp.id = `project-automation-${index}-verify-help`; verify.setAttribute('aria-describedby', verifyHelp.id); box.append(verifyHelp);
    apply.addEventListener('change', () => { for (const input of inputs) if (input !== apply) input.disabled = !editable || !apply.checked; });
    readers.push(() => {
      if (!apply.checked) return hasPolicy ? [project.id, null] : null;
      const bounded = (input, max, label) => { const value = Number(input.value); if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`${project.name || project.id}: ${label} must be a whole number from 1 to ${max}.`); return value; };
      if (!['report_only', 'suggest', 'automatic_fix'].includes(mode.value)) throw new Error('Choose a valid finding automation mode.');
      return [project.id, { mode: mode.value, fixerCrewId: fixer.value.trim() || null, testCrewId: tester.value.trim() || null, maxFixAttempts: bounded(fixes, 5, 'Fix attempts'), verification: { enabled: verify.checked, maxAttempts: bounded(attempts, 5, 'Verification attempts'), timeoutMinutes: bounded(timeout, 60, 'Verification timeout') } }];
    });
    container.append(box);
  }
  if (!projects.length) container.append(element('p', 'Add a project to configure finding automation.', 'muted small'));
  return () => Object.fromEntries(readers.map(read => read()).filter(Boolean));
}

export function createEvents({ $, api, base, element, action, date, projects, members, canManage, generation }) {
  let selected = null, nextCursor = null, rows = [], epoch = 0, snapshot = '';
  const actionRequests = new Map();
  const root = () => `${base()}/crew/checkins`;
  const eventPath = id => `${root()}/${encodeURIComponent(id)}`;
  const memberName = id => members().find(member => member.id === id)?.name || id;
  function button(label, task, className = 'quiet') {
    const node = element('button', label, className); node.type = 'button';
    node.addEventListener('click', () => action(node, task)); return node;
  }
  function renderList() {
    const current = JSON.stringify([rows, projects(), canManage()]);
    if (snapshot === current) return; snapshot = current;
    $('crew-events-list').replaceChildren(...rows.map(event => {
      const view = eventView(event, projects().find(p => p.id === event.project_id)?.name);
      const card = element('article', undefined, 'crew-event-card');
      card.append(button(view.title, () => open(event.id), 'build-link'), element('span', view.state, 'badge'), element('p', view.range, 'crew-event-range'), element('p', `${date(event.created_at)} · ${view.delivery}`, 'muted small'));
      if (view.reason) card.append(element('p', view.reason, 'crew-warn small'));
      return card;
    }));
    if (!rows.length) $('crew-events-list').append(element('p', 'No check-ins yet. Submit an exact commit range or configure a signed GitHub webhook in Settings.', 'empty small'));
  }
  function renderDetail(data) {
    const { event } = data, view = eventView(event, projects().find(p => p.id === event.project_id)?.name);
    const panel = $('crew-event-detail'); panel.hidden = false; panel.replaceChildren();
    panel.append(element('h3', view.title), element('p', view.range, 'crew-event-range'), element('p', `Event ${event.id} · ${view.state}`, 'muted small'));
    if (view.reason) panel.append(element('p', view.reason, 'crew-warn'));
    const controls = element('div', undefined, 'crew-actions');
    controls.append(button('Close event', async () => { selected = null; epoch++; panel.hidden = true; }));
    if (canManage()) {
      controls.append(button('Dry run selection', async () => {
        const id = selected, current = generation();
        const result = await api(`${eventPath(id)}/dry-run`, {});
        if (generation() !== current || selected !== id) return;
        const output = element('pre', JSON.stringify(result, null, 2), 'crew-event-json');
        panel.append(element('h4', 'Dry run: no work started'), output);
      }));
      if (['blocked', 'pending'].includes(event.state)) controls.append(button('Retry metadata', async () => {
        const id = selected, current = generation(); await api(`${eventPath(id)}/retry`, {});
        if (generation() === current && selected === id) await open(id);
      }));
    }
    panel.append(controls);
    const section = (title, items, render) => {
      panel.append(element('h4', title, 'crew-subheading'));
      if (!items?.length) panel.append(element('p', 'None yet.', 'muted small'));
      else for (const item of items) panel.append(render(item));
    };
    const p = text => element('p', text, 'small');
    section('Agent decisions', data.decisions, d => {
      const box = element('div', undefined, 'crew-event-card');
      box.append(p(`${memberName(d.crew_id)} · ${d.status} · ${reasonText(d.reason)}`));
      const facts = element('details'); facts.append(element('summary', 'Matched facts and policy'), element('pre', JSON.stringify(d.facts, null, 2), 'crew-event-json')); box.append(facts); return box;
    });
    section('Runs and measured cost', data.runs, run => {
      const row = p(`${memberName(run.crew_id)} · ${run.state}${run.wait_reason ? ' · ' + reasonText(run.wait_reason) : ''} · ${run.cost_usd == null ? 'Cost unknown' : '$' + Number(run.cost_usd).toFixed(2)} · Run ${run.id}`);
      row.id = `crew-event-run-${run.id}`; return row;
    });
    section('Finding actions', data.actions, item => {
      const box = element('div', undefined, 'crew-event-card');
      box.append(p(`${item.kind === 'fix' ? 'Fix' : 'Regression test'} · ${item.state} · ${memberName(item.target_crew_id)} · Finding ${item.finding_id}`));
      if (item.reason) box.append(p(reasonText(item.reason)));
      if (item.verify_job_id) box.append(p(`Verification ${item.verify_job_id} · ${item.verification_state || 'State unavailable'}`));
      if (item.run_id) {
        const run = data.runs?.find(run => run.id === item.run_id);
        const link = element(run ? 'a' : 'span', `Run ${item.run_id}${run ? ' · ' + run.state : ''}`);
        if (run) { link.href = `#crew-event-run-${item.run_id}`; link.addEventListener('click', event => { event.preventDefault(); document.getElementById(`crew-event-run-${item.run_id}`)?.scrollIntoView({ block: 'center' }); }); }
        box.append(link);
      }
      box.append(p(`Action ${item.id} · ${date(item.created_at)}`)); return box;
    });
    panel.append(element('h4', 'Event budget', 'crew-subheading'), p(`Allowance: ${event.allowance ?? 0} units. Units measure scheduling weight; monetary cost is shown separately.`));
    section('Unit reservations and usage', data.budget, item => p(`${item.units} units · ${item.state} · Run ${item.run_id}`));
    section('Writer scopes and leases', data.leases, lease => p(`${lease.state} · ${lease.branch} · ${lease.scopes} · generation ${lease.generation} · expires ${date(lease.expires_at)} · Run ${lease.run_id}`));
    section('Review requests', data.requests, request => p(`${memberName(request.target_crew_id)} · ${request.state} · ${request.reason} · ${request.detail} · From run ${request.source_run_id}`));
    section('Findings', data.findings, finding => {
      const value = findingView(finding), box = element('article', undefined, 'crew-event-card');
      box.append(element('strong', value.title), p(value.detail), p(value.files.join(', ')), p(`${value.confidence} · ${finding.disposition}`));
      if (value.hold) box.append(p(value.hold));
      if (canManage()) {
        const feedback = element('p', '', 'muted small'); feedback.setAttribute('role', 'status');
        const actions = element('div', undefined, 'crew-actions');
        for (const [kind, label] of [['fix', 'Request fix'], ['regression_test', 'Add regression test']]) {
          actions.append(button(label, async () => {
            const id = event.id, selectedId = selected, current = generation(), key = JSON.stringify([current, id, finding.id, kind]);
            if (!actionRequests.has(key)) actionRequests.set(key, crypto.randomUUID());
            feedback.textContent = 'Requesting…';
            try {
              const result = await api(`${base()}/crew/findings/${encodeURIComponent(finding.id)}/action`, { eventId: id, kind, requestId: actionRequests.get(key) });
              if (generation() !== current || selected !== selectedId) return;
              if (result.state === 'refused') { feedback.textContent = reasonText(result.reason) || 'Action refused.'; return; }
              await open(selectedId);
            } catch (error) { if (generation() === current && selected === selectedId) feedback.textContent = error.message || 'Could not request action. Try again.'; }
          }));
        }
        box.append(actions, feedback);
        const select = element('select'); select.setAttribute('aria-label', `Disposition for ${value.title}`);
        for (const disposition of ['no_action', 'second_review', 'fixer_requested', 'merge_blocking', 'human_review', 'resolved', 'dismissed']) { const option = element('option', disposition.replaceAll('_', ' ')); option.value = disposition; select.append(option); }
        select.value = finding.disposition;
        box.append(select, button('Save disposition', async () => {
          const id = selected, current = generation(); await api(`${base()}/crew/findings/${encodeURIComponent(finding.id)}/decide`, { disposition: select.value });
          if (generation() === current && selected === id) await open(id);
        }));
      }
      return box;
    });
    section('Verified changed files', event.metadata?.changes, change => p(`${change.oldPath ? change.oldPath + ' → ' : ''}${change.path} · +${change.added ?? '?'} −${change.deleted ?? '?'}`));
    panel.append(p(`Tests: ${event.metadata?.testState || 'unknown'} · Metadata complete: ${event.metadata?.complete === true ? 'yes' : 'no'} · Ancestry verified: ${event.metadata?.ancestor === true ? 'yes' : 'no'}`));
    section('Deliveries included', data.deliveries, delivery => p(`${delivery.source} · ${delivery.delivery_id}`));
  }
  async function open(id) {
    selected = id; const version = ++epoch, current = generation();
    const data = await api(eventPath(id));
    if (version !== epoch || current !== generation()) return;
    renderDetail(data);
  }
  async function refresh(more = false) {
    const current = generation(), version = epoch;
    const result = await api(root() + (more && nextCursor ? `?before=${encodeURIComponent(nextCursor)}` : ''));
    if (current !== generation() || version !== epoch) return;
    rows = more ? [...rows, ...result.events] : result.events; nextCursor = result.nextCursor;
    $('crew-events-more').hidden = !nextCursor; $('crew-checkin-form').hidden = !canManage();
    const select = $('crew-checkin-project'), selectedProject = select.value;
    select.replaceChildren(...projects().map(project => { const option = element('option', project.name || project.id); option.value = project.id; return option; }));
    if (projects().some(p => p.id === selectedProject)) select.value = selectedProject;
    renderList();
    if (selected && !more && !$('crew-event-detail').contains(document.activeElement)) await open(selected);
  }
  $('crew-events-more').addEventListener('click', () => action($('crew-events-more'), () => refresh(true)));
  $('crew-checkin-form').addEventListener('submit', event => {
    event.preventDefault();
    void action($('crew-checkin-submit'), async () => {
      const current = generation(), form = $('crew-checkin-form');
      const body = { projectId: $('crew-checkin-project').value, branch: $('crew-checkin-branch').value.trim(), baseCommit: $('crew-checkin-base').value.trim(), headCommit: $('crew-checkin-head').value.trim(), kind: $('crew-checkin-kind').value };
      const key = JSON.stringify(body);
      if (form.dataset.payload !== key) { form.dataset.payload = key; form.dataset.delivery = crypto.randomUUID(); }
      const result = await api(root(), { ...body, deliveryId: form.dataset.delivery });
      if (current !== generation()) return;
      await refresh(); await open(result.eventId);
    });
  });
  return { refresh, reset() { actionRequests.clear(); selected = null; nextCursor = null; rows = []; snapshot = ''; epoch++; $('crew-events-list').replaceChildren(); $('crew-event-detail').hidden = true; $('crew-checkin-form').hidden = true; $('crew-checkin-form').reset(); delete $('crew-checkin-form').dataset.delivery; delete $('crew-checkin-form').dataset.payload; } };
}
