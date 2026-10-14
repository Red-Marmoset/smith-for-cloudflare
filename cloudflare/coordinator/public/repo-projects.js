'use strict';
// Cards for projects added from a Git URL: their smith.json build actions, or why those are not
// known yet (waiting for a machine that can read the repository, or a read error).

const PLATFORMS = { windows: 'Windows', linux: 'Linux', mac: 'macOS' };
// The repository people know: once a project builds from Smith's copy its repoUrl is the copy's
// address, so show the repository it was copied from.
export function shownRepoUrl(project) {
  const copy = project.artifacts, hosted = project.hosted;
  if (hosted?.status === 'ready' && hosted.sourceRepoUrl && /\/git\/[a-z0-9][a-z0-9-]{0,63}\.git$/.test(project.repoUrl || '')) return linkedUrl({ remote: project.repoUrl, sourceRepoUrl: hosted.sourceRepoUrl }) || project.repoUrl;
  return copy?.status === 'done' && copy.remote === project.repoUrl && copy.sourceRepoUrl ? copy.sourceRepoUrl : project.repoUrl || '';
}

// The repository a copy is linked to: '' once detached, or for a crew-made project (whose source is the copy itself).
export function linkedUrl(copy) {
  const url = copy?.sourceRepoUrl || '';
  return url && url !== copy.remote && !/\.artifacts\.cloudflare\.net\//.test(url) && !isSmithRemote(url) ? url : '';
}
// Smith's own copy of a project is served from this site: <origin>/git/<project>.git.
function isSmithRemote(url) { return typeof url === 'string' && typeof location !== 'undefined' && url.startsWith(location.origin + '/git/') && /\/git\/[a-z0-9][a-z0-9-]{0,63}\.git$/.test(url); }
// The copy a project builds from, whichever kind (as copyOf in src/upstream.ts): Smith's own machines or Cloudflare Artifacts.
export function copyOf(project) {
  if (project?.home === 'artifacts' && project.artifacts?.status === 'done') return { kind: 'artifacts', remote: location.origin + '/git/' + project.id + '.git', sourceRepoUrl: project.artifacts.sourceRepoUrl, detachedFrom: project.artifacts.detachedFrom, sync: project.artifacts.sync };
  const hosted = project?.hosted;
  if (hosted?.status === 'ready' && isSmithRemote(project.repoUrl)) return { kind: 'hosted', remote: project.repoUrl, sourceRepoUrl: hosted.sourceRepoUrl, detachedFrom: hosted.detachedFrom, sync: hosted.sync };
  const copy = project?.artifacts;
  if (copy?.status === 'done' && project.repoUrl === copy.remote) return { kind: 'artifacts', remote: copy.remote, sourceRepoUrl: copy.sourceRepoUrl, detachedFrom: copy.detachedFrom, sync: copy.sync };
  return undefined;
}
export function hostName(url) {
  const host = (/^(?:https:\/\/|ssh:\/\/(?:[^@/]+@)?|[^@]+@)([^/:]+)/.exec(url)?.[1] || '').toLowerCase();
  return { 'github.com': 'GitHub', 'gitlab.com': 'GitLab', 'bitbucket.org': 'Bitbucket' }[host] || host || 'the linked repository';
}

// The repository has no smith.json: say what Smith detected and show the default it builds with, ready to commit as the
// project's own smith.json when it needs more (src/detect.ts).
export function detectedNote(detected, element) {
  const note = element('div', undefined, 'detected');
  note.append(element('p', `No smith.json: Smith detected ${detected.summary} and builds it with defaults. A smith.json at the repository root replaces them.`, 'muted small'));
  const more = element('details');
  more.append(element('summary', 'Show the default smith.json', 'small'), element('pre', detected.smithJson, 'small'));
  note.append(more);
  return note;
}

// pushSetup: { url, secret } from the response that turned Build on push on when Smith could not register the hook
// itself, shown once so the person can add it on GitHub (hookUrl gives the payload URL otherwise).
export function repoProjectCard(project, { element, badge, date, onBuild, onRescan, onShowJob, artifactsRow, onSync, onLink, jobState, onPush, pushSetup, hookUrl, onPushChoose, onReplaceQueued }) {
  // Folded, the card is one row: name, a summary line and, while something blocks it, that state's badge. A card that
  // needs a person starts open (until someone folds it), so the fix is in view.
  const state = project.scan.state !== 'ready' ? project.scan.state : copyProblem(project);
  const card = projectFold(project, { element, badge, status: state, line: projectLine(project), startOpen: Boolean(copyProblem(project)) || project.scan.state === 'error' });
  const via = project.scan.via === 'github' ? 'read via GitHub' : project.scan.via === 'smith' ? 'read by Smith' : project.scan.host ? `read on ${project.scan.host}` : '';
  card.append(element('p', `${shownRepoUrl(project)}\n${project.branch || 'default branch'} · ${project.commit ? project.commit.slice(0, 12) : 'not read yet'}${via ? ' · ' + via : ''}`, 'source'));
  // Smith's copy and Build on push fold into their own section; it starts open while either needs attention.
  const copy = copyOf(project);
  const section = fold(element, 'project-section', `smith.project.${project.id}.repository`, copyNeedsAttention(project));
  const sectionText = element('div'); sectionText.append(element('strong', 'Copy and push'), element('p', repositoryLine(project)));
  section.summary.append(sectionText, section.toggle);
  if (artifactsRow) section.details.append(artifactsRow(project));
  if (onSync && copy) section.details.append(upstreamRow(project, copy, { element, badge, date, onSync, onLink, onShowJob, jobState }));
  if (project.scan.state === 'ready') section.details.append(pushRow(project, { element, date, onPush, pushSetup, hookUrl, onPushChoose, onReplaceQueued }));
  card.append(section.details);
  if (project.scan.state !== 'ready') card.append(status(project, { element, badge, onShowJob }));
  // Machines that could not read the repository, whether a scan or a build is the one waiting.
  if ((project.access || []).length) {
    const denied = element('div', undefined, 'artifacts');
    denied.append(element('span', 'Machines that could not read this repository (they are skipped for an hour, or until Rescan):', 'message'));
    for (const denial of project.access) denied.append(element('span', `${denial.host}: ${denial.message} · ${date(denial.at)}`, 'muted small'));
    card.append(denied);
  }
  for (const warning of project.warnings || []) card.append(element('p', warning, 'muted small'));
  if (project.detected) card.append(detectedNote(project.detected, element));
  // One row per action, but a product with several variants (a Unity project's build profiles) is one
  // collapsible group, its variants listed under their platform; nothing is hidden, only folded.
  for (const group of groupActions(project.actions || [])) {
    if (group.actions.length === 1 && !group.actions[0].variant) { card.append(actionRow(group.actions[0], { element, onBuild })); continue; }
    card.append(productGroup(project, group, { element, onBuild }));
  }
  const skipped = [project.unusedRules ? `${project.unusedRules} rule${project.unusedRules === 1 ? '' : 's'} not used on ${project.branch || 'this branch'}` : '',
    project.disabledRules ? `${project.disabledRules} disabled` : ''].filter(Boolean);
  const foot = element('div', undefined, 'repo-foot');
  foot.append(element('span', [...skipped, 'Builds start from here or from a push; smith.json poll and schedule triggers are not run.'].join(' · '), 'muted small'));
  const rescan = element('button', 'Rescan', 'quiet');
  rescan.addEventListener('click', () => onRescan(rescan, project.id));
  foot.append(rescan); card.append(foot);
  return card;
}
// A <details> whose open state is remembered in this browser only, so the dashboard's refreshes keep it as it was;
// until someone opens or closes it, it starts as `startOpen` says.
export function fold(element, className, key, startOpen = false) {
  const details = element('details', undefined, className); const summary = element('summary'); details.append(summary);
  const toggle = element('span', 'Show', 'toggle');
  let saved = null;
  try { saved = localStorage.getItem(key); } catch { /* storage blocked: use the default */ }
  details.open = saved ? saved === 'open' : startOpen;
  if (details.open) toggle.textContent = 'Hide';
  // Opening it here queues one toggle event; that one is the default, not a choice to remember.
  let initial = details.open;
  details.addEventListener('toggle', () => {
    toggle.textContent = details.open ? 'Hide' : 'Show';
    if (initial) { initial = false; if (details.open) return; }
    try { localStorage.setItem(key, details.open ? 'open' : 'closed'); } catch { /* nothing to remember */ }
  });
  return { details, summary, toggle };
}
// The outer fold of any project card (prepared projects use it too): everything appended to it shows once it is open.
export function projectFold(project, { element, badge, status, line, startOpen = false }) {
  const { details, summary, toggle } = fold(element, 'project', `smith.project.${project.id}`, startOpen);
  details.dataset.projectId = project.id;
  const text = element('div', undefined, 'project-head');
  text.append(element('h3', project.name || project.id), element('p', line, 'muted small'));
  const right = element('span', undefined, 'project-state');
  if (status) right.append(badge(status));
  right.append(toggle);
  summary.append(text, right);
  return details;
}
// "owner/repo" from any Git URL form.
export function repoName(url) {
  const path = String(url || '').replace(/\.git$/, '').replace(/\/+$/, '').split(/[/:]/).filter(Boolean);
  return path.slice(-2).join('/');
}
// The folded card's one line: "Red-Marmoset/senet · main · 3 products, 24 builds · builds on push · Smith’s copy".
export function projectLine(project) {
  const actions = project.actions || []; const products = groupActions(actions).length;
  const builds = !actions.length ? (project.scan.state === 'ready' ? 'nothing to build' : '')
    : products === actions.length ? `${actions.length} build${actions.length === 1 ? '' : 's'}` : `${products} products, ${actions.length} builds`;
  const denied = (project.access || []).length;
  return [project.source === 'smith' ? 'started in Smith' : repoName(shownRepoUrl(project)), project.branch || 'default branch', builds, project.push?.enabled ? 'builds on push' : '',
    copyState(project), denied ? `${denied} machine${denied === 1 ? '' : 's'} can’t read it` : ''].filter(Boolean).join(' · ');
}
function copyState(project) {
  const hosted = project.hosted, artifacts = project.artifacts;
  if (copyOf(project) && hosted?.state === 'lost') return 'no machine keeps Smith’s copy';
  if (copyOf(project) && hosted?.state === 'degraded') return 'Smith’s copy restored behind its record';
  if (copyOf(project)) return linkedUrl(copyOf(project)) ? `Smith’s copy, linked to ${hostName(linkedUrl(copyOf(project)))}` : 'Smith’s copy';
  if (hosted?.status === 'copying' || ['pushing', 'verifying', 'copying'].includes(artifacts?.status)) return 'copying into Smith';
  if (hosted?.status === 'failed' || artifacts?.status === 'failed') return 'copy failed';
  return '';
}
// The badge for a copy that needs a person: '' when nothing does.
export function copyProblem(project) {
  if (copyOf(project) && ['lost', 'degraded'].includes(project.hosted?.state)) return project.hosted.state;
  if (project.hosted ? project.hosted.status === 'failed' : project.artifacts?.status === 'failed') return 'failed';
  return copyOf(project)?.sync?.status === 'failed' ? 'failed' : '';
}
// Smith's copy and Build on push start unfolded while a copy needs a person or a webhook waits to be added by hand.
function copyNeedsAttention(project) {
  return Boolean(copyProblem(project)) || Boolean(project.push?.enabled && project.push.via === 'manual');
}
function repositoryLine(project) {
  const copy = copyState(project) || 'not copied into Smith';
  const push = project.scan.state !== 'ready' ? '' : project.push?.enabled ? 'builds on push' : 'Build on push is off';
  return [copy, push].filter(Boolean).join(' · ');
}
// Build on push: what a push to the branch builds (smith.json webhook triggers), the switch, and the last delivery.
// Smith registers the hook on GitHub itself; only when it cannot does the row show the URL and secret to add by hand.
function pushRow(project, { element, date, onPush, pushSetup, hookUrl, onPushChoose, onReplaceQueued }) {
  const row = element('div', undefined, 'artifacts push-row');
  const onPushActions = project.onPush || [];
  const labels = onPushActions.map(id => (project.actions || []).find(item => item.id === id)?.label || id);
  const push = project.push;
  const enabled = Boolean(push?.enabled);
  const text = element('div');
  text.append(element('strong', enabled ? 'Builds on push' : 'Build on push is off'),
    element('p', onPushActions.length ? `A push to ${project.branch || 'the branch'} builds: ${labels.join(', ')}` : 'Nothing is chosen to build on a push yet: tick what should build below.', onPushActions.length ? '' : 'muted small'));
  if (onPushChoose) text.append(pushChooser(project, { element, onPushChoose }));
  text.append(replaceQueuedBox(project, { element, onReplaceQueued }));
  // Builds from Smith's copy: a push to the linked repository is pulled into the copy first; with nothing linked, a push to
  // the copy itself is the trigger.
  const copy = copyOf(project), source = copy ? linkedUrl(copy) : '';
  if (copy && onPushActions.length) text.append(element('p', source ? `Builds from Smith’s copy: a push to ${hostName(source)} is pulled into the copy, then built.` : 'Builds from Smith’s copy: a push to the copy builds it.', 'muted small'));
  if (push?.enabled && push.via === 'manual') {
    text.append(element('p', push.message || 'Add the webhook on GitHub by hand.', 'push-note small'));
    const setup = pushSetup && pushSetup.projectId === project.id ? pushSetup : null;
    if (setup) {
      const detail = element('p', undefined, 'small');
      detail.append('Payload URL: ', element('code', setup.url), element('br'), 'Content type: application/json · Events: just the push event', element('br'), 'Secret (shown once): ', element('code', setup.secret));
      text.append(detail);
    } else text.append(element('p', `Payload URL: ${hookUrl ? hookUrl(project.id) : ''}`, 'muted small'));
  }
  if (push?.lastDelivery) {
    const last = push.lastDelivery;
    text.append(element('p', `Last push: ${last.branch || '?'} ${last.commit ? last.commit.slice(0, 12) : ''} · ${last.outcome} · ${date(last.at)}`, 'muted small'));
  } else if (enabled) text.append(element('p', push.via === 'github' ? 'Webhook registered on GitHub; waiting for the first push.' : push.via === 'smith' ? 'No webhook needed; waiting for the first push.' : 'Waiting for the first push.', 'muted small'));
  const button = element('button', enabled ? 'Turn off' : 'Build on push', enabled ? 'quiet' : '');
  button.disabled = !onPushActions.length && !enabled;
  button.addEventListener('click', () => onPush(button, project.id, !enabled));
  row.append(text, button);
  return row;
}
// What a push builds, ticked on the card: every action this project can run, the chosen ones ticked. Until someone ticks,
// smith.json's webhook triggers decide (and are what is ticked); "Use smith.json" goes back to them.
function pushChooser(project, { element, onPushChoose }) {
  const chosen = new Set(project.onPush || []);
  const { details, summary, toggle } = fold(element, 'push-choice', `smith.project.${project.id}.push-choice`, !(project.onPush || []).length);
  summary.append(element('span', `Choose what a push builds${project.pushChosen ? ' (chosen here)' : (project.onPushDefault || []).length ? ' (from smith.json)' : ''}`, 'small'), toggle);
  const list = element('div', undefined, 'push-choice-list'); const boxes = [];
  for (const action of (project.actions || []).filter(a => a.available)) {
    const label = element('label', undefined, 'check small'); const box = element('input'); box.type = 'checkbox';
    box.checked = chosen.has(action.id); box.value = action.id; boxes.push(box);
    label.append(box, document.createTextNode(' ' + action.label + (action.variant ? ' · ' + action.variant : '')));
    list.append(label);
  }
  if (!boxes.length) list.append(element('span', 'This branch has no action that can run here.', 'muted small'));
  const save = () => onPushChoose(boxes, project.id, boxes.filter(b => b.checked).map(b => b.value));
  for (const box of boxes) box.addEventListener('change', save);
  details.append(list);
  if (project.pushChosen) {
    const reset = element('button', 'Use smith.json’s triggers', 'quiet');
    reset.addEventListener('click', () => onPushChoose([reset, ...boxes], project.id, null));
    details.append(reset);
  }
  return details;
}
// A burst of pushes builds the newest commit once: a new build replaces this project's waiting build of the same action on
// the same branch (never a running one). Until someone ticks or unticks it here, the workspace setting decides.
export function replaceQueuedBox(project, { element, onReplaceQueued }) {
  const label = element('label', undefined, 'check small replace-queued'); const box = element('input'); box.type = 'checkbox';
  box.checked = Boolean(project.replaceQueued); box.disabled = !onReplaceQueued;
  box.title = 'A new build of an action cancels the build of that action on this branch still waiting for a machine. Running builds are never cancelled.';
  label.append(box, document.createTextNode(` New build replaces a waiting build of the same action on ${project.branch || 'this branch'}${project.replaceQueuedChosen ? '' : ' (workspace default)'}`));
  if (onReplaceQueued) box.addEventListener('change', () => onReplaceQueued(box, project.id, box.checked));
  return label;
}
// Actions in smith.json order, grouped by product.
export function groupActions(actions) {
  const groups = new Map();
  for (const item of actions) {
    if (!groups.has(item.product)) groups.set(item.product, { product: item.product, actions: [] });
    groups.get(item.product).actions.push(item);
  }
  return [...groups.values()];
}
// Variants of one product split by the platform they build on (an action with several platforms, or none, lists under
// "Any platform"); platforms in the order smith.json names them.
export function byPlatform(actions) {
  const buckets = new Map();
  for (const item of actions) {
    const key = item.os.length === 1 ? item.os[0] : 'any';
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(item);
  }
  return [...buckets].map(([os, items]) => ({ os, title: os === 'any' ? 'Any platform' : PLATFORMS[os] || os, actions: items }));
}
function actionRow(item, { element, onBuild, title = item.label }) {
  const row = element('div', undefined, 'product'); const text = element('div');
  text.append(element('strong', title), element('p', [item.os.map(os => PLATFORMS[os] || os).join(', '), ...item.notes].filter(Boolean).join(' · ')));
  const button = element('button', 'Build'); button.disabled = !item.available;
  if (item.available) button.addEventListener('click', () => onBuild(button, item.id));
  row.append(text, button); return row;
}
function productGroup(project, group, { element, onBuild }) {
  const { details, summary, toggle } = fold(element, 'product-group', `smith.group.${project.id}.${group.product}`);
  const available = group.actions.filter(item => item.available).length; const platforms = byPlatform(group.actions);
  const line = [`${group.actions.length} variants`, platforms.map(bucket => `${bucket.actions.length} ${bucket.title}`).join(', '),
    available < group.actions.length ? `${group.actions.length - available} not buildable here` : ''].filter(Boolean).join(' · ');
  const text = element('div'); text.append(element('strong', group.product), element('p', line));
  summary.append(text, toggle);
  for (const bucket of platforms) {
    const section = element('div', undefined, 'platform');
    section.append(element('h4', bucket.title));
    for (const item of bucket.actions) section.append(actionRow(item, { element, onBuild, title: item.variant || item.label }));
    details.append(section);
  }
  return details;
}

// Pull from / Push to the linked repository, Detach from it, or link one. Pushes are never forced, so
// nothing on either side is overwritten; Detach keeps Smith's copy and every build as they are.
function upstreamRow(project, copy, { element, badge, date, onSync, onLink, onShowJob, jobState }) {
  const block = element('div', undefined, 'upstream');
  const upstream = linkedUrl(copy); const sync = copy.sync;
  const running = sync?.status === 'running'; const branch = project.branch || 'the branch';
  const row = element('div', undefined, 'artifacts');
  const button = (label, className, title, onClick) => {
    const item = element('button', label, className); item.title = title; item.setAttribute('aria-description', title);
    item.disabled = running; item.addEventListener('click', () => onClick(item)); return item;
  };
  if (upstream) {
    const host = hostName(upstream);
    row.append(element('span', `Linked to ${host}.`, 'message'),
      button(`Pull from ${host}`, 'quiet', `Bring ${host}’s ${branch} into Smith’s copy. If Smith’s copy has commits ${host} lacks, it stops and says so.`, item => onSync(item, 'pull')),
      button(`Push to ${host}`, 'quiet', `Send Smith’s ${branch} to ${host} with a connected machine’s own Git login. Never forced.`, item => onSync(item, 'push')),
      button('Detach', 'quiet', `Stop syncing with ${host}. Smith keeps its copy and builds keep working; nothing on ${host} changes.`, item => {
        const last = sync && sync.status === 'done' ? ` The last ${sync.direction} was ${date(sync.at)}${sync.commit ? ` (${sync.commit.slice(0, 12)})` : ''}.` : ' Nothing has been pulled or pushed since the copy was made.';
        if (confirm(`Detach ${project.name || project.id} from ${upstream}?\n\nSmith keeps its copy and builds keep working. Nothing on ${host} is changed or deleted, but commits made there from now on stay there.${last}`)) onLink(item, '');
      }));
    block.append(row);
  } else {
    row.append(element('span', copy.detachedFrom ? `Lives only in Smith (detached from ${copy.detachedFrom}).` : 'Lives only in Smith: not linked to another Git host.', 'message'));
    const form = element('form', undefined, 'link-form'); form.hidden = true;
    const input = element('input'); input.type = 'text'; input.required = true; input.value = copy.detachedFrom || '';
    input.placeholder = 'https://github.com/owner/repo.git'; input.setAttribute('aria-label', 'Repository to link');
    const submit = element('button', 'Link'); submit.type = 'submit';
    const cancel = element('button', 'Cancel', 'quiet'); cancel.type = 'button';
    form.append(input, submit, cancel);
    const open = button(copy.detachedFrom ? 'Link again' : 'Link a repository', 'quiet', 'Link a GitHub (or other Git) repository to pull from and push to.', () => { form.hidden = false; open.hidden = true; input.focus(); });
    cancel.addEventListener('click', () => { form.hidden = true; open.hidden = false; });
    form.addEventListener('submit', event => { event.preventDefault(); onLink(submit, input.value.trim()); });
    row.append(open); block.append(row, form);
  }
  if (sync) {
    const state = running ? (jobState?.(sync.jobId) === 'queued' ? 'queued' : 'running') : sync.status;
    const host = hostName(upstream || copy.detachedFrom || '');
    const verb = sync.direction === 'pull' ? `Pull from ${host}` : `Push to ${host}`;
    const text = state === 'queued' ? `${verb}: waiting for a connected machine running the latest Smith agent.`
      : state === 'running' ? `${sync.direction === 'pull' ? 'Pulling from' : 'Pushing to'} ${host}…`
      : sync.status === 'done' ? `${sync.direction === 'pull' ? 'Pulled' : 'Pushed'}${sync.commit ? ' ' + sync.commit.slice(0, 12) : ''} ${sync.direction === 'pull' ? 'from' : 'to'} ${host} · ${date(sync.at)}`
      : `${verb} failed: ${sync.message || 'see the output'}`;
    const line = element('div', undefined, 'artifacts');
    line.append(badge(state), element('span', text, 'message'));
    const output = element('button', 'Show output', 'build-link');
    output.addEventListener('click', () => onShowJob(output, sync.jobId));
    line.append(output); block.append(line);
  }
  return block;
}
function status(project, { element, badge, onShowJob }) {
  const row = element('div', undefined, 'artifacts');
  row.append(badge(project.scan.state), element('span', project.scan.message || '', 'message'));
  if (project.scan.state === 'waiting') row.append(element('span', 'Its build actions (from smith.json) appear once a machine has read it.', 'muted small'));
  if (project.scan.jobId) {
    const open = element('button', 'Show output', 'build-link');
    open.addEventListener('click', () => onShowJob(open, project.scan.jobId));
    row.append(open);
  }
  return row;
}
